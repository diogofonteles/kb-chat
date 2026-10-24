import { describe, expect, it } from 'vitest';
import { absenceIn } from './absence.js';

/** Answers that give up on the collection: a fast turn like these goes deeper (ADR 0009). */
const GIVES_UP = [
  // The two phrases QA got from the fast profile, verbatim.
  'Os documentos do acervo não dizem quais são os cinco princípios ocultos. Eles de propósito não os nomeiam.',
  'Eles de propósito não os nomeiam.',
  'O acervo não nomeia os cinco princípios ocultos. Ele afirma que eles existem e explica por que não são listados.',
  'O acervo não diz quais são os cinco princípios ocultos.',
  'Os textos do acervo não mencionam essa lista.',
  'Os textos não os listam: a Ordem prefere que o discípulo os descubra.',
  'Nenhum documento traz os nomes dos cinco princípios.',
  'Nenhum dos textos do acervo nomeia os cinco.',
  'Nenhuma das fontes consultadas revela a lista.',
  'Não há informações sobre isso no acervo.',
  'Não existe menção a esses nomes nos textos.',
  'Não encontrei a lista dos cinco princípios.',
  'Não a localizei em nenhum dos documentos.',
  'Procurei, mas não achei os nomes.',
  'Essa lista não consta nos documentos do acervo.',
  'O nome desse princípio não aparece no acervo.',
  'O material disponível não especifica quais são os cinco.',
  'As fontes não detalham os cinco princípios ocultos.',
  'Os livros do acervo não explicam quais seriam.',
  'Nem os textos sobre a Ordem trazem a lista.',
  'Os documentos deliberadamente não revelam os cinco princípios.',
  'O acervo não lhes dá nomes.',
  '## Os cinco princípios ocultos\n\nO acervo não traz a lista completa.',
  'Os textos dizem que existem cinco [3]. Eles propositalmente não os nomeiam [3].',
] as const;

/** Answers that answer: a gap noted in passing, or a negative that is the content. */
const ANSWERS = [
  'Segundo o texto, o ritmo não traz descanso [2].',
  'O ritmo não traz descanso.',
  'O acervo não traz datas, mas descreve o ciclo do ritmo em sete fases [1].',
  'Os cinco são descontinuidade, limite, movimento, espaço e tempo [5]. O acervo não traz mais nada sobre eles.',
  'O acervo traz os cinco princípios: descontinuidade, limite, movimento, espaço e tempo [5].',
  'Os cinco princípios universais são descontinuidade e limite [1].',
  'O mentalismo não nega a matéria: ele a explica como mente [2].',
  'A polaridade não é dualidade; os textos a descrevem como graus de uma coisa só [4].',
  'Hermes não deixou textos próprios, segundo o Caibalion [1].',
  'O Caibalion foi escrito pelos Três Iniciados [1].\n\nO acervo não diz quem eram eles.',
  'Não é possível transmutar fora do mesmo par, dizem os textos [3].',
  'A lei do ritmo não para: tudo flui e reflui [1].',
] as const;

describe('absenceIn (the auto-escalation safety net, ADR 0009)', () => {
  it.each(GIVES_UP)('goes deeper on: %s', (answer) => {
    expect(absenceIn(answer)).not.toBeNull();
  });

  it.each(ANSWERS)('keeps: %s', (answer) => {
    expect(absenceIn(answer)).toBeNull();
  });

  it('has enough real-style phrases on both sides', () => {
    expect(GIVES_UP.length).toBeGreaterThanOrEqual(20);
    expect(ANSWERS.length).toBeGreaterThanOrEqual(10);
  });
});
