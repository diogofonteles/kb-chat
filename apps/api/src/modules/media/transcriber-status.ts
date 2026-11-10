import {
  TRANSCRIBER_SERVICE_LABEL,
  TRANSCRIBER_STATUS_STALE_MS,
  type BlockedReason,
  type MediaJobKind,
  type Transcriber,
  type TranscriberStatusItem,
  type TranscriberStatusOverview,
  type TranscriberStatusReport,
} from '@kb-chat/contracts';
import type { WakeAttention } from './transcriber-waker.js';

export interface TranscriberStatusDeps {
  /** The paired transcribers, not revoked. */
  readonly transcribers: { list(): Transcriber[] };
  /** Track documents waiting for the Mac (KBC-100's queue). */
  readonly kbWaiting: () => number;
  /** Whether this API runs on the transcriber's Mac (KB_CHAT_LOCAL_TRANSCRIBER=1). */
  readonly canStartHere: boolean;
  /**
   * A transcriber said it can publish now, after not saying so (KBC-117): what died of its
   * missing setup goes back to the queue.
   */
  readonly onKbReady?: () => void;
  /** Why work waits with it off (the waker's view, QA F-1); null before the waker runs. */
  readonly attention?: () => WakeAttention | null;
  readonly now?: () => Date;
}

/** The waker's view as the contract carries it. */
const attentionOf = (
  seen: WakeAttention | null,
): TranscriberStatusOverview['attention'] => ({
  blocked: [...(seen?.blocked ?? [])],
  stuck: seen?.stuck ?? null,
});

type Received = TranscriberStatusReport & { readonly receivedAt: string };

/**
 * The transcribers' own status (KBC-114 FR-8, BR-9): each sends what it does every 30 s and
 * at each change; the last one is kept in memory, by transcriber (a restart refills it within
 * 30 s). Without one for TRANSCRIBER_STATUS_STALE_MS, a transcriber is shown as off.
 */
export class TranscriberStatusBoard {
  private readonly reports = new Map<string, Received>();
  private readonly now: () => Date;

  constructor(private readonly deps: TranscriberStatusDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  record(transcriberId: string, report: TranscriberStatusReport): void {
    const before = this.reports.get(transcriberId);
    this.reports.set(transcriberId, {
      ...report,
      receivedAt: this.now().toISOString(),
    });
    if (publishes(report) && !(before && publishes(before)))
      this.deps.onKbReady?.();
  }

  overview(): TranscriberStatusOverview {
    const paired = this.deps.transcribers.list();
    const known = new Set(paired.map((one) => one.id));
    // A revoked transcriber's last word goes with it.
    for (const id of this.reports.keys())
      if (!known.has(id)) this.reports.delete(id);
    return {
      items: paired.map((one) => this.itemOf(one)),
      kbQueue: { waiting: this.deps.kbWaiting() },
      start: this.startOf(),
      attention: attentionOf(this.deps.attention?.() ?? null),
    };
  }

  /** A transcriber is on: it sent its status lately, or was just seen (an older worker). */
  anyOnline(): boolean {
    const at = this.now().getTime();
    const fresh = (iso: string | null | undefined) =>
      iso != null && at - Date.parse(iso) <= TRANSCRIBER_STATUS_STALE_MS;
    return this.deps.transcribers.list().some((one) => {
      const report = this.reports.get(one.id);
      // What it said last decides: "stopped" is off even though it was just seen.
      if (report && fresh(report.receivedAt)) return report.state !== 'stopped';
      return fresh(one.lastSeenAt);
    });
  }

  private itemOf(transcriber: Transcriber): TranscriberStatusItem {
    const report = withTitle(this.reports.get(transcriber.id), transcriber);
    return {
      id: transcriber.id,
      name: transcriber.name,
      kinds: transcriber.kinds,
      lastSeenAt: transcriber.lastSeenAt,
      state:
        report && this.isFresh(report) && report.state !== 'stopped'
          ? report.state
          : 'offline',
      report,
    };
  }

  private isFresh(report: Received): boolean {
    const age = this.now().getTime() - Date.parse(report.receivedAt);
    return age <= TRANSCRIBER_STATUS_STALE_MS;
  }

  /** How it is turned on; never a uv command (the owner, AC-17). */
  private startOf(): TranscriberStatusOverview['start'] {
    return {
      label: TRANSCRIBER_SERVICE_LABEL,
      startCommand: `launchctl kickstart gui/$(id -u)/${TRANSCRIBER_SERVICE_LABEL}`,
      canStartHere: this.deps.canStartHere,
    };
  }

  /**
   * Why no paired transcriber takes this kind now, or null when one does: none is paired,
   * none is marked for it, or the marked one said it runs without it (an extra that did not
   * load, a Mac without a vault). A report with no kinds is one still preparing: unknown, so
   * it restricts nothing (review r2 N-1).
   */
  whyNot(kind: MediaJobKind): BlockedReason | null {
    const paired = this.deps.transcribers.list();
    if (paired.length === 0) return 'none-paired';
    const marked = paired.filter((one) => one.kinds.includes(kind));
    if (marked.length === 0) return 'not-marked';
    const runs = (one: Transcriber) => {
      const kinds = this.reports.get(one.id)?.kinds;
      return !kinds?.length || kinds.includes(kind);
    };
    if (marked.some(runs)) return null;
    // What the Mac said it lacks (KBC-117), before the generic "did not load".
    const said = marked
      .flatMap((one) => this.reports.get(one.id)?.unavailable ?? [])
      .find((one) => one.kind === kind);
    return said?.reason ?? 'not-installed';
  }

  /** Whether a transcriber said anything at or after this moment. */
  saidSince(at: Date): boolean {
    return [...this.reports.values()].some(
      (one) => Date.parse(one.receivedAt) >= at.getTime(),
    );
  }

  /** Whether a transcriber said it stopped at or after this moment. */
  stoppedSince(at: Date): boolean {
    return [...this.reports.values()].some(
      (one) =>
        one.state === 'stopped' && Date.parse(one.receivedAt) >= at.getTime(),
    );
  }
}

/** It says it publishes now: kb-publish among its kinds, and nothing missing for it. */
const publishes = (report: TranscriberStatusReport): boolean =>
  report.kinds.includes('kb-publish') &&
  !(report.unavailable ?? []).some((one) => one.kind === 'kb-publish');

/**
 * The lease of a transcription carries no title, so the worker names the job by its media;
 * the API knows which item the transcriber holds and names it by its title.
 */
function withTitle(
  report: Received | undefined,
  transcriber: Transcriber,
): Received | null {
  if (!report) return null;
  const job = report.currentJob;
  const held = transcriber.currentJob;
  if (!job || !held || held.kind !== job.kind) return report;
  return { ...report, currentJob: { ...job, label: held.title } };
}
