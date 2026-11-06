import { describe, expect, it } from 'vitest';
import { verboseJson } from '../../testing/fake-groq.js';
import { chunkResultOf } from './groq-result.js';

describe("chunkResultOf: Groq's answer in the Mac's shape (KBC-037 FR-3)", () => {
  it('puts each word inside the segment it starts in, keeping what Groq said', () => {
    const body = {
      text: 'Um dois três',
      segments: [
        { start: 0, end: 1.2, text: ' Um dois', avg_logprob: -0.3 },
        { start: 1.5, end: 2.5, text: ' três' },
      ],
      words: [
        { word: 'Um', start: 0, end: 0.4 },
        { word: 'dois', start: 0.6, end: 1.1 },
        { word: 'três', start: 1.6, end: 2.2 },
      ],
    };
    const result = chunkResultOf(body);
    expect(result).toEqual({
      text: 'Um dois três',
      segments: [
        {
          start: 0,
          end: 1.2,
          text: ' Um dois',
          avg_logprob: -0.3,
          words: [
            { word: 'Um', start: 0, end: 0.4 },
            { word: 'dois', start: 0.6, end: 1.1 },
          ],
        },
        {
          start: 1.5,
          end: 2.5,
          text: ' três',
          words: [{ word: 'três', start: 1.6, end: 2.2 }],
        },
      ],
    });
    expect(result).not.toHaveProperty('words');
  });

  it('reads what the fake Groq answers', () => {
    const result = chunkResultOf(verboseJson('O chá Hoasca'));
    expect(result.segments[0]?.words?.map((word) => word.word)).toEqual([
      'O',
      'chá',
      'Hoasca',
    ]);
  });

  it('refuses an answer that is not verbose JSON', () => {
    expect(() => chunkResultOf({ segments: 'nope' })).toThrow();
  });
});
