import type { SearchResponse } from '@kb-chat/contracts';

/** "3 documentos", "10 de 26 documentos" or "10 de 50+ documentos" (the index candidate cap). */
export function describeResultCount(
  response: Pick<SearchResponse, 'items' | 'total' | 'capped'>,
): string {
  const shown = response.items.length;
  const total = response.capped ? `${response.total}+` : String(response.total);
  if (shown === response.total && !response.capped) {
    return shown === 1
      ? $localize`:@@count.one:1 documento`
      : $localize`:@@count.many:${shown}:shown: documentos`;
  }
  return $localize`:@@count.page:${shown}:shown: de ${total}:total: documentos`;
}

/** Short text for the screen-reader live region after each answer. */
export function describeForAnnouncement(
  response: Pick<SearchResponse, 'items' | 'total' | 'capped'>,
): string {
  if (response.items.length === 0)
    return $localize`:@@announce.none:Nenhum documento encontrado.`;
  if (response.total === 1)
    return $localize`:@@announce.one:1 documento encontrado.`;
  return $localize`:@@announce.found:${describeResultCount(response)}:count: encontrados.`;
}
