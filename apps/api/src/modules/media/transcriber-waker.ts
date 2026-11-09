import type { BlockedReason, MediaJobKind } from '@kb-chat/contracts';
import type { TranscriberBacklog } from '../../ports/media-store.js';
import type { FastifyInstance } from 'fastify';
import type { LocalTranscriberPort } from '../../ports/local-transcriber.js';

/** launchd is asked at most this often, however many jobs arrive meanwhile. */
export const WAKE_COOLDOWN_MS = 60_000;

/** Launches in a row that did not move the queue: then it waits for something new. */
export const MAX_FRUITLESS_WAKES = 3;

/** What one check did (for the log and the tests). */
export type WakeOutcome =
  | 'not-local'
  | 'nothing-waiting'
  | 'online'
  | 'stuck'
  | 'cooling-down'
  | 'woken'
  | 'failed';

/** How many jobs of a kind the Mac could lease now (the lease's own predicate). */
export type ReadyJobs = TranscriberBacklog;

/** Jobs that wait and why no transcriber takes them (review r2 S-2, N-2). */
export interface BlockedJobs extends ReadyJobs {
  readonly reason: BlockedReason;
}

/** Why work waits with the transcriber off, for the app to say (review BR-15, QA F-1). */
export interface WakeAttention {
  readonly blocked: readonly BlockedJobs[];
  /** Started for these and took none, or launchctl could not start it (QA r2). */
  readonly stuck: {
    readonly ready: number;
    readonly reason: 'took-nothing' | 'start-failed';
    readonly detail: string | null;
  } | null;
}

export interface TranscriberWakerDeps {
  /** The transcriber's LaunchAgent on this Mac; null in production (the API is on the VM). */
  readonly local: LocalTranscriberPort | null;
  /** Jobs only the Mac takes, leasable now, by kind (kb-publish included). */
  readonly backlog: () => readonly ReadyJobs[];
  /** Why no paired transcriber takes this kind now; null when one does. */
  readonly whyNot: (kind: MediaJobKind) => BlockedReason | null;
  /** Work held back by the media monthly ceiling (no lease would give it out). */
  readonly capped: () => readonly ReadyJobs[];
  /** Whether a transcriber is on (it said so lately, or was just seen). */
  readonly isOnline: () => boolean;
  /** Whether a transcriber said it stopped at or after this moment. */
  readonly stoppedSince: (at: Date) => boolean;
  readonly onWoken?: (detail: string) => void;
  readonly onError?: (err: unknown) => void;
  readonly now?: () => Date;
}

/**
 * The owner never starts the transcriber by hand (KBC-114 AC-15, his words: "ao enviar um
 * audio ele deve ligar"), and it runs only when there is something for it ("ligado quando
 * realmente tiver necessidade de uso e desligado logo em seguida"). Whenever a job a paired
 * transcriber can take waits — an upload, a stage that queued the next, a retry, a
 * publication, or one found at start — and none is on, an API on the same Mac starts its
 * LaunchAgent (`launchctl kickstart`, never `-k`: a running job is never killed). A job no
 * transcriber takes never starts it; a launch that took nothing, with the queue unchanged,
 * is not repeated until the queue changes, and the app says why the work waits.
 */
export class TranscriberWaker {
  private lastWake = Number.NEGATIVE_INFINITY;
  /** The leasable count at the last launch, while launches have not moved the queue. */
  private wokeWith: number | null = null;
  private wokeAt: Date | null = null;
  private fruitless = 0;
  private stuckWith: number | null = null;
  /** Why the last launch failed (launchctl's words); null after one that worked. */
  private failure: string | null = null;
  private readonly now: () => Date;

  constructor(private readonly deps: TranscriberWakerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** What waits that the transcriber will not do by itself, for the app to say. */
  attention(): WakeAttention {
    const blocked: BlockedJobs[] = [];
    for (const one of this.deps.backlog()) {
      const reason = one.ready > 0 ? this.deps.whyNot(one.kind) : null;
      if (reason) blocked.push({ ...one, reason });
    }
    for (const one of this.deps.capped())
      if (one.ready > 0) blocked.push({ ...one, reason: 'monthly-cap' });
    return { blocked, stuck: this.stuck() };
  }

  /** When it last started the transcriber (S-1: a restart must not cut that start short). */
  lastStartedAt(): Date | null {
    return this.wokeAt;
  }

  private stuck(): WakeAttention['stuck'] {
    const ready = this.wokeWith ?? 0;
    if (this.failure !== null && ready > 0)
      return { ready, reason: 'start-failed', detail: this.failure };
    if (this.stuckWith === null) return null;
    return { ready: this.stuckWith, reason: 'took-nothing', detail: null };
  }

  async check(): Promise<WakeOutcome> {
    const local = this.deps.local;
    if (!local) return 'not-local';
    const leasable = this.leasable();
    if (leasable === 0) {
      this.forget();
      return 'nothing-waiting';
    }
    if (this.deps.isOnline()) return 'online';
    if (this.isStuck(leasable)) return 'stuck';
    const at = this.now();
    if (at.getTime() - this.lastWake < WAKE_COOLDOWN_MS) return 'cooling-down';
    return this.wake(local, { at, leasable });
  }

  private leasable(): number {
    return this.deps
      .backlog()
      .filter((one) => this.deps.whyNot(one.kind) === null)
      .reduce((sum, one) => sum + one.ready, 0);
  }

  /** A launch that took nothing is not repeated until the queue changes. */
  private isStuck(leasable: number): boolean {
    if (this.wokeWith !== leasable) {
      this.forget();
      return false;
    }
    const tookNothing =
      this.wokeAt !== null && this.deps.stoppedSince(this.wokeAt);
    if (tookNothing || this.fruitless >= MAX_FRUITLESS_WAKES) {
      this.stuckWith = leasable;
      return true;
    }
    return false;
  }

  private forget(): void {
    this.wokeWith = null;
    this.fruitless = 0;
    this.stuckWith = null;
    this.failure = null;
  }

  private async wake(
    local: LocalTranscriberPort,
    { at, leasable }: { at: Date; leasable: number },
  ): Promise<WakeOutcome> {
    this.lastWake = at.getTime();
    this.wokeAt = at;
    this.wokeWith = leasable;
    this.fruitless += 1;
    try {
      const done = await local.wake();
      if (!done.ok) throw new Error(done.detail);
      this.failure = null;
      this.deps.onWoken?.(done.detail);
      return 'woken';
    } catch (err) {
      this.failure =
        err instanceof Error ? err.message.slice(0, 500) : String(err);
      this.deps.onError?.(err);
      return 'failed';
    }
  }
}

/** How often a waiting job with no transcriber on is looked for (startup included). */
export const WAKE_CHECK_MS = 15_000;

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Looks for work the Mac must do at startup, every WAKE_CHECK_MS and right after any media
 * request that may have queued some (an upload, a stage done, a retry, a publication): the
 * job-enqueue points all answer through these routes, and the sweep catches the rest.
 */
export function watchForTranscriberWork(
  app: FastifyInstance,
  waker: TranscriberWaker,
  intervalMs = WAKE_CHECK_MS,
): void {
  const check = () => void waker.check();
  const timer = setInterval(check, intervalMs);
  timer.unref();
  app.addHook('onReady', async () => {
    check();
  });
  app.addHook('onResponse', async (request, reply) => {
    if (
      MUTATING.has(request.method) &&
      request.url.startsWith('/api/v1/media') &&
      reply.statusCode < 400
    )
      check();
  });
  app.addHook('preClose', async () => clearInterval(timer));
}
