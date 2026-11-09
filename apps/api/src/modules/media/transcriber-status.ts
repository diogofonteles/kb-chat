import {
  TRANSCRIBER_SERVICE_LABEL,
  TRANSCRIBER_STATUS_STALE_MS,
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
  readonly now?: () => Date;
}

/** Where the vault goes in the install command when no transcriber said where it is. */
const VAULT_PLACEHOLDER = '<pasta do vault do kb>';

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
    };
  }

  private itemOf(transcriber: Transcriber): TranscriberStatusItem {
    const report = this.reports.get(transcriber.id) ?? null;
    return {
      id: transcriber.id,
      name: transcriber.name,
      kinds: transcriber.kinds,
      lastSeenAt: transcriber.lastSeenAt,
      state: report && this.isFresh(report) ? report.state : 'offline',
      report,
    };
  }

  private isFresh(report: Received): boolean {
    const age = this.now().getTime() - Date.parse(report.receivedAt);
    return age <= TRANSCRIBER_STATUS_STALE_MS;
  }

  /** The commands that turn it on, with the vault a transcriber last said it uses. */
  private startOf(): TranscriberStatusOverview['start'] {
    const vault =
      [...this.reports.values()]
        .filter((one) => one.vaultPath !== null)
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))[0]
        ?.vaultPath ?? VAULT_PLACEHOLDER;
    return {
      label: TRANSCRIBER_SERVICE_LABEL,
      installCommand: `uv run --project tools/transcriber transcriber service install --vault ${quoted(vault)}`,
      startCommand: `launchctl kickstart -k gui/$(id -u)/${TRANSCRIBER_SERVICE_LABEL}`,
      canStartHere: this.deps.canStartHere,
    };
  }
}

/** A path as a shell argument: single quotes when it has anything but plain characters. */
const quoted = (path: string): string =>
  /^[\w@%+=:,./~-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`;
