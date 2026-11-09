import type { FastifyInstance } from 'fastify';
import type { LocalTranscriberPort } from '../../ports/local-transcriber.js';

/** launchd is asked at most this often, however many jobs arrive meanwhile. */
export const WAKE_COOLDOWN_MS = 60_000;

/** What one check did (for the log and the tests). */
export type WakeOutcome =
  | 'not-local'
  | 'nothing-waiting'
  | 'online'
  | 'cooling-down'
  | 'woken'
  | 'failed';

export interface TranscriberWakerDeps {
  /** The transcriber's LaunchAgent on this Mac; null in production (the API is on the VM). */
  readonly local: LocalTranscriberPort | null;
  /** Jobs only the Mac's transcriber takes, waiting for one now. */
  readonly waiting: () => number;
  /** Whether a transcriber is on (it said so lately, or was just seen). */
  readonly isOnline: () => boolean;
  readonly onWoken?: (detail: string) => void;
  readonly onError?: (err: unknown) => void;
  readonly now?: () => Date;
}

/**
 * The owner never starts the transcriber by hand (KBC-114 AC-15, his words: "ao enviar um
 * audio ele deve ligar"): whenever a job for the Mac waits — an upload, a stage that queued
 * the next, a retry, a publication, or one found at start — and no transcriber is on, an
 * API on the same Mac starts its LaunchAgent (`launchctl kickstart`, never `-k`: a running
 * job is never killed). In production there is nothing to start: the app says it is off.
 */
export class TranscriberWaker {
  private lastWake = Number.NEGATIVE_INFINITY;
  private readonly now: () => Date;

  constructor(private readonly deps: TranscriberWakerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async check(): Promise<WakeOutcome> {
    const local = this.deps.local;
    if (!local) return 'not-local';
    if (this.deps.waiting() === 0) return 'nothing-waiting';
    if (this.deps.isOnline()) return 'online';
    const at = this.now().getTime();
    if (at - this.lastWake < WAKE_COOLDOWN_MS) return 'cooling-down';
    this.lastWake = at;
    try {
      const done = await local.wake();
      if (!done.ok) throw new Error(done.detail);
      this.deps.onWoken?.(done.detail);
      return 'woken';
    } catch (err) {
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
