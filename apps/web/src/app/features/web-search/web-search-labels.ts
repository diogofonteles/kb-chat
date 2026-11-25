import type { WebSearchKind, WebSearchResponse } from '@kb-chat/contracts';
import type { AuthorProblem } from './web-search-form.js';

export const KIND_LABELS: Record<WebSearchKind, () => string> = {
  text: () => $localize`:@@webSearch.text:Texto`,
  audio: () => $localize`:@@webSearch.audio:Áudio`,
  video: () => $localize`:@@webSearch.video:Vídeo`,
};

export const AUTHOR_PROBLEMS: Record<AuthorProblem, () => string> = {
  short: () =>
    $localize`:@@webSearch.authorShort:Escreva o nome do autor, com pelo menos 2 letras.`,
  long: () =>
    $localize`:@@webSearch.authorLong:Um nome tem até 80 letras. Separe os autores por vírgula.`,
  repeated: () =>
    $localize`:@@webSearch.authorRepeated:Este autor já está na lista.`,
  full: () =>
    $localize`:@@webSearch.authorsFull:Já são 50 autores. Remova um para incluir outro.`,
};

/** "Cerca de 24 créditos do Firecrawl.": masters, who see the balance. */
export const creditsEstimate = (credits: number): string =>
  $localize`:@@webSearch.estimate:Cerca de ${credits}:count: créditos do Firecrawl.`;

/** "30 resultados." */
export const countLabel = (total: number): string =>
  total === 1
    ? $localize`:@@webSearch.countOne:1 resultado`
    : $localize`:@@webSearch.count:${total}:count: resultados`;

/** "Procurando… 12 de 30." */
export const progressLabel = (found: number, wanted: number): string =>
  $localize`:@@webSearch.progress:Procurando… ${found}:found: de ${wanted}:wanted:.`;

const alreadyLabel = (n: number): string =>
  n === 1
    ? $localize`:@@webSearch.leftAlreadyOne:1 que já está no acervo`
    : $localize`:@@webSearch.leftAlready:${n}:count: que já estão no acervo`;

const seenLabel = (n: number): string =>
  n === 1
    ? $localize`:@@webSearch.leftSeenOne:1 que já apareceu antes`
    : $localize`:@@webSearch.leftSeen:${n}:count: que já apareceram antes`;

/** "Ficaram de fora: 4 que já estão no acervo e 9 que já apareceram antes." */
export function skippedLabel({
  already,
  seen,
}: WebSearchResponse['skipped']): string {
  const parts = [
    ...(already > 0 ? [alreadyLabel(already)] : []),
    ...(seen > 0 ? [seenLabel(seen)] : []),
  ];
  if (parts.length === 0) return '';
  const list = parts.join($localize`:@@webSearch.and: e `);
  return $localize`:@@webSearch.left:Ficaram de fora: ${list}:list:.`;
}

/** "Buscar mais 30". */
export const moreLabel = (sources: number): string =>
  $localize`:@@webSearch.more:Buscar mais ${sources}:count:`;

/** What a search cost and left, for masters: "Usou 6 créditos. Restam 994." */
export function creditsLabel(used: number, remaining: string | null): string {
  const spent =
    used === 1
      ? $localize`:@@webSearch.creditsUsedOne:Usou 1 crédito.`
      : $localize`:@@webSearch.creditsUsed:Usou ${used}:count: créditos.`;
  return remaining === null
    ? spent
    : $localize`:@@webSearch.creditsLeft:${spent}:spent: Restam ${remaining}:count:.`;
}
