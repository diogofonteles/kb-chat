import type { BulkLevelResult } from '@kb-chat/contracts';

/**
 * What a bulk level did, in words, for T24 and "Mudar nível" on a search (KBC-107, R2-4,
 * R2-8): "N documentos foram para CI." and, when some were left as they were, how many.
 */
export function bulkResultText(result: BulkLevelResult): string {
  const { updated, skipped } = result;
  const code = result.level.code;
  const done =
    updated === 1
      ? $localize`:@@bulkLevel.doneOne:1 documento foi para ${code}:code:.`
      : $localize`:@@bulkLevel.done:${updated}:count: documentos foram para ${code}:code:.`;
  if (skipped === 0) return done;
  const left =
    skipped === 1
      ? $localize`:@@bulkLevel.skippedOne:1 não pôde ser classificado.`
      : $localize`:@@bulkLevel.skipped:${skipped}:count: não puderam ser classificados.`;
  return `${done} ${left}`;
}
