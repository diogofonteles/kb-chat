import type { WebSearchKind } from '@kb-chat/contracts';
import type { AuthorProblem } from './web-search-form.js';

export const KIND_LABELS: Record<WebSearchKind, () => string> = {
  text: () => $localize`:@@webSearch.text:Texto`,
  audio: () => $localize`:@@webSearch.audio:Áudio`,
  video: () => $localize`:@@webSearch.video:Vídeo`,
};

export const AUTHOR_PROBLEMS: Record<AuthorProblem, () => string> = {
  short: () =>
    $localize`:@@webSearch.authorShort:Escreva o nome do autor, com pelo menos 2 letras.`,
  repeated: () =>
    $localize`:@@webSearch.authorRepeated:Este autor já está na lista.`,
  full: () =>
    $localize`:@@webSearch.authorsFull:Já são 5 autores, o máximo. Remova um para incluir outro.`,
};

/** "Faz até 6 consultas no Firecrawl." */
export const callsLabel = (calls: number): string =>
  calls === 1
    ? $localize`:@@webSearch.callsOne:Faz 1 consulta no Firecrawl.`
    : $localize`:@@webSearch.calls:Faz até ${calls}:count: consultas no Firecrawl.`;

/** "Incluir 3 selecionados". */
export function includeLabel(selected: number): string {
  if (selected === 0)
    return $localize`:@@webSearch.includeNone:Incluir selecionados`;
  return selected === 1
    ? $localize`:@@webSearch.includeOne:Incluir 1 selecionado`
    : $localize`:@@webSearch.include:Incluir ${selected}:count: selecionados`;
}

/** "12 resultados, 3 já estão no acervo". */
export function countLabel(total: number, selectable: number): string {
  const found =
    total === 1
      ? $localize`:@@webSearch.countOne:1 resultado`
      : $localize`:@@webSearch.count:${total}:count: resultados`;
  const there = total - selectable;
  if (there === 0) return found;
  return there === 1
    ? $localize`:@@webSearch.countThereOne:${found}:found:, 1 já está no acervo`
    : $localize`:@@webSearch.countThere:${found}:found:, ${there}:there: já estão no acervo`;
}

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
