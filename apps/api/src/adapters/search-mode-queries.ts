import type { SearchMode } from '@kb-chat/contracts';

export interface TypedSearch {
  readonly type: 'lex' | 'vec';
  readonly query: string;
}

/** UI mode → QMD typed sub-queries; "all" fuses both without LLM expansion (ADR 0002). */
export function toTypedSearches(mode: SearchMode, q: string): TypedSearch[] {
  const byMode: Record<SearchMode, TypedSearch[]> = {
    exact: [{ type: 'lex', query: q }],
    semantic: [{ type: 'vec', query: q }],
    all: [
      { type: 'lex', query: q },
      { type: 'vec', query: q },
    ],
  };
  return byMode[mode];
}

/** QMD reports "<collection>/<topic-relative path>"; kb search prefixes "qmd://". */
export function toTopicRelativeId(file: string, collection: string): string {
  const withoutScheme = file.replace(/^qmd:\/\//, '');
  const prefix = `${collection}/`;
  return withoutScheme.startsWith(prefix)
    ? withoutScheme.slice(prefix.length)
    : withoutScheme;
}
