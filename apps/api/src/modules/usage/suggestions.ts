import { MAX_SUGGESTIONS, type SuggestionList } from '@kb-chat/contracts';
import type { CatalogEntry } from '../catalog/index.js';

const collator = new Intl.Collator('pt-BR');

/** The subjects with the most documents, ties in alphabetical order (KBC-006 BR-1). */
export function topSuggestions(
  entries: Iterable<CatalogEntry>,
  limit = MAX_SUGGESTIONS,
): SuggestionList {
  const counts = new Map<string, number>();
  for (const entry of entries)
    for (const concept of entry.concepts)
      counts.set(concept, (counts.get(concept) ?? 0) + 1);
  const items = [...counts]
    .map(([concept, count]) => ({ concept, count }))
    .sort((a, b) => b.count - a.count || collator.compare(a.concept, b.concept))
    .slice(0, limit);
  return { items };
}
