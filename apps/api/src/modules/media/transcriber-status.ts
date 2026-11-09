import {
  TRANSCRIBER_SERVICE_LABEL,
  TRANSCRIBER_STATUS_STALE_MS,
  type MediaJobKind,
  type Transcriber,
  type TranscriberStatusItem,
  type TranscriberStatusOverview,
  type TranscriberStatusReport,
} from '@kb-chat/contracts';

export interface TranscriberStatusDeps {
  /** The paired transcribers, not revoked. */
  readonly transcribers: { list(): Transcriber[] };
  /** Track documents waiting for the Mac (KBC-100's queue). */
  readonly kbWaiting: () => number;
  /** Whether this API runs on the transcriber's Mac (KB_CHAT_LOCAL_TRANSCRIBER=1). */
  readonly canStartHere: boolean;
  /** Why work waits with it off (the waker's view, QA F-1). */
  readonly attention?: () => TranscriberStatusOverview['attention'];
  readonly now?: () => Date;
}

const NO_ATTENTION: TranscriberStatusOverview['attention'] = {
  blocked: [],
  stuck: null,
};

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
    this.reports.set(transcriberId, {
      ...report,
      receivedAt: this.now().toISOString(),
    });
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
      attention: this.deps.attention?.() ?? NO_ATTENTION,
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
   * The kinds some paired transcriber takes: marked in Transcritores and, once it said what
   * it runs with (an extra that did not install, a Mac without a vault), only those.
   */
  takers(): ReadonlySet<MediaJobKind> {
    const kinds = new Set<MediaJobKind>();
    for (const one of this.deps.transcribers.list()) {
      const runs = this.reports.get(one.id)?.kinds;
      for (const kind of one.kinds)
        if (!runs || runs.includes(kind)) kinds.add(kind);
    }
    return kinds;
  }

  /** Whether a transcriber said it stopped at or after this moment. */
  stoppedSince(at: Date): boolean {
    return [...this.reports.values()].some(
      (one) =>
        one.state === 'stopped' && Date.parse(one.receivedAt) >= at.getTime(),
    );
  }
}

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
