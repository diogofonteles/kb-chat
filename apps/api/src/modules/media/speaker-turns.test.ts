import { describe, expect, it } from 'vitest';
import {
  deriveTurns,
  dominantVoices,
  speakingTimeOf,
  voiceCountOf,
  wordVoicesOf,
} from './speaker-turns.js';

const turn = (start: number, end: number, voice: string) => ({
  start,
  end,
  voice,
});

describe('deriveTurns (KBC-064 FR-3)', () => {
  it('numbers voices by who speaks first, in ms', () => {
    expect(
      deriveTurns([turn(3, 6, 'SPEAKER_01'), turn(0, 3, 'SPEAKER_02')], null),
    ).toEqual([
      { voice: 1, startMs: 0, endMs: 3_000 },
      { voice: 2, startMs: 3_000, endMs: 6_000 },
    ]);
  });

  it('keeps one voice per instant: the later turn takes over from its start', () => {
    expect(deriveTurns([turn(0, 5, 'A'), turn(4, 8, 'B')], null)).toEqual([
      { voice: 1, startMs: 0, endMs: 4_000 },
      { voice: 2, startMs: 4_000, endMs: 8_000 },
    ]);
  });

  it('joins back-to-back turns of one voice and drops empty ones', () => {
    expect(
      deriveTurns(
        [turn(0, 2, 'A'), turn(2, 4, 'A'), turn(5, 5, 'B'), turn(6, 7, 'A')],
        null,
      ),
    ).toEqual([
      { voice: 1, startMs: 0, endMs: 4_000 },
      { voice: 1, startMs: 6_000, endMs: 7_000 },
    ]);
  });

  it('clips turns to the recording', () => {
    expect(deriveTurns([turn(0, 12, 'A'), turn(11, 13, 'B')], 10_000)).toEqual([
      { voice: 1, startMs: 0, endMs: 10_000 },
    ]);
  });

  it('never gives more than 10 voices: an 11th joins the one that speaks most', () => {
    const many = Array.from({ length: 11 }, (_, index) =>
      turn(index, index + (index === 3 ? 0.9 : 0.5), `S${index}`),
    );
    const turns = deriveTurns(many, null);
    expect(voiceCountOf(turns)).toBe(10);
    expect(turns.at(-1)?.voice).toBe(4);
  });

  it('gives nothing for no turns (silence)', () => {
    expect(deriveTurns([], 60_000)).toEqual([]);
  });
});

describe('the voice of segments and words', () => {
  const turns = [
    { voice: 1, startMs: 0, endMs: 4_000 },
    { voice: 2, startMs: 4_000, endMs: 10_000 },
    { voice: 1, startMs: 12_000, endMs: 14_000 },
  ];

  it('gives each segment the voice that speaks most of it, null where none speaks', () => {
    expect(
      dominantVoices(
        [
          { startMs: 0, endMs: 3_000 },
          { startMs: 3_000, endMs: 9_000 },
          { startMs: 10_000, endMs: 11_500 },
          { startMs: 11_000, endMs: 14_000 },
        ],
        turns,
      ),
    ).toEqual([1, 2, null, 1]);
  });

  it('gives each word the turn holding its middle, or its segment voice in a gap', () => {
    expect(
      wordVoicesOf({
        words: [
          { segment: 0, startMs: 3_500, endMs: 4_200 },
          { segment: 0, startMs: 4_200, endMs: 4_600 },
          { segment: 1, startMs: 10_200, endMs: 10_600 },
          { segment: 1, startMs: 12_500, endMs: 13_000 },
        ],
        turns,
        segmentVoices: [2, 1],
      }),
    ).toEqual([1, 2, 1, 1]);
  });

  it('sums the speaking time per voice', () => {
    expect(speakingTimeOf(turns)).toEqual([
      { voice: 1, speakingMs: 6_000 },
      { voice: 2, speakingMs: 6_000 },
    ]);
  });
});
