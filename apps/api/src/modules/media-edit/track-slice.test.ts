import { describe, expect, it } from 'vitest';
import { sliceTranscript } from './track-slice.js';

const segment = (startMs: number, endMs: number, text: string) => ({
  startMs,
  endMs,
  text,
  avgLogprob: -0.1,
  compressionRatio: 1.2,
  noSpeechProb: 0,
});
const word = (segmentIndex: number, startMs: number, text: string) => ({
  segment: segmentIndex,
  startMs,
  endMs: startMs + 400,
  text,
  probability: 0.9,
});

const transcript = {
  segments: [
    segment(0, 1_000, 'antes da faixa'),
    segment(1_000, 3_000, 'um dois tres quatro'),
    segment(3_000, 4_000, 'dentro inteiro'),
    segment(4_000, 5_000, 'sem palavras'),
    segment(9_000, 10_000, 'depois'),
  ],
  words: [
    word(0, 100, ' antes'),
    word(1, 1_000, ' um'),
    word(1, 1_500, ' dois'),
    word(1, 2_000, ' tres'),
    word(1, 2_500, ' quatro'),
    word(2, 3_100, ' dentro'),
    word(2, 3_500, ' inteiro'),
    word(4, 9_100, ' depois'),
  ],
};

describe('sliceTranscript (KBC-068 FR-3)', () => {
  it('keeps the words whose midpoint is inside, with times from the track', () => {
    const slice = sliceTranscript(transcript, { startMs: 2_000, endMs: 6_000 });
    expect(slice.segments.map((one) => one.text)).toEqual([
      'tres quatro',
      'dentro inteiro',
      'sem palavras',
    ]);
    expect(slice.segments[0]).toMatchObject({ startMs: 0, endMs: 1_000 });
    expect(slice.words[0]).toMatchObject({
      segment: 0,
      startMs: 0,
      endMs: 400,
      text: ' tres',
    });
    expect(slice.words.at(-1)).toMatchObject({ segment: 1, startMs: 1_500 });
  });

  it('never gives a time past the end of the track', () => {
    const slice = sliceTranscript(transcript, { startMs: 3_000, endMs: 3_800 });
    expect(slice.words.map((one) => one.endMs)).toEqual([500, 800]);
  });

  it('gives nothing for a window with no speech', () => {
    expect(
      sliceTranscript(transcript, { startMs: 6_000, endMs: 8_000 }).segments,
    ).toEqual([]);
  });
});
