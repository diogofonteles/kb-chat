import { describe, expect, it } from 'vitest';
import { buildResearchMessages, researchSystemPrompt } from './prompt.js';

describe('buildResearchMessages', () => {
  it('tells the model to grep with find_text and variants before concluding absence, within 15 steps', () => {
    const [system] = buildResearchMessages({
      topicTitle: 'Hermetismo',
      question: 'quais são os 5 princípios ocultos',
      history: [],
    });
    expect(system?.role).toBe('system');
    const text = system?.content ?? '';
    expect(text).toContain('no máximo 15 passos');
    expect(text).toMatch(/use find_text/);
    expect(text).toMatch(
      /Nunca conclua que o acervo não traz algo sem antes usar find_text/,
    );
    for (const variant of [
      'ocultos',
      'secretos',
      'velados',
      'universais',
      'adicionais',
    ])
      expect(text).toContain(variant);
    expect(text).toContain('"cinco princípios", "doze princípios"');
  });

  it('tells the model to open with the answer itself, never with its own process', () => {
    const text = researchSystemPrompt('Hermetismo');
    expect(text).toContain('A primeira frase já é conteúdo da resposta');
    expect(text).toContain('"Tenho tudo o que preciso"');
    expect(text).toContain('"---"');
  });
});
