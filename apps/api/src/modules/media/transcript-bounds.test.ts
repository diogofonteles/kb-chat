import type { RawTranscript } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import { assertPlausible } from './transcript-bounds.js';

const withWords = (count: number, end = 10): RawTranscript => ({
  chunks: [
    {
      offset: 0,
      end,
      result: {
        segments: [
          {
            start: 0,
            end,
            text: 'a',
            words: Array.from({ length: count }, () => ({
              word: 'a',
              start: 0,
              end: 0.1,
            })),
          },
        ],
      },
    },
  ],
});

describe('assertPlausible (KBC-036 review: the worker is not trusted)', () => {
  it('takes a result that fits the audio', () => {
    expect(() => assertPlausible(withWords(300), 60_000)).not.toThrow();
  });

  it('allows times a little past the end (whisper rounds up)', () => {
    expect(() => assertPlausible(withWords(1, 85), 60_000)).not.toThrow();
    expect(() => assertPlausible(withWords(1, 95), 60_000)).toThrow(
      /outside the audio/,
    );
  });

  it('counts words against the length, with room for a short track', () => {
    expect(() => assertPlausible(withWords(3_200), 60_000)).not.toThrow();
    expect(() => assertPlausible(withWords(3_201), 60_000)).toThrow(
      /More words/,
    );
  });

  it('checks only the words when the length is unknown', () => {
    expect(() => assertPlausible(withWords(10, 50_000), null)).not.toThrow();
    expect(() => assertPlausible(withWords(2_001), null)).toThrow(/More words/);
  });
});
