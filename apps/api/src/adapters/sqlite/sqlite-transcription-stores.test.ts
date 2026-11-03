import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NewTranscript } from '../../ports/transcript-store.js';
import { openMediaDatabase } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';
import { SqliteMediaStore } from './sqlite-media-store.js';
import { SqliteTranscriberStore } from './sqlite-transcriber-store.js';
import { SqliteTranscriptStore } from './sqlite-transcript-store.js';

const T0 = new Date('2026-11-03T12:00:00.000Z');
const MEDIA = '66666666-6666-4666-8666-666666666666';
let db: DatabaseSync;
let media: SqliteMediaStore;
let transcripts: SqliteTranscriptStore;
let transcribers: SqliteTranscriberStore;

function readyMedia(): void {
  media.createMedia({
    id: MEDIA,
    topic: 'hermetismo',
    title: 'Palestra',
    author: null,
    legacyAuthorship: 'outros-autores',
    ownerPrincipal: 'owner',
    fileName: 'a.mp3',
    uploadBytes: 3,
    now: T0,
  });
  db.prepare("UPDATE media SET status = 'ready' WHERE id = ?").run(MEDIA);
}

const aTranscript = (
  overrides: Partial<NewTranscript> = {},
): NewTranscript => ({
  id: crypto.randomUUID(),
  mediaId: MEDIA,
  provider: 'mlx-whisper',
  model: 'turbo',
  parameters: '{}',
  parametersVersion: '1',
  termsVersion: 1,
  vad: 'skipped',
  speechRatio: 0.2,
  elapsedMs: 10,
  rawPath: 'transcripts/x.json',
  filterVersion: 1,
  confidenceVersion: 1,
  confidence: 'normal',
  wordCount: 1,
  removedWords: 0,
  lowWords: 0,
  segments: [
    {
      startMs: 0,
      endMs: 900,
      text: 'olá',
      avgLogprob: null,
      compressionRatio: null,
      noSpeechProb: null,
    },
  ],
  words: [
    { segment: 0, startMs: 0, endMs: 400, text: 'olá', probability: null },
  ],
  ...overrides,
});

/** Queues and leases a transcription for `worker`. */
function leased(worker: string) {
  transcripts.requestTranscription({
    mediaId: MEDIA,
    jobId: crypto.randomUUID(),
    now: T0,
  });
  const job = media.leaseJob({
    kinds: ['transcribe'],
    worker,
    now: T0,
    leaseMs: 60_000,
  });
  if (!job) throw new Error('nothing to lease');
  return { jobId: job.id, leaseId: job.leaseId, worker };
}

beforeEach(() => {
  db = openMediaDatabase(':memory:', MEDIA_MIGRATIONS);
  media = new SqliteMediaStore(db);
  transcripts = new SqliteTranscriptStore(db);
  transcribers = new SqliteTranscriberStore(db);
});
afterEach(() => media.close());

describe('SqliteTranscriptStore', () => {
  it('fails loudly without a term list', () => {
    db.exec('DELETE FROM terms');
    expect(() => transcripts.currentTerms()).toThrow(/no term list/);
  });

  it('serves the newest term list', () => {
    db.prepare(
      "INSERT INTO terms (version, position, term) VALUES (2, 1, 'Mariri')",
    ).run();
    expect(transcripts.currentTerms()).toEqual({
      version: 2,
      terms: ['Mariri'],
    });
  });

  it('queues one transcription at a time per item', () => {
    readyMedia();
    const request = () =>
      transcripts.requestTranscription({
        mediaId: MEDIA,
        jobId: crypto.randomUUID(),
        now: T0,
      });
    expect(request()).toBe(true);
    expect(request()).toBe(false);
  });

  it('stores versions in order with nulls kept', () => {
    readyMedia();
    const first = leased('transcriber:a');
    expect(transcripts.heldJob(first)).toEqual({
      mediaId: MEDIA,
      kind: 'transcribe',
    });
    expect(transcripts.heldJob({ ...first, worker: 'other' })).toBeNull();
    expect(
      transcripts.completeTranscribe({
        owner: first,
        transcript: aTranscript(),
        now: T0,
      }),
    ).toBe(true);
    expect(
      transcripts.completeTranscribe({
        owner: first,
        transcript: aTranscript(),
        now: T0,
      }),
    ).toBe(false);
    const second = leased('transcriber:a');
    transcripts.completeTranscribe({
      owner: second,
      transcript: aTranscript({ confidence: 'low', vad: 'applied' }),
      now: T0,
    });
    const versions = transcripts.transcripts(MEDIA);
    expect(
      versions.map((one) => [one.version, one.confidence, one.vad]),
    ).toEqual([
      [2, 'low', 'applied'],
      [1, 'normal', 'skipped'],
    ]);
    const [newest] = versions;
    expect(transcripts.segments(newest?.id ?? '')[0]).toMatchObject({
      avgLogprob: null,
      noSpeechProb: null,
    });
    expect(transcripts.words(newest?.id ?? '')[0]?.probability).toBeNull();
    expect(media.getMedia(MEDIA)?.transcription).toEqual({
      jobStatus: 'done',
      version: 2,
      confidence: 'low',
    });
  });
});

describe('SqliteTranscriberStore', () => {
  const pairOne = (id: string, tokenHash: string) =>
    transcribers.pair({
      id,
      name: `Mac ${id.slice(0, 4)}`,
      kinds: ['transcribe'],
      tokenHash,
      createdBy: 'owner',
      now: T0,
    });

  it('finds a transcriber by its token hash, records when it was seen and its job', () => {
    readyMedia();
    const id = '77777777-7777-4777-8777-777777777777';
    pairOne(id, 'hash-1');
    expect(transcribers.byTokenHash('hash-2')).toBeNull();
    transcribers.touch({ id, now: T0 });
    leased(`transcriber:${id}`);
    expect(transcribers.byTokenHash('hash-1')).toMatchObject({
      lastSeenAt: T0.toISOString(),
      currentJob: { mediaId: MEDIA, title: 'Palestra' },
    });
  });

  it('revokes once, hides the transcriber and requeues its work', () => {
    readyMedia();
    const id = '88888888-8888-4888-8888-888888888888';
    pairOne(id, 'hash-3');
    leased(`transcriber:${id}`);
    expect(transcribers.revoke({ id, now: T0 })).toBe(true);
    expect(transcribers.revoke({ id, now: T0 })).toBe(false);
    expect(transcribers.list()).toEqual([]);
    expect(transcribers.byTokenHash('hash-3')).toBeNull();
    expect(media.getMedia(MEDIA)?.transcription.jobStatus).toBe('queued');
  });

  it('refuses a second transcriber with the same token hash', () => {
    pairOne('99999999-9999-4999-8999-999999999999', 'same');
    expect(() =>
      pairOne('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'same'),
    ).toThrow(/UNIQUE/);
  });
});
