import { describe, expect, it } from 'vitest';
import { AnswerStream, PREAMBLE_WINDOW_CHARS } from './answer-stream.js';

describe('AnswerStream (ADR 0009)', () => {
  it('shows the answer once its first sentence ends, then every delta at once', () => {
    const stream = new AnswerStream();
    expect(stream.text('Os cinco princípios')).toEqual([]);
    expect(stream.text(' são estes. ')).toEqual([
      {
        type: 'token',
        text: 'Os cinco princípios são estes. ',
        segment: 0,
      },
    ]);
    expect(stream.text('Primeiro')).toEqual([
      { type: 'token', text: 'Primeiro', segment: 0 },
    ]);
    expect(stream.ended()).toEqual([]);
    expect(stream.shown).toBe('Os cinco princípios são estes. Primeiro');
  });

  it('holds at most the preamble window when no sentence ends', () => {
    const stream = new AnswerStream();
    const long = 'a'.repeat(PREAMBLE_WINDOW_CHARS - 1);
    expect(stream.text(long)).toEqual([]);
    expect(stream.text('bc')).toEqual([
      { type: 'token', text: `${long}bc`, segment: 0 },
    ]);
  });

  it('drops a leading preamble and streams from the content after it', () => {
    const stream = new AnswerStream();
    expect(stream.text('Tenho tudo o que preciso. ')).toEqual([]);
    expect(stream.text('Vou compor a resposta.\n\n')).toEqual([]);
    expect(stream.text('São cinco [1]. ')).toEqual([
      { type: 'token', text: 'São cinco [1]. ', segment: 0 },
    ]);
  });

  it('retracts a shown segment when its call asks for tools; the next call is a new segment', () => {
    const stream = new AnswerStream();
    stream.text('Os textos sobre o ritmo são dois. ');
    expect(stream.toolCalled()).toEqual([{ type: 'retract', segment: 0 }]);
    // Further tool calls of the same call change nothing.
    expect(stream.toolCalled()).toEqual([]);
    expect(stream.shown).toBe('');
    stream.text('O ritmo é uma lei [1].');
    expect(stream.ended()).toEqual([
      { type: 'token', text: 'O ritmo é uma lei [1].', segment: 1 },
    ]);
    expect(stream.shown).toBe('O ritmo é uma lei [1].');
  });

  it('holds text that announces research, and shows it only if the call ends without tools', () => {
    const held = new AnswerStream();
    expect(held.text('Vou buscar no acervo os cinco princípios. ')).toEqual([]);
    expect(held.text('E também os doze.')).toEqual([]);
    expect(held.toolCalled()).toEqual([]);
    const answered = new AnswerStream();
    answered.text('Deixe-me ler o texto. ');
    expect(answered.ended()).toEqual([
      { type: 'token', text: 'Deixe-me ler o texto. ', segment: 0 },
    ]);
  });

  it('does not end a sentence at an exclamation, so "Ótimo! Agora tenho…" is dropped whole', () => {
    const stream = new AnswerStream();
    expect(stream.text('Ótimo! ')).toEqual([]);
    expect(
      stream.text('Agora tenho todas as informações necessárias:\n\n'),
    ).toEqual([]);
    expect(stream.text('Os cinco são: [1]. ')).toEqual([
      { type: 'token', text: 'Os cinco são: [1]. ', segment: 0 },
    ]);
  });

  it('says a server notice in a segment of its own and ignores empty deltas', () => {
    const stream = new AnswerStream();
    expect(stream.text('')).toEqual([]);
    expect(stream.say('Não consegui.')).toEqual([
      { type: 'token', text: 'Não consegui.', segment: 0 },
    ]);
    expect(stream.text('Outra. ')).toEqual([
      { type: 'token', text: 'Outra. ', segment: 1 },
    ]);
  });

  it('ends a segment with only what came before the marker when nothing escalates (deep pass, Stop)', () => {
    const stream = new AnswerStream();
    stream.text('Primeira frase. <<APROFUNDAR>> faltam dois');
    stream.ended();
    expect(stream.shown).toBe('Primeira frase. ');
    const whole = new AnswerStream();
    expect(whole.text('<<APROFUNDAR>> faltam dois')).toEqual([]);
    expect(whole.ended()).toEqual([]);
  });
});
