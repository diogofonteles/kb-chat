import type { RawTranscript } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import {
  PILOT_TERMS,
  pilotRaw,
  type PilotFixture,
} from '../../../test/transcript-fixtures.js';
import { confidenceOf } from './transcript-confidence.js';
import { deriveTranscript } from './transcript-filter.js';

const verdictOf = (raw: RawTranscript) =>
  confidenceOf(deriveTranscript(raw, PILOT_TERMS));

const spoken = (
  avgLogprob: number,
  text = 'uma frase dita com clareza',
): RawTranscript => ({
  chunks: [
    {
      offset: 0,
      end: 10,
      result: {
        segments: [
          {
            start: 0,
            end: 3,
            text,
            avg_logprob: avgLogprob,
            compression_ratio: 1.3,
            words: text.split(' ').map((word, index) => ({
              word: ` ${word}`,
              start: index * 0.5,
              end: index * 0.5 + 0.4,
            })),
          },
        ],
      },
    },
  ],
});

describe('confidenceOf (KBC-036 FR-4, ADR 0023 §6)', () => {
  it.each<PilotFixture>(['noisy-cd03-05', 'noisy-cd03-06', 'noisy-cd03-08'])(
    'marks the noisy excerpt %s low (AC-5)',
    (track) => {
      expect(verdictOf(pilotRaw(track)).confidence).toBe('low');
    },
  );

  it.each<PilotFixture>(['clean-cd01-01', 'clean-cd02-01'])(
    'keeps the clean excerpt %s normal (AC-5)',
    (track) => {
      expect(verdictOf(pilotRaw(track)).confidence).toBe('normal');
    },
  );

  it('is low when most words sit in segments whisper doubted', () => {
    expect(verdictOf(spoken(-0.7))).toMatchObject({
      confidence: 'low',
      doubtedWords: 5,
      wordCount: 5,
    });
    expect(verdictOf(spoken(-0.5)).confidence).toBe('normal');
  });

  it('is low when the filter removed more than a tenth of the words', () => {
    const looped = spoken(-0.2, 'sim sim sim sim sim sim e depois disso tudo');
    expect(verdictOf(looped)).toMatchObject({
      confidence: 'low',
      wordCount: 5,
    });
  });

  it('is low for a transcript with no words', () => {
    expect(verdictOf({ chunks: [] }).confidence).toBe('low');
  });

  it('counts an untimed segment by its text', () => {
    const raw: RawTranscript = {
      chunks: [
        {
          offset: 0,
          end: 5,
          result: {
            segments: [{ start: 0, end: 2, text: 'três palavras ditas' }],
          },
        },
      ],
    };
    expect(verdictOf(raw)).toMatchObject({
      confidence: 'normal',
      wordCount: 3,
    });
  });
});
