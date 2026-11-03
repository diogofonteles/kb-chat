import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  TRANSCRIBER_ONLINE_MS,
  type MediaJobKind,
  type PairedTranscriber,
  type Transcriber,
  type TranscriberPresence,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import {
  leaseNameOf,
  type TranscriberRecord,
  type TranscriberStorePort,
} from '../../ports/transcriber-store.js';

/** What a worker token may do: the job kinds it leases and the name its leases carry. */
export interface WorkerIdentity {
  /** Fixed by the token (a paired transcriber); null lets the VM worker name itself. */
  readonly leaseName: string | null;
  readonly kinds: readonly MediaJobKind[];
}

/** Whether a transcriber can pick a job up now (FR-1). */
export interface Presence {
  readonly transcriber: TranscriberPresence;
  readonly offSince: string | null;
}

export interface TranscriberServiceDeps {
  readonly store: TranscriberStorePort;
  /** Keys the token hash (KB_CHAT_SECRETS_KEY): a copied database alone checks nothing. */
  readonly tokenKey: Buffer;
  /** The VM media worker's token (KB_CHAT_MEDIA_WORKER_TOKEN): conversions only. */
  readonly vmToken: string;
  readonly now?: () => Date;
}

/** Transcribers lease transcriptions only (ADR 0023 §2); the VM converts only. */
const TRANSCRIBER_KINDS: readonly MediaJobKind[] = ['transcribe'];
const VM_WORKER: WorkerIdentity = { leaseName: null, kinds: ['transcode'] };
const TOKEN_PREFIX = 'nat_';
/** At most one "seen" write per transcriber in this window. */
const TOUCH_EVERY_MS = 10_000;

const digest = (value: string) => createHash('sha256').update(value).digest();
const isSame = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

/**
 * "Transcritores" (KBC-036 FR-5, BR-1, BR-2): masters pair a worker and see its token once;
 * every worker request is identified by its token, the VM's or a paired transcriber's.
 */
export class TranscriberService {
  private readonly now: () => Date;
  private readonly lastTouch = new Map<string, number>();

  constructor(private readonly deps: TranscriberServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  pair(input: { name: string; pairedBy: string }): PairedTranscriber {
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const record = this.deps.store.pair({
      id: randomUUID(),
      name: input.name,
      kinds: TRANSCRIBER_KINDS,
      tokenHash: this.hashOf(token),
      createdBy: input.pairedBy,
      now: this.now(),
    });
    return { transcriber: this.toTranscriber(record), token };
  }

  list(): Transcriber[] {
    return this.deps.store.list().map((record) => this.toTranscriber(record));
  }

  revoke(id: string): void {
    if (!this.deps.store.revoke({ id, now: this.now() }))
      throw new AppError('NOT_FOUND', 'Unknown transcriber');
  }

  /** Who a bearer token is; null for an unknown or revoked one (401, FR-6). */
  identify(token: string): WorkerIdentity | null {
    if (token.length === 0) return null;
    if (isSame(token, this.deps.vmToken)) return VM_WORKER;
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    const record = this.deps.store.byTokenHash(this.hashOf(token));
    if (!record) return null;
    this.seen(record.id);
    return { leaseName: leaseNameOf(record.id), kinds: record.kinds };
  }

  /**
   * "On" when one was seen within the hour; otherwise "off" since the last time any was
   * seen (or paired, when none ever was); "none" when none is paired.
   */
  presence(): Presence {
    const records = this.deps.store.list();
    if (records.length === 0) return { transcriber: 'none', offSince: null };
    const latest = records
      .map((record) => record.lastSeenAt ?? record.createdAt)
      .sort()
      .at(-1);
    const seen = records.some((record) => this.isOnline(record));
    return seen || latest === undefined
      ? { transcriber: 'on', offSince: null }
      : { transcriber: 'off', offSince: latest };
  }

  private seen(id: string): void {
    const now = this.now();
    if (now.getTime() - (this.lastTouch.get(id) ?? 0) < TOUCH_EVERY_MS) return;
    this.lastTouch.set(id, now.getTime());
    this.deps.store.touch({ id, now });
  }

  private hashOf(token: string): string {
    return createHmac('sha256', this.deps.tokenKey)
      .update(`transcriber-token:${token}`)
      .digest('base64url');
  }

  private isOnline(record: TranscriberRecord): boolean {
    if (!record.lastSeenAt) return false;
    const age = this.now().getTime() - Date.parse(record.lastSeenAt);
    return age <= TRANSCRIBER_ONLINE_MS;
  }

  private toTranscriber(record: TranscriberRecord): Transcriber {
    return {
      ...record,
      kinds: [...record.kinds],
      online: this.isOnline(record),
    };
  }
}
