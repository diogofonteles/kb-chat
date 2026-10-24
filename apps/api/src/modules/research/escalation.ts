import type { AnswerSource, ResearchStep } from '@kb-chat/contracts';

/** What a fast pass writes, alone, when the collection did not settle the question. */
export const DEEPEN_MARKER = '<<APROFUNDAR>>';

/** Who gives up in an absence sentence: the collection or its texts, never a subject of the question. */
const SUBJECT = '(?:o acervo|os textos|os documentos)';
const NONE_OF =
  '(?:nenhum (?:texto|documento)|nenhum dos (?:textos|documentos))';
const ABSENT_VERB =
  '(?:nomeia|nomeiam|traz|trazem|menciona|mencionam|lista|listam|revela|revelam|diz|dizem)';
const PLACE = '(?:n[oa]s? |d[oa]s? )(?:acervo|textos|documentos)';

/**
 * Sentences that give up on the collection ("O acervo não nomeia os cinco."): a fast
 * answer that opens like this goes on with the deep profile too, even without the marker
 * (safety net). The subject or the place is required, so a content sentence such as
 * "o ritmo não traz descanso" never matches.
 */
const ABSENCE: readonly RegExp[] = [
  new RegExp(`${SUBJECT}[^.\\n]{0,40}?\\bnão ${ABSENT_VERB}\\b`, 'iu'),
  new RegExp(`${NONE_OF}[^.\\n]{0,40}?\\b${ABSENT_VERB}\\b`, 'iu'),
  /\bnão (?:encontrei|localizei|achei)\b/iu,
  /\bnão há informaç/iu,
  new RegExp(`\\bnão (?:consta|constam|aparece|aparecem) ${PLACE}`, 'iu'),
];

const CITATION = /\[\d+\]/u;

/**
 * The first sentence of the answer's first paragraph that is not a heading: where an
 * answer that gives up says so. Later sentences may note a gap in an answer that answers.
 */
function openingSentence(answer: string): string {
  const paragraph =
    answer
      .split(/\n\s*\n/u)
      .map((p) => p.trim())
      .find((p) => p && !p.startsWith('#')) ?? '';
  return paragraph.split(/(?<=[.!?])\s/u)[0] ?? '';
}

/** The opening sentence when it gives up on the collection without citing it. */
function absenceIn(answer: string): string | null {
  const sentence = openingSentence(answer);
  if (CITATION.test(sentence)) return null;
  const found = ABSENCE.map((pattern) => pattern.exec(sentence)).find(Boolean);
  return found ? found[0] : null;
}

/** The marker taken out of a text the reader sees. */
export const withoutMarker = (text: string): string =>
  text.split(DEEPEN_MARKER).join('');

/** What the model wrote before the marker (its reason is not part of the conversation). */
export function beforeMarker(text: string): string {
  const at = text.indexOf(DEEPEN_MARKER);
  return at < 0 ? text : text.slice(0, at);
}

/** The step shown when the fast pass hands over to the deep one. */
export const DEEPEN_STEP: ResearchStep = {
  kind: 'deepen',
  text: 'Aprofundando a pesquisa…',
};

/** Why a fast answer must go deeper, or null when it is an answer. */
export function deepenReason(answer: string): string | null {
  const at = answer.indexOf(DEEPEN_MARKER);
  if (at >= 0) {
    const reason = answer.slice(at + DEEPEN_MARKER.length).trim();
    return reason.split('\n')[0]?.trim() || 'a pesquisa rápida não bastou';
  }
  const absence = absenceIn(answer);
  return absence ? `a resposta dizia “${absence}”` : null;
}

/** The fast prompt's rule when escalation is on (KBC-011, ADR 0009). */
export const DEEPEN_RULE = `- Se, depois de pesquisar, você não conseguir responder por completo com o acervo (não achou, a lista ficou incompleta ou ficou em dúvida), não escreva a resposta: escreva só uma linha com ${DEEPEN_MARKER} seguido de um motivo curto. Uma pesquisa mais funda continua a partir daí. Nunca diga ao leitor que o acervo não traz algo.`;

/**
 * How the deep pass starts over (both runners): it does its own literal search and does
 * not take the fast pass's conclusion for granted. Measured on the real vault: told the
 * fast pass's reason and steps, the deep model followed the same false lead.
 */
const START_OVER =
  'Não tome como certa a conclusão da pesquisa rápida. Faça a sua própria pesquisa: refaça find_text com a expressão da pergunta e as variantes, examine todos os trechos devolvidos e leia os documentos cujos trechos trazem a expressão, inclusive os que tratam de outro tema; muitas vezes um deles traz a lista ou o nome que os textos centrais não dão. Então responda por completo, citando [n].';

/** Said to the deep model when it takes over the same turn (in-API loop). */
export const deepenNote = (reason: string, steps: number): string =>
  `A pesquisa rápida não bastou (${reason}). Aprofunde agora: você tem mais ${steps} passos de ferramenta. ${START_OVER} Não peça outro aprofundamento.`;

export interface FastFindings {
  /** The documents the fast pass numbered. */
  readonly sources: readonly AnswerSource[];
}

/**
 * What a second CLI pass is told about the fast one (it cannot see its tool results): only
 * the documents already numbered, so [n] stays valid, and to start its research over.
 */
export function findingsText({ sources }: FastFindings): string {
  const found =
    sources.length > 0
      ? sources.map((s) => `- [${s.n}] ${s.title} (id: ${s.id})`)
      : ['- nenhum'];
  return [
    `Uma pesquisa rápida não achou a resposta completa. ${START_OVER}`,
    'Documentos já numerados nesta resposta (os números continuam valendo):',
    ...found,
  ].join('\n');
}
