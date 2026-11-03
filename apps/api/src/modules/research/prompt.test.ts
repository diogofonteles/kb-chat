import {
  batchSystemPrompt,
  sweepAnswerSystemPrompt,
} from './sweep/sweep-prompts.js';
import { describe, expect, it } from 'vitest';
import { buildResearchMessages, researchSystemPrompt } from './prompt.js';
import { defaultSubscriptionPrompt } from '../../adapters/subscription-prompt.js';

describe('buildResearchMessages', () => {
  it('tells the model to grep with find_text and variants before concluding absence, within 15 steps', () => {
    const [system] = buildResearchMessages({
      topicTitle: 'Hermetismo',
      question: 'quais são os 5 princípios ocultos',
      history: [],
      profile: 'deep',
      mainAuthor: 'Mestre Laércio',
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

  it('keeps the Mestre Laércio apart from other authors in every profile, the sweep batches and its answer (KBC-020 AC-6, KBC-030)', () => {
    const prompts = [
      ...(['fast', 'deep', 'exhaustive'] as const).map((profile) =>
        researchSystemPrompt(
          { title: 'Hermetismo', mainAuthor: 'Mestre Laércio' },
          profile,
        ),
      ),
      batchSystemPrompt('Hermetismo', 'Mestre Laércio'),
      sweepAnswerSystemPrompt('Hermetismo', 'Mestre Laércio'),
    ];
    for (const text of prompts) {
      expect(text).toContain('O autor principal deste acervo é Mestre Laércio');
      expect(text).toMatch(
        /Atribua a Mestre Laércio só o que está em documentos com autoria "Mestre Laércio"/,
      );
      expect(text).toMatch(
        /nunca apresente a ideia de outro autor como ensinamento de Mestre Laércio/,
      );
      expect(text).toContain('authorship: "mestre-laercio"');
      expect(text).toMatch(/diga de quem é ou de que livro vem/);
    }
  });

  it("names each collection's own main author, never another one (KBC-049 AC-2)", () => {
    const prompts = [
      researchSystemPrompt({ title: 'UDV', mainAuthor: 'Mestre Gabriel' }),
      batchSystemPrompt('UDV', 'Mestre Gabriel'),
      sweepAnswerSystemPrompt('UDV', 'Mestre Gabriel'),
    ];
    for (const text of prompts) {
      expect(text).toMatch(
        /Atribua a Mestre Gabriel só o que está em documentos com autoria "Mestre Gabriel"/,
      );
      expect(text).toMatch(
        /nunca apresente a ideia de outro autor como ensinamento de Mestre Gabriel/,
      );
      expect(text).not.toContain('Laércio');
    }
  });

  it('keeps only the rule against mixing authors when the collection has no main author (KBC-049)', () => {
    for (const text of [
      researchSystemPrompt('Alquimia', 'deep'),
      // The Claude Code and Codex turns (ADR 0007) get the same rules.
      defaultSubscriptionPrompt('Alquimia', 'deep'),
    ]) {
      expect(text).toContain(
        'nunca atribua a um autor o que está em documentos de outro',
      );
      expect(text).not.toContain('autor principal');
      expect(text).not.toContain('Laércio');
    }
  });

  it('asks the exhaustive orchestrator to plan, never to write coverage numbers (KBC-030)', () => {
    const text = researchSystemPrompt('Hermetismo', 'exhaustive');
    expect(text).toContain('plan_sweep');
    expect(text).toContain('Nunca escreva linha nem números de cobertura');
    expect(text).not.toContain('delegate');
    expect(sweepAnswerSystemPrompt('Hermetismo', null)).toContain(
      'Nunca escreva linha nem números de cobertura',
    );
  });
});
