import type { AnswerSource, ResearchStep } from '@kb-chat/contracts';

/** What a fast pass writes, alone, when the collection did not settle the question. */
export const DEEPEN_MARKER = '<<APROFUNDAR>>';

/**
 * Answers that give up on the collection ("o acervo não nomeia…"): a fast answer like
 * this goes on with the deep profile too, even without the marker (safety net).
 */
const ABSENCE =
  /\bnão (?:nomeia|nomeiam|encontrei|traz|trazem|há informaç\p{L}*)/iu;

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
  const absence = ABSENCE.exec(answer);
  return absence ? `a resposta dizia “${absence[0]}”` : null;
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
  `A pesquisa rápida não bastou (${reason}). Aprofunde agora: você tem mais ${steps} passos de ferramenta. ${START_OVER} Não escreva ${DEEPEN_MARKER}.`;

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
