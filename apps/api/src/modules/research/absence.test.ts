import { describe, expect, it } from 'vitest';
import { absenceIn } from './absence.js';

const FIVE = 'quais são os 5 princípios ocultos';
const RHYTHM = 'explique a lei do ritmo';

/** [answer, question]: answers that give up on the collection go deeper (ADR 0009). */
const GIVES_UP: readonly (readonly [string, string])[] = [
  // The two phrases QA got from the fast profile, verbatim.
  [
    'Os documentos do acervo não dizem quais são os cinco princípios ocultos. Eles de propósito não os nomeiam.',
    FIVE,
  ],
  ['Eles de propósito não os nomeiam.', FIVE],
  [
    'O acervo não nomeia os cinco princípios ocultos. Ele afirma que eles existem.',
    FIVE,
  ],
  ['O acervo não diz quais são os cinco princípios ocultos.', FIVE],
  ['Os textos do acervo não mencionam essa lista.', FIVE],
  [
    'Os textos não os listam: a Ordem prefere que o discípulo os descubra.',
    FIVE,
  ],
  ['Nenhum documento traz os nomes dos cinco princípios.', FIVE],
  ['Nenhum dos textos do acervo nomeia os cinco.', FIVE],
  ['Nenhuma das fontes consultadas revela a lista.', FIVE],
  ['Não há informações sobre isso no acervo.', FIVE],
  ['Não existe menção a esses nomes nos textos.', FIVE],
  ['Não encontrei a lista dos cinco princípios.', FIVE],
  ['Não a localizei em nenhum dos documentos.', FIVE],
  ['Essa lista não consta nos documentos do acervo.', FIVE],
  ['O nome desse princípio não aparece no acervo.', FIVE],
  ['O material disponível não especifica quais são os cinco.', FIVE],
  ['As fontes não detalham os cinco princípios ocultos.', FIVE],
  ['Os livros do acervo não explicam quais seriam.', FIVE],
  ['Nem os textos sobre a Ordem trazem a lista.', FIVE],
  ['Os documentos deliberadamente não revelam os cinco princípios.', FIVE],
  ['O acervo não lhes dá nomes.', FIVE],
  [
    '## Os cinco princípios ocultos\n\nO acervo não traz a lista completa.',
    FIVE,
  ],
  // Review, round 2: give-ups the first detector missed.
  ['O acervo não contém essa lista.', FIVE],
  ['Não foi possível encontrar os nomes nos textos.', FIVE],
  ['Os textos consultados não abordam isso.', FIVE],
  ['Essa informação não está no acervo.', FIVE],
  ['Não tenho dados sobre isso no acervo.', FIVE],
  ['O acervo não fala sobre isso.', FIVE],
  ['Os cinco princípios ocultos não são nomeados.', FIVE],
  ['Não há, nos documentos, uma lista dos cinco.', FIVE],
  ['Os documentos não dão os nomes.', FIVE],
  // More of the same kind.
  ['O acervo não traz uma resposta para isso.', FIVE],
  ['Nenhuma das fontes trata disso.', FIVE],
  ['Não consegui encontrar a lista no acervo.', FIVE],
  ['Os documentos não respondem quais são.', FIVE],
  ['Não existe, nos textos, nenhuma menção aos cinco.', FIVE],
  ['A lei do ritmo não é explicada nos textos do acervo.', RHYTHM],
  ['O acervo não explica a lei do ritmo.', RHYTHM],
];

/** Answers that answer: a gap noted after content, or a negation that is the content. */
const ANSWERS: readonly (readonly [string, string])[] = [
  ['Segundo o texto, o ritmo não traz descanso [2].', RHYTHM],
  ['O ritmo não traz descanso.', RHYTHM],
  [
    'O acervo não traz datas, mas descreve o ciclo do ritmo em sete fases [1].',
    RHYTHM,
  ],
  [
    'Os cinco são descontinuidade, limite, movimento, espaço e tempo [5]. O acervo não traz mais nada sobre eles.',
    FIVE,
  ],
  [
    'O acervo traz os cinco princípios: descontinuidade, limite, movimento, espaço e tempo [5].',
    FIVE,
  ],
  ['Os cinco princípios universais são descontinuidade e limite [1].', FIVE],
  [
    'O mentalismo não nega a matéria: ele a explica como mente [2].',
    'o que é o mentalismo',
  ],
  [
    'A polaridade não é dualidade; os textos a descrevem como graus de uma coisa só [4].',
    'o que é a polaridade',
  ],
  [
    'Hermes não deixou textos próprios, segundo o Caibalion [1].',
    'quem foi Hermes',
  ],
  [
    'O Caibalion foi escrito pelos Três Iniciados [1].\n\nO acervo não diz quem eram eles.',
    'quem escreveu o Caibalion',
  ],
  [
    'Não é possível transmutar fora do mesmo par, dizem os textos [3].',
    'como usar a polaridade',
  ],
  ['A lei do ritmo não para: tudo flui e reflui [1].', RHYTHM],
  // Review, round 2: content the first detector escalated.
  [
    'Segundo a tradição, o texto não traz descanso ao ritmo, explica o autor.',
    RHYTHM,
  ],
  ['O livro não apresenta datas; ele trata do ritmo em sete fases.', RHYTHM],
  [
    'O princípio do Ritmo diz que tudo flui. Os textos não citam datas.',
    RHYTHM,
  ],
  [
    'Os iniciados deliberadamente não escrevem os ensinamentos, para preservá-los [1].',
    'por que o hermetismo é secreto',
  ],
  [
    'Os cinco princípios ocultos são Descontinuidade, Movimento, Espaço, Tempo e Limite. Os textos centrais sobre o tema não dão os nomes.',
    FIVE,
  ],
  [
    'Os textos consultados não abordam a alquimia material, e sim a mental.',
    RHYTHM,
  ],
  // More of the same kind.
  [
    'O acervo não trata a polaridade como dualidade: ela é um só eixo [2].',
    'o que é a polaridade',
  ],
  ['Os textos não falam de datas, e sim de ciclos.', RHYTHM],
  [
    'A alquimia não é química; os textos a tratam como transmutação mental.',
    'o que é alquimia',
  ],
  ['Os documentos não contêm erros de tradução relevantes.', FIVE],
  ['Hermes não é uma pessoa histórica para o autor.', 'quem foi Hermes'],
  [
    'O Caibalion não traz o nome dos autores, que assinam como Três Iniciados [1].',
    'quem escreveu o Caibalion',
  ],
  [
    'Os livros não apresentam o ritmo como castigo, mas como lei natural.',
    RHYTHM,
  ],
];

describe('absenceIn (the auto-escalation backstop, ADR 0009)', () => {
  it.each(GIVES_UP)('goes deeper on: %s', (answer, question) => {
    expect(absenceIn(answer, question)).not.toBeNull();
  });

  it.each(ANSWERS)('keeps: %s', (answer, question) => {
    expect(absenceIn(answer, question)).toBeNull();
  });

  it('has the reviewer phrases plus enough of its own on both sides', () => {
    expect(GIVES_UP.length).toBeGreaterThanOrEqual(30);
    expect(ANSWERS.length).toBeGreaterThanOrEqual(20);
  });
});
