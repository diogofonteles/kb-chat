import { describe, expect, it } from 'vitest';
import type { TranscriptStorePort } from '../../ports/transcript-store.js';
import { MediaTrackShelf } from './track-shelf.js';

const TRACK = '0b9c1f7e-1111-4a2b-8c3d-000000000001';

const segment = (startMs: number, endMs: number, text: string) => ({
  startMs,
  endMs,
  text,
  avgLogprob: null,
  compressionRatio: null,
  noSpeechProb: null,
});

const transcripts: Pick<TranscriptStorePort, 'transcripts' | 'segments'> = {
  transcripts: (mediaId) =>
    mediaId === TRACK
      ? [
          {
            id: 't1',
            mediaId,
            version: 1,
            revision: 0,
            model: 'large-v3',
            confidence: 'normal',
            vad: 'applied',
            termsVersion: 1,
            rawPath: 't1.json',
            filterVersion: 1,
            confidenceVersion: 1,
            wordCount: 4,
            removedWords: 0,
            createdAt: '2026-11-03T12:00:00.000Z',
          },
        ]
      : [],
  segments: () => [
    segment(0, 1_000, 'É, italiano, tá.'),
    segment(1_200, 6_000, 'Meu pai veio da Itália.'),
  ],
};

const shelfOf = (voicesOf?: (mediaId: string) => (number | null)[] | null) =>
  new MediaTrackShelf({
    store: { getMedia: () => null },
    transcripts,
    ...(voicesOf && { voicesOf }),
  });

describe('MediaTrackShelf.segmentsOf: who speaks (KBC-156 BR-4)', () => {
  it("carries each segment's voice of the current separation, by position", () => {
    expect(shelfOf(() => [1, 2]).segmentsOf(TRACK)).toEqual([
      { startMs: 0, endMs: 1_000, text: 'É, italiano, tá.', voice: 1 },
      {
        startMs: 1_200,
        endMs: 6_000,
        text: 'Meu pai veio da Itália.',
        voice: 2,
      },
    ]);
  });

  it('says no voice without a separation, nor without a way to read one', () => {
    for (const shelf of [shelfOf(() => null), shelfOf()]) {
      expect(shelf.segmentsOf(TRACK).map((one) => one.voice)).toEqual([
        null,
        null,
      ]);
    }
  });

  it('has no segments without a transcript', () => {
    expect(shelfOf(() => [1]).segmentsOf('other')).toEqual([]);
  });
});
