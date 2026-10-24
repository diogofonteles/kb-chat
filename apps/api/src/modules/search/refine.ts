import {
  DEPTH_LEVELS,
  GENRES,
  RELEVANCES,
  type DocumentFacets,
  type ResultFacets,
  type SearchFilters,
} from '@kb-chat/contracts';
import type { IndexHit } from '../../ports/search-index.js';
import type { CatalogEntry } from '../catalog/index.js';

export interface Candidate {
  readonly hit: IndexHit;
  readonly entry: CatalogEntry;
}

/** One result card: the best-ranked document and its near-identical copies. */
export interface CopyGroup {
  readonly lead: Candidate;
  readonly copies: readonly CatalogEntry[];
}

type FacetKey = keyof SearchFilters;

export interface RefineOptions {
  readonly filters: SearchFilters;
  readonly offset: number;
  readonly limit: number;
  readonly maxResults: number;
}

export interface RefinedPage {
  readonly page: readonly CopyGroup[];
  readonly total: number;
  readonly nextOffset: number | null;
  readonly hiddenOffTopic: number;
  readonly facets: ResultFacets;
}

/** "A  Natureza Sétupla" and "a natureza setupla" share one key (KBC-002 BR-4). */
export const copyKey = (title: string): string =>
  title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** Groups candidates by normalized title, keeping the index order of the best member. */
export function groupCopies(candidates: readonly Candidate[]): CopyGroup[] {
  const groups = new Map<string, { lead: Candidate; copies: CatalogEntry[] }>();
  for (const candidate of candidates) {
    const key = copyKey(candidate.entry.title);
    const group = groups.get(key);
    if (group) group.copies.push(candidate.entry);
    else groups.set(key, { lead: candidate, copies: [] });
  }
  return [...groups.values()];
}

const FACET_TESTS: Record<
  FacetKey,
  (facets: DocumentFacets, filters: SearchFilters) => boolean
> = {
  concepts: (f, s) =>
    s.concepts.length === 0 || f.concepts.some((c) => s.concepts.includes(c)),
  genres: (f, s) =>
    s.genres.length === 0 || (f.genre !== null && s.genres.includes(f.genre)),
  depths: (f, s) =>
    s.depths.length === 0 || (f.depth !== null && s.depths.includes(f.depth)),
  relevances: (f, s) => {
    if (s.relevances.length > 0)
      return f.relevance !== null && s.relevances.includes(f.relevance);
    // Off-topic stays hidden unless explicitly selected (KBC-002 BR-2).
    return f.relevance !== 'off_topic';
  },
};
const FACET_KEYS = Object.keys(FACET_TESTS) as FacetKey[];

function matchesExcept(
  facets: DocumentFacets,
  filters: SearchFilters,
  except?: FacetKey,
): boolean {
  return FACET_KEYS.every(
    (key) => key === except || FACET_TESTS[key](facets, filters),
  );
}

function countBy<T>(
  values: readonly T[],
  order?: readonly T[],
): { value: T; count: number }[] {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const entries = [...counts.entries()].map(([value, count]) => ({
    value,
    count,
  }));
  if (order)
    return entries.sort(
      (a, b) => order.indexOf(a.value) - order.indexOf(b.value),
    );
  return entries.sort(
    (a, b) =>
      b.count - a.count || String(a.value).localeCompare(String(b.value)),
  );
}

const nonNull = <T>(value: T | null): value is T => value !== null;

/** Facet counts over any list of documents (each facet ignores its own selection when filtered). */
export function countFacets(
  pick: (key: FacetKey) => readonly DocumentFacets[],
): ResultFacets {
  return {
    concepts: countBy(pick('concepts').flatMap((f) => f.concepts)),
    genres: countBy(
      pick('genres')
        .map((f) => f.genre)
        .filter(nonNull),
      GENRES,
    ),
    depths: countBy(
      pick('depths')
        .map((f) => f.depth)
        .filter(nonNull),
      DEPTH_LEVELS,
    ),
    relevances: countBy(
      pick('relevances')
        .map((f) => f.relevance)
        .filter(nonNull),
      RELEVANCES,
    ),
  };
}

/** Filters, counts and pages the copy groups of one search (ADR 0003). */
export function refine(
  groups: readonly CopyGroup[],
  options: RefineOptions,
): RefinedPage {
  const { filters, offset, limit, maxResults } = options;
  const leads = groups.map((group) => group.lead.entry);
  const visible = groups.filter((group) =>
    matchesExcept(group.lead.entry, filters),
  );
  const facets = countFacets((key) =>
    leads.filter((lead) => matchesExcept(lead, filters, key)),
  );
  const showsOffTopic = filters.relevances.includes('off_topic');
  const hiddenOffTopic = showsOffTopic
    ? 0
    : leads.filter(
        (lead) =>
          lead.relevance === 'off_topic' &&
          matchesExcept(lead, filters, 'relevances'),
      ).length;
  const reachable = Math.min(visible.length, maxResults);
  const end = Math.min(offset + limit, reachable);
  return {
    page: visible.slice(offset, end),
    total: visible.length,
    nextOffset: end < reachable ? end : null,
    hiddenOffTopic,
    facets,
  };
}
