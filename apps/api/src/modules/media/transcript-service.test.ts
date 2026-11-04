import { describe, expect, it } from 'vitest';
import type {
  DerivedSegment,
  DerivedWord,
  TranscriptStorePort,
  TranscriptSummary,
} from '../../ports/transcript-store.js';
import type { MediaActor } from './media-service.js';
import { TranscriptService } from './transcript-service.js';

const ACTOR: MediaActor = {
  principal: 'p',
  isMaster: false,
  canUpload: false,
  canSee: () => true,
};

const summaryOf = (id: string, version: number): TranscriptSummary => ({
  id,
  mediaId: id,
  version,
  model: 'large-v3',
  confidence: 'normal',
  vad: 'applied',
  termsVersion: 1,
  rawPath: `${id}.json`,
  filterVersion: 1,
  confidenceVersion: 1,
  wordCount: 1,
  removedWords: 0,
  createdAt: '2026-11-03T12:00:00.000Z',
});

/** A store with one transcript per media id, counting how often words are read. */
function fakeStore(ids: readonly string[]) {
  const reads = { words: 0 };
  const segment: DerivedSegment = {
    startMs: 0,
    endMs: 1_000,
    text: 'Olá.',
    avgLogprob: null,
    compressionRatio: null,
    noSpeechProb: null,
  };
  const word: DerivedWord = {
    segment: 0,
    startMs: 0,
    endMs: 1_000,
    text: 'Olá.',
    probability: 1,
  };
  const store: Pick<
    TranscriptStorePort,
    'transcripts' | 'segments' | 'words' | 'wordsOfSegments' | 'termVersion'
  > = {
    transcripts: (mediaId) =>
      ids.includes(mediaId) ? [summaryOf(mediaId, 1)] : [],
    segments: () => [segment],
    termVersion: () => null,
    words: () => {
      reads.words++;
      return [word];
    },
    wordsOfSegments: () => [word],
  };
  return { store, reads };
}

function serviceOf(ids: readonly string[], cacheSize: number) {
  const { store, reads } = fakeStore(ids);
  const service = new TranscriptService({
    transcripts: store,
    media: { get: () => undefined },
    cacheSize,
  });
  return { service, reads };
}

describe('TranscriptService subtitles cache (KBC-038)', () => {
  it('derives a version once and serves it from memory after that', () => {
    const { service, reads } = serviceOf(['a'], 2);
    const first = service.subtitles(ACTOR, 'a');
    const second = service.subtitles(ACTOR, 'a');
    expect(second).toEqual(first);
    expect(reads.words).toBe(1);
    expect(first.body).toContain('Olá.');
  });

  it('forgets the least recently used version beyond its size', () => {
    const { service, reads } = serviceOf(['a', 'b', 'c'], 2);
    service.subtitles(ACTOR, 'a');
    service.subtitles(ACTOR, 'b');
    service.subtitles(ACTOR, 'a'); // "a" is now the most recent
    service.subtitles(ACTOR, 'c'); // "b" goes
    expect(reads.words).toBe(3);
    service.subtitles(ACTOR, 'a');
    expect(reads.words).toBe(3);
    service.subtitles(ACTOR, 'b');
    expect(reads.words).toBe(4);
  });
});
