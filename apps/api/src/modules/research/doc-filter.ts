import type { Authorship } from '@kb-chat/contracts';
import type { CatalogEntry, CatalogRegistry } from '../catalog/index.js';
import { refNumber, resolveEntry, type ToolContext } from './tool-context.js';
import {
  AUTHORSHIP_LABELS,
  foldName,
  quote,
  type AuthorshipLabels,
} from './tool-output.js';

/** Which documents a find_text or search_collection call looks at (KBC-017, ADR 0013). */
export interface DocFilter {
  /** One authorship group (KBC-020). */
  readonly authorship?: Authorship;
  /** A fragment of one of the document's kb entities (author, person, work). */
  readonly entity?: string;
  /** A fragment of the document's source_path (its origin folder). */
  readonly source?: string;
  /** Documents left out: ids (already resolved from [n]) and text fragments. */
  readonly excludeIds?: ReadonlySet<string>;
  readonly excludeTexts?: readonly string[];
  /** Subject names as the catalog spells them. */
  readonly subjects?: readonly string[];
}

const PIPELINE_PREFIXES = /^(?:_convert\/)?(?:ready\/)?/;

/**
 * The folder a document came from, as the agent sees it: the source_path folder without
 * the conversion pipeline's own prefixes ("Temas-docs", "dropbox/Livros"); a document
 * without one (a wiki concept) shows the folder of its id.
 */
export function originFolder(entry: CatalogEntry): string {
  const path = entry.sourcePath ?? entry.id;
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  return folder.replace(PIPELINE_PREFIXES, '') || folder || '.';
}

const hasFragment = (values: readonly string[], fragment: string): boolean => {
  const needle = foldName(fragment);
  return values.some((value) => foldName(value).includes(needle));
};

/**
 * An exclusion text leaves out a document whose origin contains it or that names it as
 * one of its entities exactly: a document that merely mentions a name among many stays.
 */
const matchesText = (entry: CatalogEntry, text: string): boolean =>
  hasFragment([entry.sourcePath ?? ''], text) ||
  entry.entities.some((name) => foldName(name) === foldName(text));

function isExcluded(entry: CatalogEntry, filter: DocFilter): boolean {
  if (filter.excludeIds?.has(entry.id)) return true;
  return (filter.excludeTexts ?? []).some((text) => matchesText(entry, text));
}

function hasSubject(entry: CatalogEntry, subjects: readonly string[]): boolean {
  if (subjects.length === 0) return true;
  const wanted = new Set(subjects.map(foldName));
  return entry.concepts.some((concept) => wanted.has(foldName(concept)));
}

/** Whether a document passes the filter. */
export function acceptsEntry(filter: DocFilter, entry: CatalogEntry): boolean {
  if (filter.authorship && entry.authorship !== filter.authorship) return false;
  if (filter.entity && !hasFragment(entry.entities, filter.entity))
    return false;
  if (filter.source && !hasFragment([entry.sourcePath ?? ''], filter.source))
    return false;
  return hasSubject(entry, filter.subjects ?? []) && !isExcluded(entry, filter);
}

/** True when the filter narrows anything. */
export const isFiltering = (filter: DocFilter): boolean =>
  Boolean(filter.authorship || filter.entity || filter.source) ||
  (filter.excludeIds?.size ?? 0) > 0 ||
  (filter.excludeTexts?.length ?? 0) > 0 ||
  (filter.subjects?.length ?? 0) > 0;

/** The filter in words, for the first line of a tool output; empty without one. */
export function describeFilter(
  filter: DocFilter,
  labels: AuthorshipLabels = AUTHORSHIP_LABELS,
): string {
  const excluded =
    (filter.excludeIds?.size ?? 0) + (filter.excludeTexts?.length ?? 0);
  return [
    filter.authorship && `autoria: ${labels[filter.authorship]}`,
    filter.entity && `entidade contém ${quote(filter.entity)}`,
    filter.source && `origem contém ${quote(filter.source)}`,
    filter.subjects?.length && `assuntos: ${filter.subjects.join(', ')}`,
    excluded > 0 && `${excluded} exclusão(ões)`,
  ]
    .filter(Boolean)
    .join('; ');
}

/** The filter arguments of a tool call, as the model sends them. */
export interface FilterArgs {
  readonly authorship?: Authorship;
  readonly entity?: string;
  readonly source?: string;
  readonly exclude?: readonly (string | number)[];
  readonly subjects?: readonly string[];
}

/**
 * The call's filter: each `exclude` item that names a document ([n] or id) leaves that
 * document out; any other text leaves out documents whose origin or entities contain it.
 */
export function toFilter(
  catalog: CatalogRegistry,
  args: FilterArgs,
  context: ToolContext,
): DocFilter {
  const excludeIds = new Set<string>();
  const excludeTexts: string[] = [];
  for (const ref of args.exclude ?? []) {
    const entry = resolveEntry(catalog, ref, context);
    if (entry) excludeIds.add(entry.id);
    else if (typeof ref === 'string' && refNumber(ref) === null)
      excludeTexts.push(ref);
  }
  return {
    authorship: args.authorship,
    entity: args.entity,
    source: args.source,
    subjects: args.subjects ?? [],
    excludeIds,
    excludeTexts,
  };
}
