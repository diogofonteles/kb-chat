import { describe, expect, it } from 'vitest';
import {
  PASSAGE_MAX_MS,
  wholeSentences,
  type SpokenSegment,
} from './cited-passage.js';

const seg = (startS: number, endS: number, text: string): SpokenSegment => ({
  startMs: startS * 1000,
  endMs: endS * 1000,
  text,
});

/** The owner's case: a 1 s utterance at the track's start, speech right after it. */
const ITALIANO = [
  seg(0, 1, 'É, italiano, tá.'),
  seg(1.2, 6, 'Meu pai veio da Itália com a família inteira,'),
  seg(6.1, 12, 'e eu cresci na roça ouvindo as histórias dele.'),
  seg(12.5, 21, 'Depois a gente foi para Manaus trabalhar no seringal.'),
];

const span = (startS: number, endS: number) => ({
  startMs: startS * 1000,
  endMs: endS * 1000,
});

describe('wholeSentences (KBC-156)', () => {
  it('AC-1: a 1 s fragment at the track start grows to the whole next sentence, never 0:00–0:01', () => {
    expect(wholeSentences(ITALIANO, span(0, 1))).toEqual(span(0, 12));
  });

  it('AC-2: a segment ending in a comma runs on to the one that closes the sentence', () => {
    expect(wholeSentences(ITALIANO, span(1.2, 6))).toEqual(span(1.2, 12));
  });

  it('AC-2: a time in the middle of a sentence starts where the sentence starts', () => {
    expect(wholeSentences(ITALIANO, span(6.1, 12))).toEqual(span(1.2, 12));
  });

  it('a whole sentence long enough is left as it is (idempotent)', () => {
    expect(wholeSentences(ITALIANO, span(12.5, 21))).toEqual(span(12.5, 21));
    expect(wholeSentences(ITALIANO, span(0, 12))).toEqual(span(0, 12));
  });

  it('AC-3: a two-minute monologue with no sentence end is capped at 45 s and keeps the cited time', () => {
    const monologue = [
      ...Array.from({ length: 40 }, (_, at) =>
        seg(at * 3, at * 3 + 3, `fala corrida número ${at},`),
      ),
      seg(120, 121, 'Fim.'),
    ];
    const cited = wholeSentences(monologue, span(60, 63));
    expect(cited.endMs - cited.startMs).toBeLessThanOrEqual(PASSAGE_MAX_MS);
    expect(cited.startMs).toBeLessThanOrEqual(60_000);
    expect(cited.endMs).toBeGreaterThanOrEqual(63_000);
  });

  it('AC-3: a single cited segment longer than 45 s stays whole, never cut', () => {
    const long = [
      seg(0, 2, 'Sim.'),
      seg(2, 60, 'Uma fala longa sem fim'),
      seg(60, 61, 'Ok.'),
    ];
    expect(wholeSentences(long, span(2, 60))).toEqual(span(2, 60));
  });

  it('AC-4: the next sentence by another voice stays out; the previous one by the same voice comes in', () => {
    const voiced = [
      { ...seg(0, 6, 'Então ele contou de novo a história toda.'), voice: 0 },
      { ...seg(6.5, 7.5, 'É, italiano, tá.'), voice: 1 },
      {
        ...seg(8, 15, 'Pois é, meu pai veio da Itália com a família.'),
        voice: 2,
      },
    ];
    expect(wholeSentences(voiced, span(6.5, 7.5))).toEqual(span(6.5, 7.5));
    const sameBefore = voiced.map((one, at) =>
      at < 2 ? { ...one, voice: 1 } : one,
    );
    expect(wholeSentences(sameBefore, span(6.5, 7.5))).toEqual(span(0, 7.5));
  });

  it('AC-4: a restricted neighbour is never inside the passage, nor what lies past it', () => {
    const hidden = [
      seg(0, 1, 'É, italiano, tá.'),
      { ...seg(1.2, 6, ''), restricted: true as const },
      seg(6.1, 12, 'E eu cresci na roça ouvindo as histórias dele.'),
    ];
    expect(wholeSentences(hidden, span(0, 1))).toEqual(span(0, 1));
    const midSentence = [
      seg(0, 5, 'Meu pai veio da Itália'),
      { ...seg(5, 9, ''), restricted: true as const },
      seg(9.5, 10, 'Fim.'),
    ];
    expect(wholeSentences(midSentence, span(0, 5))).toEqual(span(0, 5));
  });

  it('AC-5: cited at the track end, the context comes from before', () => {
    const end = [
      seg(0, 6, 'Meu pai veio da Itália com a família inteira.'),
      seg(6.5, 7.5, 'É, italiano, tá.'),
    ];
    expect(wholeSentences(end, span(6.5, 7.5))).toEqual(span(0, 7.5));
  });

  it('AC-5: context never crosses a silence of more than 3 s', () => {
    const alone = [
      seg(0, 6, 'Meu pai veio da Itália com a família inteira.'),
      seg(10, 11, 'É, italiano, tá.'),
      seg(15, 22, 'Depois a gente foi para Manaus trabalhar no seringal.'),
    ];
    expect(wholeSentences(alone, span(10, 11))).toEqual(span(10, 11));
  });

  it('AC-6: with no sentence punctuation at all, each segment is a sentence', () => {
    const bare = [
      seg(0, 1, 'é italiano tá'),
      seg(1.2, 6, 'meu pai veio da itália com a família inteira'),
      seg(6.1, 12, 'e eu cresci na roça ouvindo as histórias dele'),
    ];
    expect(wholeSentences(bare, span(0, 1))).toEqual(span(0, 6));
    expect(wholeSentences(bare, span(1.2, 6))).toEqual(span(1.2, 12));
  });

  it('a span on no segment, or with no segments, is left as it is', () => {
    expect(wholeSentences([], span(41, 41))).toEqual(span(41, 41));
    expect(wholeSentences(ITALIANO, span(300, 301))).toEqual(span(300, 301));
  });

  it('an empty span at a segment start names that segment', () => {
    expect(wholeSentences(ITALIANO, span(0, 0))).toEqual(span(0, 12));
  });
});
