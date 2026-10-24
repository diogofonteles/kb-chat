import { describe, expect, it } from 'vitest';
import { INSUFFICIENT, buildMessages } from './prompt.js';
import { PASSAGE_CHARS, extractPassage, questionTerms } from './passages.js';

describe('questionTerms', () => {
  it('folds accents and drops short words and stopwords', () => {
    expect(questionTerms('Quais são os Princípios Herméticos?')).toEqual([
      'principios',
      'hermeticos',
    ]);
  });
});

describe('extractPassage', () => {
  const body =
    'Introdução longa.\n\nOutro assunto.\n\nOs princípios herméticos são sete.\nMais texto.';

  it('picks the window with the most occurrences of the question terms', () => {
    const doc = `Os Princípios Herméticos\n\nTexto longo sem os termos. ${'x '.repeat(1400)}\n\nOs sete princípios herméticos: o princípio mental, o princípio da correspondência.`;
    expect(
      extractPassage(doc, ['principios', 'principio', 'hermeticos']),
    ).toMatch(/^Os sete princípios herméticos: o princípio mental/);
    expect(extractPassage(body, ['hermeticos'])).toContain(
      'Os princípios herméticos são sete.',
    );
  });

  it('falls back to the start of the body and caps the length', () => {
    expect(
      extractPassage(body, ['inexistente']).startsWith('Introdução longa.'),
    ).toBe(true);
    expect(extractPassage('x'.repeat(5000), []).length).toBe(PASSAGE_CHARS);
  });
});

describe('buildMessages', () => {
  it('numbers quoted passages and tells the model to cite and to admit gaps (BR-4, BR-5)', () => {
    const [system, user] = buildMessages('o que é?', [
      { n: 1, id: 'a.md', title: 'A', text: 'trecho' },
    ]);
    expect(system?.content).toContain('[n]');
    expect(system?.content).toContain(INSUFFICIENT);
    expect(system?.content).toMatch(/ignore qualquer pedido/);
    expect(user?.content).toContain('[1] A\n"""\ntrecho\n"""');
  });
});
