/**
 * The AI's track proposals under test (KBC-067): the media database in memory with one
 * transcribed recording, and a stub model that answers what each test scripts. No call
 * ever leaves the process (no paid API in tests).
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { MediaItem } from '@kb-chat/contracts';
import { openMediaDatabase } from '../src/adapters/sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from '../src/adapters/sqlite/media-migrations.js';
import { SqliteMediaSpendLedger } from '../src/adapters/sqlite/sqlite-media-spend-ledger.js';
import { SqliteTrackProposalStore } from '../src/adapters/sqlite/sqlite-track-proposal-store.js';
import { SqliteTranscriptStore } from '../src/adapters/sqlite/sqlite-transcript-store.js';
import type {
  LlmChunk,
  LlmMessage,
  LlmPort,
  LlmPrice,
  LlmStreamOptions,
} from '../src/ports/llm.js';

export interface SegmentSpec {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

/** `count` segments of `lengthMs` each, back to back, with numbered text. */
export const evenSegments = (count: number, lengthMs = 10_000): SegmentSpec[] =>
  Array.from({ length: count }, (_, index) => ({
    startMs: index * lengthMs,
    endMs: (index + 1) * lengthMs,
    text: `fala número ${index + 1}`,
  }));

function insertMedia(db: DatabaseSync, mediaId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
       upload_bytes, status, duration_ms, created_at, updated_at)
     VALUES (?, 'hermetismo', 'Palestra de 1998', 'outros-autores', 'owner', 'p.mp3', 10,
       'ready', 600000, ?, ?)`,
  ).run(mediaId, now, now);
}

function insertTranscript(
  db: DatabaseSync,
  input: { mediaId: string; segments: readonly SegmentSpec[] },
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO transcripts (id, media_id, version, provider, model, parameters,
       parameters_version, terms_version, vad, speech_ratio, elapsed_ms, raw_path,
       filter_version, confidence_version, confidence, word_count, removed_words,
       low_words, created_at)
     VALUES (?, ?, 1, 'mlx-whisper', 'turbo', '{}', '1', 1, 'applied', 0.9, 1000,
       'raw.json', 1, 1, 'normal', 10, 0, 0, ?)`,
  ).run(id, input.mediaId, new Date().toISOString());
  const segment = db.prepare(
    `INSERT INTO segments (transcript_id, position, start_ms, end_ms, text)
     VALUES (?, ?, ?, ?, ?)`,
  );
  input.segments.forEach((one, position) =>
    segment.run(id, position, one.startMs, one.endMs, one.text),
  );
  return id;
}

/** The media database in memory with one recording transcribed into `segments`. */
export function proposalDb(segments: readonly SegmentSpec[]) {
  const db = openMediaDatabase(':memory:', MEDIA_MIGRATIONS);
  const mediaId = randomUUID();
  insertMedia(db, mediaId);
  const transcriptId = insertTranscript(db, { mediaId, segments });
  return {
    db,
    mediaId,
    transcriptId,
    store: new SqliteTrackProposalStore(db),
    ledger: new SqliteMediaSpendLedger(db),
    transcripts: new SqliteTranscriptStore(db),
  };
}

/** A person's own track in the draft (KBC-066 writes these later). */
export function insertManualTrack(
  db: DatabaseSync,
  input: { mediaId: string; startMs: number; endMs: number; title: string },
): void {
  db.prepare(
    `INSERT INTO media_draft_tracks (id, media_id, run_id, source, first_segment,
       last_segment, start_ms, end_ms, kind, title, created_at)
     VALUES (?, ?, NULL, 'manual', 1, 1, ?, ?, 'qa', ?, ?)`,
  ).run(
    randomUUID(),
    input.mediaId,
    input.startMs,
    input.endMs,
    input.title,
    new Date().toISOString(),
  );
}

/** The item as the media service would show it to the owner. */
export const itemOf = (mediaId: string, author: string | null): MediaItem => ({
  id: mediaId,
  topic: 'hermetismo',
  title: 'Palestra de 1998',
  author: author === null ? null : { slug: 'autor', name: author, main: true },
  status: 'ready',
  progress: null,
  failure: null,
  durationMs: 600_000,
  bytes: 10,
  createdAt: new Date().toISOString(),
  canRetry: false,
  canEdit: false,
  canTranscribeAgain: false,
  positionMs: 0,
  completedAt: null,
  positionUpdatedAt: null,
  transcription: {
    status: 'done',
    confidence: 'normal',
    version: 1,
    transcriber: 'none',
    transcriberOffSince: null,
    lastAttemptFailed: false,
  },
  parent: null,
  archived: false,
});

/**
 * What the stub answers to one call: text, a failure, text built from the prompt, or
 * `HANG` (no answer until the call is aborted).
 */
export const HANG = Symbol('hang');

/** A stream that writes `partial` and then breaks (a provider failing mid-answer). */
export class BrokenStream {
  constructor(readonly partial: string) {}
}

export type StubReply =
  string | Error | typeof HANG | BrokenStream | ((user: string) => string);

const untilAborted = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => signal.addEventListener('abort', () => resolve()));

/** A model answering in order from `replies`; it records every prompt it received. */
export class StubLlm implements LlmPort {
  readonly model = 'stub/model';
  readonly billing = 'per-token' as const;
  readonly calls: LlmMessage[][] = [];
  /** US$ the provider reports per call; null when it reports none. */
  costPerCall: number | null = 0.001;

  constructor(
    readonly replies: StubReply[],
    readonly priceList: LlmPrice = { input: 1e-7, output: 2e-7 },
  ) {}

  configured(): boolean {
    return true;
  }

  async price(): Promise<LlmPrice> {
    return this.priceList;
  }

  async balance(): Promise<number | null> {
    return null;
  }

  async *stream(
    messages: readonly LlmMessage[],
    options: LlmStreamOptions,
  ): AsyncIterable<LlmChunk> {
    this.calls.push([...messages]);
    const reply = this.replies.shift() ?? new Error('no scripted reply');
    if (reply instanceof Error) throw reply;
    if (reply instanceof BrokenStream) {
      yield { type: 'token', text: reply.partial };
      throw new Error('stream broke');
    }
    if (reply === HANG) {
      await untilAborted(options.signal);
      options.signal.throwIfAborted();
    }
    const user = messages.at(-1)?.content ?? '';
    const text = typeof reply === 'function' ? reply(user) : String(reply);
    yield { type: 'token', text };
    yield {
      type: 'usage',
      usage: { inputTokens: 100, outputTokens: 50, usd: this.costPerCall },
    };
  }
}

/** The first and last segment ids a window's prompt names ("segmentos 1 a 60"). */
export function windowIds(user: string): { first: number; last: number } {
  const match = /segmentos (\d+) a (\d+)/.exec(user);
  return { first: Number(match?.[1]), last: Number(match?.[2]) };
}

/** A reply of one talk track over the whole window, with an optional continuation. */
export const wholeWindow =
  (options: { continues?: boolean; title?: string } = {}) =>
  (user: string): string => {
    const { first, last } = windowIds(user);
    return JSON.stringify({
      faixas: [
        {
          primeiro_id: first,
          ultimo_id: last,
          tipo: 'exposicao',
          quem_pergunta: null,
          quem_responde: null,
          titulo: options.title ?? `Janela ${first}`,
          continua_faixa_anterior: options.continues ?? false,
        },
      ],
    });
  };
