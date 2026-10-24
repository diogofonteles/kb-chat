import { describe, expect, it } from 'vitest';
import { NARRATION_HOLD_CHARS } from '../modules/research/index.js';
import { CliAnswer } from './cli-answer.js';

function answer() {
  const shown: string[] = [];
  return { shown, answer: new CliAnswer((text) => shown.push(text)) };
}

describe('CliAnswer (the narration rule for CLI turns)', () => {
  it('drops the text written before a tool call and shows the final message', () => {
    const { shown, answer: a } = answer();
    a.text('Os textos ainda não deram nome aos cinco princípios. ');
    a.text('Agora vou ler dois documentos.');
    a.toolCalled();
    a.text('Os cinco princípios ocultos são ');
    a.text('descontinuidade e limite [8].');
    a.ended();
    expect(shown.join('')).toBe(
      'Os cinco princípios ocultos são descontinuidade e limite [8].',
    );
  });

  it('streams a long answer once it passes the hold, and keeps it after a late tool call', () => {
    const { shown, answer: a } = answer();
    const chunk = 'O ritmo governa os ciclos [1]. ';
    for (let i = 0; i < 40; i += 1) a.text(chunk);
    const firstChunks = shown.length;
    expect(firstChunks).toBeGreaterThan(1);
    expect(shown[0]?.length).toBeGreaterThanOrEqual(NARRATION_HOLD_CHARS);
    a.toolCalled();
    a.text('fim.');
    a.ended();
    expect(shown.join('')).toBe(`${chunk.repeat(40)}fim.`);
  });

  it('drops the leading talk about its own work from the answer', () => {
    const { shown, answer: a } = answer();
    a.text('Tenho tudo o que preciso. Vou compor a resposta.\n\n---\n\n');
    a.text('## Os princípios');
    a.ended();
    a.ended();
    expect(shown).toEqual(['## Os princípios']);
  });

  it('shows nothing when everything was narration', () => {
    const { shown, answer: a } = answer();
    a.text('Vou procurar no acervo.');
    a.toolCalled();
    a.ended();
    expect(shown).toEqual([]);
  });
});
