import { describe, expect, it } from 'vitest';
import type {
  JobStatus,
  MediaRecord,
  TranscriptionRecord,
} from '../../ports/media-store.js';
import { toMediaItem } from './to-media-item.js';

const aRecord = (transcription: TranscriptionRecord): MediaRecord => ({
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  topic: 'hermetismo',
  title: 'Palestra',
  author: 'mestre-laercio',
  ownerPrincipal: 'owner',
  fileName: 'a.mp3',
  uploadBytes: 3,
  status: 'ready',
  progress: null,
  failure: null,
  durationMs: 1_000,
  bytes: 3,
  createdAt: '2026-11-03T12:00:00.000Z',
  updatedAt: '2026-11-03T12:00:00.000Z',
  transcription,
  track: null,
  archivedAt: null,
});

const statusOf = (jobStatus: JobStatus | null, version: number | null) =>
  toMediaItem(
    aRecord({ jobStatus, version, confidence: version ? 'normal' : null }),
    false,
  ).transcription.status;

describe('toMediaItem: the transcription (KBC-036)', () => {
  it.each<[JobStatus | null, number | null, string]>([
    [null, null, 'none'],
    [null, 1, 'done'],
    ['queued', null, 'waiting'],
    ['queued', 1, 'waiting'],
    ['leased', 1, 'transcribing'],
    ['done', 1, 'done'],
    ['done', null, 'none'],
    ['failed', null, 'failed'],
    ['dead', null, 'failed'],
    ['dead', 2, 'done'],
  ])('job %s with version %s is %s', (job, version, expected) => {
    expect(statusOf(job, version)).toBe(expected);
  });

  it('says no transcriber is paired when the presence is unknown', () => {
    const item = toMediaItem(
      aRecord({ jobStatus: 'queued', version: null, confidence: null }),
      true,
    );
    expect(item.transcription).toEqual({
      status: 'waiting',
      confidence: null,
      version: null,
      transcriber: 'none',
      transcriberOffSince: null,
      lastAttemptFailed: false,
    });
  });

  it('tells only masters that an attempt failed (KBC-040)', () => {
    const record = aRecord({
      jobStatus: 'dead',
      version: 1,
      confidence: 'normal',
    });
    expect(toMediaItem(record, false).transcription.lastAttemptFailed).toBe(
      false,
    );
  });

  it('calls a failed attempt so only when a transcript stayed (KBC-040 BR-3)', () => {
    const kept = toMediaItem(
      aRecord({ jobStatus: 'dead', version: 1, confidence: 'normal' }),
      true,
    );
    expect(kept.transcription).toMatchObject({
      status: 'done',
      lastAttemptFailed: true,
    });
    const none = toMediaItem(
      aRecord({ jobStatus: 'failed', version: null, confidence: null }),
      true,
    );
    expect(none.transcription).toMatchObject({
      status: 'failed',
      lastAttemptFailed: false,
    });
  });
});
