import { randomUUID } from 'node:crypto';
import {
  GROQ_IDLE_HOURS,
  GROQ_MIN_BILLED_MS,
  GROQ_USD_PER_HOUR,
  groqModeSchema,
  type GroqChunkQuery,
  type GroqModeRequest,
  type GroqSettings,
  type GroqTestResult,
  type RawChunkResult,
} from '@kb-chat/contracts';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import { startOfAppMonth } from '../../app-calendar.js';
import type { GroqPort } from '../../ports/groq.js';
import type {
  GroqQueuePort,
  WaitingTranscription,
} from '../../ports/groq-queue.js';
import type { MediaSettingsPort } from '../../ports/media-settings.js';
import type { MediaSpendLedgerPort } from '../../ports/media-spend-ledger.js';
import type { LeaseOwner } from '../../ports/media-store.js';
import type { SecretSealerPort } from '../../ports/secret-sealer.js';
import type { TranscriptStorePort } from '../../ports/transcript-store.js';
import { chunkResultOf } from './groq-result.js';
import { monthlyCapOf, saveMonthlyCap } from './media-cap.js';
import type { GroqPacer } from './groq-pacer.js';
import type { Presence } from './transcriber-service.js';
import { promptOf } from './whisper-tokens.js';

const GROQ_SETTING = 'groq';
/** Bound to the sealed key (ADR 0017): copied to another row, it does not open. */
const KEY_CONTEXT = 'media:groq-key';
const HOUR_MS = 3_600_000;
/** A chunk a little over 28 s is the worker's rounding; anything longer is refused. */
const CHUNK_SLACK_MS = 2_000;
const MAX_CHUNK_MS = 28_000 + CHUNK_SLACK_MS;

const storedGroqSchema = z.object({
  mode: groqModeSchema,
  idleHours: z.number().int().min(1).max(168),
  sealedKey: z.string().nullable(),
});
type StoredGroq = z.infer<typeof storedGroqSchema>;

const DEFAULT_GROQ: StoredGroq = {
  mode: 'never',
  idleHours: GROQ_IDLE_HOURS.default,
  sealedKey: null,
};

/** What a request costs (BR-2): US$ 0.04 an hour, 10 s at least. */
export const groqUsdOf = (audioMs: number): number =>
  (Math.max(audioMs, GROQ_MIN_BILLED_MS) / HOUR_MS) * GROQ_USD_PER_HOUR;

/** What a chunk turned into: Groq's words, or how long the worker waits first. */
export type ChunkOutcome =
  | { readonly kind: 'ok'; readonly result: RawChunkResult }
  | { readonly kind: 'wait'; readonly retryAfterMs: number };

export interface GroqServiceDeps {
  readonly settings: MediaSettingsPort;
  readonly sealer: SecretSealerPort;
  readonly groq: GroqPort;
  readonly ledger: MediaSpendLedgerPort;
  readonly queue: GroqQueuePort;
  readonly transcripts: Pick<TranscriptStorePort, 'termsAt'>;
  /** Whether a paired transcriber that transcribes was seen lately (FR-2). */
  readonly presence: () => Presence;
  readonly pacer: GroqPacer;
  /** MEDIA_MONTHLY_CAP_USD: the cap until the owner sets one (BR-2). */
  readonly defaultCapUsd: number;
  readonly log: FastifyBaseLogger;
  readonly now?: () => Date;
}

const leaseLost = () =>
  new AppError('MEDIA_CONFLICT', 'This lease is no longer yours');
const unavailable = () =>
  new AppError('GROQ_UNAVAILABLE', 'Groq is off or has no key');
const capReached = () =>
  new AppError('MEDIA_SPEND_CAP', 'The media monthly cap would be crossed', {
    details: { reason: 'monthly-cap' },
  });

/**
 * Groq as the transcription fallback (KBC-037, ADR 0023 §7): never on by default (BR-1),
 * every request reserved against the media monthly cap before it leaves (BR-2), the key
 * sealed and never sent back (BR-3). The API calls Groq; the VM worker cuts the audio.
 */
export class GroqService {
  private readonly now: () => Date;

  constructor(private readonly deps: GroqServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** The screen's view (FR-5); the key itself never (BR-3). */
  view(isOwner: boolean): GroqSettings {
    const stored = this.stored();
    return {
      connected: stored.sealedKey !== null,
      mode: stored.mode,
      idleHours: stored.idleHours,
      month: {
        spentUsd: this.deps.ledger.usedSince(startOfAppMonth(this.now())),
        capUsd: this.capUsd(),
      },
      canEditCap: isOwner,
    };
  }

  /** Groq may take a transcription now: on, with a key (BR-1). */
  ready(): boolean {
    const stored = this.stored();
    return stored.mode !== 'never' && stored.sealedKey !== null;
  }

  /** The media monthly cap: the owner's, or the configured default (BR-2). */
  capUsd(): number {
    return monthlyCapOf(this.deps.settings, this.deps.defaultCapUsd);
  }

  setCap(capUsd: number, by: string): void {
    saveMonthlyCap(this.deps.settings, { usd: capUsd, by, now: this.now() });
  }

  /**
   * "Testar conexão" (FR-1): a pasted key is kept, sealed, only when Groq accepts it; with
   * none, the stored one is checked. The key never reaches a log or an answer (BR-3).
   */
  async test(
    input: { readonly key?: string; readonly by: string },
    isOwner: boolean,
  ): Promise<GroqTestResult> {
    const key = input.key ?? this.storedKey();
    if (key === null) return { ok: false, reason: 'no-key' };
    const check = await this.deps.groq.checkKey(key);
    if (check !== 'ok') return { ok: false, reason: check };
    if (input.key !== undefined)
      this.save(
        {
          ...this.stored(),
          sealedKey: this.deps.sealer.seal(key, KEY_CONTEXT),
        },
        input.by,
      );
    return { ok: true, settings: this.view(isOwner) };
  }

  removeKey(by: string): void {
    this.save({ ...this.stored(), sealedKey: null }, by);
  }

  setMode(request: GroqModeRequest, by: string): void {
    this.save({ ...this.stored(), ...request }, by);
  }

  /**
   * "Transcrever com Groq" on one item (a master's click): its waiting transcription goes to
   * Groq when the estimate fits the cap; otherwise it stays with "Teto mensal" (FR-4).
   */
  sendItem(mediaId: string): void {
    if (!this.ready()) throw unavailable();
    const waiting = this.deps.queue.waitingOf(mediaId);
    if (!waiting || waiting.route !== 'transcriber')
      throw new AppError(
        'MEDIA_CONFLICT',
        'No transcription of this media waits for the transcriber',
      );
    if (!this.routeOrHold(waiting)) throw capReached();
  }

  /**
   * The scheduler (FR-2), on every janitor sweep: in "parado há N horas", each job waiting
   * longer than N hours, with no transcriber seen in that time, goes to Groq or is held.
   */
  sweep(): number {
    const stored = this.stored();
    if (stored.mode !== 'idle' || stored.sealedKey === null) return 0;
    const since = new Date(this.now().getTime() - stored.idleHours * HOUR_MS);
    if (!this.transcriberIdleSince(since)) return 0;
    let routed = 0;
    for (const waiting of this.deps.queue.waitingSince(since))
      if (this.routeOrHold(waiting)) routed++;
    if (routed > 0)
      this.deps.log.info({ routed }, 'transcriptions sent to Groq');
    return routed;
  }

  /**
   * One chunk of a Groq job the VM worker holds (FR-3, FR-4): paced at the free tier,
   * reserved against the cap, sent with the job's term list as the prompt. A cap reached or
   * a key Groq refuses gives the job back to the transcriber, and the worker drops it (409).
   */
  async transcribeChunk(
    owner: LeaseOwner,
    chunk: { readonly query: GroqChunkQuery; readonly audio: Buffer },
  ): Promise<ChunkOutcome> {
    const job = this.deps.queue.heldGroqJob(owner);
    if (!job) throw leaseLost();
    const audioMs = assertChunk(chunk.query);
    const key = this.ready() ? this.storedKey() : null;
    if (key === null) return this.giveBack(owner, null);
    const prompt = this.promptFor(chunk.query.termsVersion);
    const pace = this.deps.pacer.admit(audioMs, this.now().getTime());
    if (!pace.ok) return { kind: 'wait', retryAfterMs: pace.retryAfterMs };
    const reservation = this.reserve(job.mediaId, audioMs);
    if (!reservation) return this.giveBack(owner, 'monthly-cap');
    return this.send({ owner, key, prompt, audio: chunk.audio, reservation });
  }

  /** The job is still Groq's and this lease's (the transcript route checks it first). */
  assertHolds(owner: LeaseOwner): void {
    if (!this.deps.queue.heldGroqJob(owner)) throw leaseLost();
  }

  private async send(input: {
    owner: LeaseOwner;
    key: string;
    prompt: string;
    audio: Buffer;
    reservation: { id: string; usd: number };
  }): Promise<ChunkOutcome> {
    const { reservation } = input;
    const answer = await this.deps.groq.transcribe(input);
    // Groq charges only what it transcribed: anything else gives the reservation back.
    this.settle(reservation, answer.kind === 'ok' ? reservation.usd : 0);
    if (answer.kind === 'ok')
      return { kind: 'ok', result: chunkResultOf(answer.body) };
    if (answer.kind === 'rate-limited')
      return { kind: 'wait', retryAfterMs: answer.retryAfterMs };
    if (answer.kind === 'key-rejected') {
      this.deps.log.warn('Groq refused the stored key: the job goes back');
      return this.giveBack(input.owner, null);
    }
    throw new AppError('PROVIDER_UNAVAILABLE', 'Groq did not transcribe', {
      details: { status: answer.status },
    });
  }

  private settle(reservation: { id: string }, spentUsd: number): void {
    this.deps.ledger.close({
      id: reservation.id,
      spentUsd,
      outcome: spentUsd > 0 ? 'settled' : 'refunded',
      now: this.now(),
    });
  }

  /** Back to "Aguardando o transcritor", with why (FR-4); the worker's 409. */
  private giveBack(owner: LeaseOwner, hold: 'monthly-cap' | null): never {
    this.deps.queue.backToTranscriber({ owner, hold, now: this.now() });
    if (hold) this.deps.log.info({ job: owner.jobId }, 'media cap reached');
    throw leaseLost();
  }

  private reserve(
    mediaId: string,
    audioMs: number,
  ): { id: string; usd: number } | null {
    const id = randomUUID();
    const usd = groqUsdOf(audioMs);
    const now = this.now();
    const reserved = this.deps.ledger.reserve({
      id,
      kind: 'groq-transcription',
      mediaId,
      principal: 'groq',
      usd,
      capUsd: this.capUsd(),
      since: startOfAppMonth(now),
      now,
    });
    return reserved ? { id, usd } : null;
  }

  /** Routes the job when its estimate fits what the month has left; holds it otherwise. */
  private routeOrHold(waiting: WaitingTranscription): boolean {
    const now = this.now();
    const used = this.deps.ledger.usedSince(startOfAppMonth(now));
    const estimate = groqUsdOf(waiting.durationMs ?? 0);
    if (used + estimate > this.capUsd()) {
      this.deps.queue.hold({ jobId: waiting.jobId, hold: 'monthly-cap', now });
      return false;
    }
    return this.deps.queue.routeToGroq({ jobId: waiting.jobId, now });
  }

  /** No transcriber that transcribes was seen since `since` (none paired counts). */
  private transcriberIdleSince(since: Date): boolean {
    const presence = this.deps.presence();
    if (presence.transcriber === 'none') return true;
    if (presence.transcriber === 'on' || presence.offSince === null)
      return false;
    return Date.parse(presence.offSince) < since.getTime();
  }

  private promptFor(termsVersion: number): string {
    const terms = this.deps.transcripts.termsAt(termsVersion);
    if (!terms)
      throw new AppError(
        'VALIDATION_FAILED',
        'No such version of the term list',
        {
          details: { field: 'termsVersion' },
        },
      );
    return promptOf(terms.terms);
  }

  private stored(): StoredGroq {
    const saved = this.deps.settings.get(GROQ_SETTING);
    if (!saved) return DEFAULT_GROQ;
    const parsed = storedGroqSchema.safeParse(JSON.parse(saved.value));
    return parsed.success ? parsed.data : DEFAULT_GROQ;
  }

  private storedKey(): string | null {
    const { sealedKey } = this.stored();
    return sealedKey === null
      ? null
      : this.deps.sealer.open(sealedKey, KEY_CONTEXT);
  }

  private save(value: StoredGroq, by: string): void {
    this.deps.settings.set({
      key: GROQ_SETTING,
      value: JSON.stringify(value),
      by,
      now: this.now(),
    });
  }
}

/** A chunk's bounds, in order and at most ~28 s (FR-3); its length in ms. */
function assertChunk(query: GroqChunkQuery): number {
  const audioMs = query.endMs - query.startMs;
  if (audioMs <= 0 || audioMs > MAX_CHUNK_MS)
    throw new AppError('VALIDATION_FAILED', 'A chunk is 28 s at most', {
      details: { field: 'endMs' },
    });
  return audioMs;
}
