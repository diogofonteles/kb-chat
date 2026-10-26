import { describe, expect, it } from 'vitest';
import {
  buildResearchMessages,
  researchSystemPrompt,
  subAgentSystemPrompt,
} from './prompt.js';

describe('buildResearchMessages', () => {
  it('tells the model to grep with find_text and variants before concluding absence, within 15 steps', () => {
    const [system] = buildResearchMessages({
      topicTitle: 'Hermetismo',
      question: 'quais são os 5 princípios ocultos',
      history: [],
      profile: 'deep',
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

  it('gives the fast profile 6 steps, batched reads and a focused answer (KBC-011)', () => {
    const fast = researchSystemPrompt('Hermetismo', 'fast');
    expect(fast).toContain('no máximo 6 passos');
    expect(fast).toContain('read_documents');
    expect(fast).toContain('Responda de forma focada');
    expect(researchSystemPrompt('Hermetismo', 'deep')).not.toContain(
      'Responda de forma focada',
    );
  });

  it('tells the model to open with the answer itself, never with its own process', () => {
    const text = researchSystemPrompt('Hermetismo');
    expect(text).toContain('A primeira frase já é conteúdo da resposta');
    expect(text).toContain('"Tenho tudo o que preciso"');
    expect(text).toContain('"---"');
  });

  it('keeps the Mestre Laércio apart from other authors in every profile and in the sub-researcher (KBC-020 AC-6)', () => {
    const prompts = [
      ...(['fast', 'deep', 'exhaustive'] as const).map((profile) =>
        researchSystemPrompt('Hermetismo', profile),
      ),
      subAgentSystemPrompt('Hermetismo'),
    ];
    for (const text of prompts) {
      expect(text).toContain('José Laércio do Egito');
      expect(text).toMatch(
        /Atribua ao Mestre Laércio só o que está em documentos com autoria "Mestre Laércio"/,
      );
      expect(text).toMatch(
        /nunca apresente a ideia de outro autor como ensinamento do Mestre/,
      );
      expect(text).toContain('authorship: "mestre-laercio"');
      expect(text).toMatch(/diga de quem é ou de que livro vem/);
    }
  });
});
