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

/** Said to the deep model when it takes over the same turn (in-API loop). */
export const deepenNote = (reason: string, steps: number): string =>
  `A pesquisa rápida não bastou (${reason}). Aprofunde agora: você tem mais ${steps} passos de ferramenta. Procure com find_text as variantes que faltaram, leia os documentos mais promissores (inclusive os que só apareceram nos trechos) e então responda por completo, citando [n]. Não escreva ${DEEPEN_MARKER}.`;

export interface FastFindings {
  readonly reason: string;
  readonly steps: readonly string[];
  readonly sources: readonly AnswerSource[];
}

/** What a second CLI pass is told about the fast one (it cannot see its tool results). */
export function findingsText({ reason, steps, sources }: FastFindings): string {
  const done = steps.length > 0 ? steps.map((s) => `- ${s}`) : ['- nenhum'];
  const found =
    sources.length > 0
      ? sources.map((s) => `- [${s.n}] ${s.title} (id: ${s.id})`)
      : ['- nenhum'];
  return [
    `Uma pesquisa rápida já foi feita e não bastou (${reason}). Aprofunde a partir dela: procure com find_text as variantes que faltaram, leia os documentos mais promissores e responda por completo, citando [n]. Os números abaixo continuam valendo nesta resposta.`,
    'Passos já feitos:',
    ...done,
    'Documentos já numerados:',
    ...found,
  ].join('\n');
}
