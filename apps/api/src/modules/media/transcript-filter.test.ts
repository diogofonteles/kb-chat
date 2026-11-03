import type { RawSegment, RawTranscript } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import { PILOT_TERMS, pilotRaw } from '../../../test/transcript-fixtures.js';
import { deriveTranscript } from './transcript-filter.js';

/** A segment whose words are its text split on spaces, 0.5 s each from `start`. */
function segment(
  text: string,
  start = 0,
  extra: Partial<RawSegment> = {},
): RawSegment {
  const words = text.split(' ').map((word, index) => ({
    word: ` ${word}`,
    start: start + index * 0.5,
    end: start + index * 0.5 + 0.4,
    probability: 0.9,
  }));
  const end = start + words.length * 0.5;
  return { start, end, text: ` ${text}`, avg_logprob: -0.2, words, ...extra };
}

const rawOf = (...segments: RawSegment[]): RawTranscript => ({
  chunks: [{ offset: 0, end: 30, result: { segments } }],
});

const textOf = (raw: RawTranscript) =>
  deriveTranscript(raw, PILOT_TERMS)
    .segments.map((one) => one.text)
    .join(' ');

describe('deriveTranscript (KBC-036 FR-3, ADR 0023 §5)', () => {
  it('shows the pilot loop "im offro um todo de tempo elingue" once (AC-4)', () => {
    const before = pilotRaw('loop-elingue');
    const rawText = before.chunks
      .flatMap((chunk) => chunk.result.segments.map((one) => one.text))
      .join(' ')
      .toLowerCase();
    expect(rawText.match(/im offro um todo de tempo/g)?.length).toBe(4);
    const derived = deriveTranscript(before, PILOT_TERMS);
    const text = derived.segments
      .map((one) => one.text)
      .join(' ')
      .toLowerCase();
    expect(text.match(/im offro um todo de tempo/g)?.length).toBe(1);
    expect(derived.stats.removedWords).toBe(21);
  });

  it('puts every chunk on the track clock, in milliseconds', () => {
    const raw: RawTranscript = {
      chunks: [
        { offset: 0, end: 5, result: { segments: [segment('primeiro corte')] } },
        {
          offset: 567.6,
          end: 590,
          result: { segments: [segment('segundo corte', 1.96)] },
        },
      ],
    };
    const derived = deriveTranscript(raw, PILOT_TERMS);
    expect(derived.segments.map((one) => one.startMs)).toEqual([0, 569_560]);
    expect(derived.words.map((one) => [one.segment, one.startMs])).toEqual([
      [0, 0],
      [0, 500],
      [1, 569_560],
      [1, 570_060],
    ]);
    expect(derived.words[0]?.text).toBe('primeiro');
  });

  it('collapses a loop that crosses segments and keeps natural speech', () => {
    const raw = rawOf(
      segment('a casa é bonita'),
      segment('o tempo passa o tempo passa', 3),
      segment('o tempo passa e fica', 6),
    );
    expect(textOf(raw)).toBe('a casa é bonita o tempo passa e fica');
  });

  it('keeps a word said twice but not three times in a row', () => {
    expect(textOf(rawOf(segment('vem vem comigo')))).toBe('vem vem comigo');
    expect(textOf(rawOf(segment('vem vem vem comigo')))).toBe('vem comigo');
  });

  it('collapses again when a collapse reveals a longer loop (NFR-3)', () => {
    const raw = rawOf(segment('x x x y x x x y x x x y fim'));
    expect(textOf(raw)).toBe('x y fim');
  });

  it('compares words without case or punctuation', () => {
    expect(textOf(rawOf(segment('Sim, sim. SIM! certo')))).toBe('Sim, certo');
  });

  it('collapses a loop of up to 12 words, not of 13', () => {
    const twelve = 'um dois três quatro cinco seis sete oito nove dez onze doze';
    const thirteen = `${twelve} treze`;
    const repeat = (text: string) => [text, text, text].join(' ');
    expect(textOf(rawOf(segment(repeat(twelve))))).toBe(twelve);
    expect(textOf(rawOf(segment(repeat(thirteen))))).toBe(repeat(thirteen));
  });

  it.each([
    ['Obrigado por assistir!'],
    ['Inscreva-se no canal'],
    ['Legendas pela comunidade Amara.org'],
    ['Thank you for watching'],
  ])('drops the invented phrase "%s"', (phrase) => {
    const derived = deriveTranscript(
      rawOf(segment('a palestra começa'), segment(phrase, 3)),
      PILOT_TERMS,
    );
    expect(derived.segments.map((one) => one.text)).toEqual([
      'a palestra começa',
    ]);
    expect(derived.stats.removedSegments).toBe(1);
  });

  it('drops an isolated "obrigado" only when whisper doubts there was speech', () => {
    const doubted = segment('Obrigado.', 3, { no_speech_prob: 0.85 });
    const spoken = segment('Obrigado.', 3, { no_speech_prob: 0.1 });
    expect(textOf(rawOf(segment('fim da sessão'), doubted))).toBe(
      'fim da sessão',
    );
    expect(textOf(rawOf(segment('fim da sessão'), spoken))).toBe(
      'fim da sessão Obrigado.',
    );
  });

  it('drops the term list leaking into the text', () => {
    const leak = segment(
      'Mestre Gabriel, UDV, União do Vegetal, Hoasca, Burracheira, Caiano',
      3,
    );
    const speech = segment('o Mestre Gabriel falou da Hoasca ontem à noite', 9);
    expect(textOf(rawOf(leak, speech))).toBe(
      'o Mestre Gabriel falou da Hoasca ontem à noite',
    );
  });

  it('keeps an untimed segment, collapsing its character loops', () => {
    const untimed: RawSegment = {
      start: 1,
      end: 4,
      text: ' ahahahahahahah que bom',
    };
    const derived = deriveTranscript(rawOf(untimed), PILOT_TERMS);
    expect(derived.segments.map((one) => one.text)).toEqual(['ah que bom']);
    expect(derived.words).toEqual([]);
    expect(derived.stats).toMatchObject({ wordsBefore: 3, removedWords: 0 });
  });

  it('gives an empty transcript for an empty result', () => {
    const derived = deriveTranscript({ chunks: [] }, PILOT_TERMS);
    expect(derived).toEqual({
      segments: [],
      words: [],
      stats: { wordsBefore: 0, removedWords: 0, removedSegments: 0 },
    });
  });
});
