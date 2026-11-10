import type { MainAuthorIdentity } from './prompt.js';
import type { ResearchStep, SearchHit } from '@kb-chat/contracts';
import { MAX_RESULTS } from '@kb-chat/contracts';
import type { z } from 'zod';
import { AppError } from '../../app-error.js';
import type { ToolCall, ToolDefinition } from '../../ports/llm.js';
import type { VaultReaderPort } from '../../ports/vault-reader.js';
import {
  splitFrontmatter,
  type CatalogEntry,
  type CatalogRegistry,
} from '../catalog/index.js';
import type { SearchService } from '../search/index.js';
import {
  firstMatchIn,
  windowOf,
  type BodyWindow,
  type WindowRequest,
} from './body-window.js';
import { anchorAt, anchorsIn } from '@kb-chat/contracts';
import {
  acceptsEntry,
  describeFilter,
  isFiltering,
  toFilter,
  type DocFilter,
} from './doc-filter.js';
import { GrepTool } from './grep-tool.js';
import { SourcesTool } from './sources-tool.js';
import { SweepPlanner } from './sweep/sweep-planner.js';
import { TextFinder } from './text-finder.js';
import {
  failed,
  isVisible,
  notFound,
  parsedArgs,
  resolveEntry,
  type PreparedCall,
  type ToolContext,
} from './tool-context.js';
import {
  authorshipLabels,
  foldName,
  headerLines,
  hitLine,
  quote,
  refLine,
  windowLines,
  type AuthorshipLabels,
} from './tool-output.js';
import {
  BATCH_WINDOW_CHARS,
  TOOL_DEFINITIONS,
  readArgsSchema,
  readManyArgsSchema,
  relatedArgsSchema,
  searchArgsSchema,
  subjectsArgsSchema,
  type ToolName,
} from './tool-schemas.js';

export type { PreparedCall, ToolContext } from './tool-context.js';

const MAX_SUBJECTS = 60;
const MAX_REFS_PER_GROUP = 10;

export interface ResearchToolsDeps {
  readonly search: SearchService;
  readonly catalog: CatalogRegistry;
  readonly vault: VaultReaderPort;
  /** The collection's main author's name (KBC-049); without it, the legacy "Mestre Laércio". */
  readonly mainAuthorOf?: (topic: string) => MainAuthorIdentity | null;
}

type Handler = (args: unknown, context: ToolContext) => PreparedCall;
type ReadManyArgs = z.output<typeof readManyArgsSchema>;
type SearchArgs = z.output<typeof searchArgsSchema>;

/** "“ritmo” (modo all; assuntos: X; entidade contém “y”)" for the search's first line. */
function searchScope(
  args: SearchArgs,
  {
    concepts,
    filter,
    labels,
  }: {
    readonly concepts: readonly string[];
    readonly filter: DocFilter;
    readonly labels?: AuthorshipLabels | undefined;
  },
): string {
  const parts = [
    `modo ${args.mode}`,
    concepts.length > 0 && `assuntos: ${concepts.join(', ')}`,
    describeFilter(filter, labels),
  ].filter(Boolean);
  return `${quote(args.query)} (${parts.join('; ')})`;
}

function noHits(scope: string, offset: number): string {
  const from = offset > 0 ? ` a partir do ${offset + 1}º` : '';
  return `Nenhum documento encontrado para ${scope}${from}. Tente sinônimos, termos mais gerais ou mais específicos, outro modo (semantic/exact), list_subjects, ou find_text para varrer o acervo inteiro.`;
}

/** "11–14 de 14 documento(s) entre 31 candidatos da busca por sentido." and the next page. */
function searchRange(
  args: SearchArgs,
  {
    shown,
    total,
    candidates,
  }: { shown: number; total: number; candidates: number },
): string {
  const next = args.offset + shown;
  const more = next < total ? ` Próxima página: offset=${next}.` : '';
  return `${args.offset + 1}–${next} de ${total} documento(s) entre ${candidates} candidatos da busca por sentido.${more}`;
}

const RELATION_LABELS = {
  exampleOf: 'É exemplo de',
  extends: 'Estende',
  related: 'Relacionado a',
  examples: 'Exemplos',
  extendedBy: 'Estendido por',
  relatedFrom: 'Citado como relacionado por',
} as const;

/** A hit without its catalog entry: a text as the source book numbers it. */
const textRef = ({ id, title, authorship, author }: SearchHit) => ({
  id,
  title,
  authorship,
  author,
});

const readStep = (entry: CatalogEntry): ResearchStep => ({
  kind: 'read',
  text: `Lendo ${quote(entry.title)}`,
  document: entry.id,
});

function parseArguments(raw: string): unknown {
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return null;
  }
}

function describeFailure(err: unknown): string {
  const code = err instanceof AppError ? err.code : 'INTERNAL';
  return `A ferramenta falhou (${code}). Tente de novo ou use outra ferramenta.`;
}

/**
 * A track's window shown to the model (KBC-099 BR-5): its anchors may be cited; the passage
 * it is about is the paragraph of the first match of `around`, or of the window's start.
 */
function showWindow(
  book: ToolContext['book'],
  n: number,
  input: { body: string; window: BodyWindow; around: string | undefined },
): void {
  const { body, window, around } = input;
  const opening = anchorAt(body, window.start);
  const match = around ? firstMatchIn(body, around, window) : null;
  const focus =
    anchorAt(body, match ?? window.start) ?? anchorsIn(window.text)[0] ?? null;
  book.showTrack(n, {
    anchors: [
      ...(opening === null ? [] : [opening]),
      ...anchorsIn(window.text),
    ],
    focus,
  });
}

/**
 * The research agent's tools over the kb index, summaries and relations (ADR 0006).
 * Read-only: nothing here writes to the vault. Document text goes back fenced as data.
 */
export class ResearchTools {
  readonly definitions: readonly ToolDefinition[] = TOOL_DEFINITIONS;
  private readonly handlers: Record<ToolName, Handler> = {
    search_collection: (args, context) => this.searchCall(args, context),
    find_text: (args, context) => this.grep.prepare(args, context),
    list_subjects: (args, context) => this.subjectsCall(args, context),
    list_sources: (args, context) => this.sources.prepare(args, context),
    read_document: (args, context) => this.readCall(args, context),
    read_documents: (args, context) => this.readManyCall(args, context),
    related_documents: (args, context) => this.relatedCall(args, context),
  };

  /** The exhaustive sweep's set and batches, over the same find_text cache (KBC-030). */
  readonly sweeps: SweepPlanner;
  private readonly finder: TextFinder;
  private readonly grep: GrepTool;
  private readonly sources: SourcesTool;

  constructor(private readonly deps: ResearchToolsDeps) {
    this.finder = new TextFinder(deps);
    this.sweeps = new SweepPlanner({ ...deps, finder: this.finder });
    this.grep = new GrepTool({ finder: this.finder, catalog: deps.catalog });
    this.sources = new SourcesTool(deps.catalog);
  }

  /** Builds the topic's find_text cache ahead of the first call (it takes seconds on a big vault). */
  warm(topic: string): Promise<void> {
    return this.finder.warm(topic);
  }

  /** The topic's display title, or null when the topic does not exist. */
  topicTitle(topic: string): string | null {
    return this.deps.catalog.get(topic)?.topic.title ?? null;
  }

  /** The collection's main author (KBC-049 BR-2), or null when it has none. */
  mainAuthor(topic: string): MainAuthorIdentity | null {
    return this.deps.mainAuthorOf?.(topic) ?? null;
  }

  prepare(call: ToolCall, context: ToolContext): PreparedCall {
    const handler = this.handlers[call.name as ToolName] as Handler | undefined;
    if (!handler) return failed(`Ferramenta desconhecida: ${call.name}.`);
    const labels = authorshipLabels(this.mainAuthor(context.topic));
    const prepared = handler(parseArguments(call.arguments), {
      ...context,
      labels,
    });
    return {
      steps: prepared.steps,
      run: () => prepared.run().catch(describeFailure),
    };
  }

  private searchCall(args: unknown, context: ToolContext): PreparedCall {
    const parsed = parsedArgs(searchArgsSchema, args);
    if (typeof parsed === 'string') return failed(parsed);
    return {
      steps: [{ kind: 'search', text: `Buscando ${quote(parsed.query)}` }],
      run: () => this.runSearch(parsed, context),
    };
  }

  /** search_collection's output: the scope, the page range and one line per hit. */
  private async runSearch(
    args: SearchArgs,
    context: ToolContext,
  ): Promise<string> {
    const { topic } = context;
    const concepts = this.knownSubjects(context, args.subjects ?? []);
    const filter = toFilter(
      this.deps.catalog,
      { ...args, subjects: [] },
      context,
    );
    const found = await this.filteredSearch(args, {
      topic,
      concepts,
      filter,
      context,
    });
    const scope = searchScope(args, {
      concepts,
      filter,
      labels: context.labels,
    });
    if (found.shown.length === 0) return noHits(scope, args.offset);
    const range = searchRange(args, { ...found, shown: found.shown.length });
    return [
      `Busca ${scope}: ${range}`,
      ...found.shown.map((hit) => this.hitOf(hit, context)),
    ].join('\n');
  }

  /** One hit, numbered with its catalog entry so a track keeps its media (KBC-099). */
  private hitOf(hit: SearchHit, { topic, book, labels }: ToolContext): string {
    const entry = this.hitEntry(topic, hit);
    const n = book.number(entry ?? textRef(hit));
    if (entry?.media) {
      const anchors = anchorsIn(hit.snippet ?? '');
      book.showTrack(n, { anchors, focus: anchors[0] ?? null });
    }
    return hitLine(n, hit, {
      summary: entry?.summary ?? null,
      media: entry?.media ?? null,
      labels,
    });
  }

  /**
   * The meaning search, then (KBC-017) the entity/origin/exclusion filters over its
   * candidates: with a filter, all of them are fetched and filtered here, then paged.
   */
  private async filteredSearch(
    args: SearchArgs,
    scope: {
      topic: string;
      concepts: string[];
      filter: DocFilter;
      context: ToolContext;
    },
  ): Promise<{ shown: SearchHit[]; total: number; candidates: number }> {
    const filtering = isFiltering(scope.filter);
    const response = await this.searchPage(args, { ...scope, filtering });
    // Only the first MAX_RESULTS candidates can be paged to (the search's own cap).
    if (!filtering)
      return {
        shown: response.items,
        total: Math.min(response.total, MAX_RESULTS),
        candidates: response.total,
      };
    const kept = response.items.filter((hit) =>
      this.accepts(scope.topic, hit, scope.filter),
    );
    return {
      shown: kept.slice(args.offset, args.offset + args.limit),
      total: kept.length,
      candidates: response.total,
    };
  }

  /** One page of the meaning search, or all its candidates when the tools filter them. */
  private searchPage(
    args: SearchArgs,
    scope: {
      topic: string;
      concepts: string[];
      filter: DocFilter;
      context: ToolContext;
      filtering: boolean;
    },
  ) {
    const { authorship } = scope.filter;
    return this.deps.search.search(
      scope.topic,
      {
        q: args.query,
        mode: args.mode,
        limit: scope.filtering ? MAX_RESULTS : args.limit,
        offset: scope.filtering ? 0 : args.offset,
        filters: {
          concepts: scope.concepts,
          authorships: authorship ? [authorship] : [],
        },
      },
      // The tracks this person may research, among the texts (KBC-099 BR-4), at or below
      // their level (KBC-104 BR-1).
      { tracks: scope.context.tracks, view: scope.context.view },
    );
  }

  private accepts(topic: string, hit: SearchHit, filter: DocFilter): boolean {
    const entry = this.hitEntry(topic, hit);
    return entry !== null && acceptsEntry(filter, entry);
  }

  /** Subject names as the catalog spells them (the model may change accents or case). */
  private knownSubjects(
    { topic, view }: ToolContext,
    subjects: readonly string[],
  ): string[] {
    if (subjects.length === 0) return [];
    const known = new Map(
      this.deps.search
        .topicFacets(topic, { view })
        .concepts.map(({ value }) => [foldName(value), value]),
    );
    return subjects.map((name) => known.get(foldName(name)) ?? name);
  }

  private subjectsCall(args: unknown, context: ToolContext): PreparedCall {
    const parsed = parsedArgs(subjectsArgsSchema, args);
    if (typeof parsed === 'string') return failed(parsed);
    const text = parsed.query
      ? `Listando os assuntos sobre ${quote(parsed.query)}`
      : 'Listando os assuntos';
    return {
      steps: [{ kind: 'subjects', text }],
      run: async () => this.listSubjects(context, parsed.query),
    };
  }

  /** The subjects of the documents the person may see, counted over those only (BR-1). */
  private listSubjects(
    { topic, view }: ToolContext,
    query: string | undefined,
  ): string {
    const needle = query ? foldName(query) : '';
    const subjects = this.deps.search
      .topicFacets(topic, { view })
      .concepts.filter(({ value }) => foldName(value).includes(needle))
      .sort((a, b) => b.count - a.count);
    if (subjects.length === 0)
      return `Nenhum assunto encontrado${query ? ` com ${quote(query)}` : ''}.`;
    const shown = subjects.slice(0, MAX_SUBJECTS);
    return [
      `Assuntos (${shown.length} de ${subjects.length}):`,
      ...shown.map(({ value, count }) => `- ${value} (${count} documento(s))`),
    ].join('\n');
  }

  private readCall(args: unknown, context: ToolContext): PreparedCall {
    const parsed = parsedArgs(readArgsSchema, args);
    if (typeof parsed === 'string') return failed(parsed);
    const entry = this.resolve(parsed.document, context);
    if (!entry) return failed(notFound(parsed.document));
    return {
      steps: [readStep(entry)],
      run: () => this.read(entry, { ...parsed, size: parsed.limit }, context),
    };
  }

  /** read_documents (KBC-011): several documents in one step, a shorter window each. */
  private readManyCall(args: unknown, context: ToolContext): PreparedCall {
    const parsed = parsedArgs(readManyArgsSchema, args);
    if (typeof parsed === 'string') return failed(parsed);
    const entries = parsed.documents.map((ref) => this.resolve(ref, context));
    const missing = parsed.documents.filter((_, i) => !entries[i]);
    const found = [...new Set(entries.filter((e) => e !== null))];
    if (found.length === 0) return failed(notFound(missing[0] ?? ''));
    return {
      steps: found.map(readStep),
      run: () => this.readMany(found, { parsed, missing }, context),
    };
  }

  private async readMany(
    entries: readonly CatalogEntry[],
    { parsed, missing }: { parsed: ReadManyArgs; missing: unknown[] },
    context: ToolContext,
  ): Promise<string> {
    const request = { around: parsed.around, size: BATCH_WINDOW_CHARS };
    const texts = await Promise.all(
      entries.map((entry) => this.read(entry, request, context)),
    );
    const missed = missing.map((ref) =>
      notFound(typeof ref === 'number' ? ref : String(ref)),
    );
    return [...texts, ...missed].join('\n\n');
  }

  private async read(
    entry: CatalogEntry,
    args: WindowRequest,
    { topic, book, labels }: ToolContext,
  ): Promise<string> {
    const n = book.number(entry);
    const text = await this.deps.vault.readDocument(topic, entry.id);
    if (text === null) return `O documento [${n}] não pôde ser lido.`;
    const body = splitFrontmatter(text).body.normalize('NFC');
    const window = windowOf(body, args);
    if (entry.media) showWindow(book, n, { body, window, around: args.around });
    return [
      ...headerLines(n, entry, labels),
      ...windowLines(n, window, args.around),
    ].join('\n');
  }

  private relatedCall(args: unknown, context: ToolContext): PreparedCall {
    const parsed = parsedArgs(relatedArgsSchema, args);
    if (typeof parsed === 'string') return failed(parsed);
    const entry = this.resolve(parsed.document, context);
    if (!entry) return failed(notFound(parsed.document));
    return {
      steps: [
        {
          kind: 'related',
          text: `Seguindo as ligações de ${quote(entry.title)}`,
        },
      ],
      run: async () => this.related(entry, context),
    };
  }

  private related(entry: CatalogEntry, context: ToolContext): string {
    const { topic, book, labels } = context;
    const n = book.number(entry);
    const groups = this.relatedGroups(entry, context).map(([group, refs]) => {
      const label = RELATION_LABELS[group as keyof typeof RELATION_LABELS];
      const lines = refs
        .slice(0, MAX_REFS_PER_GROUP)
        .map((ref) => this.relatedLine(topic, ref, { book, labels }));
      return [`${label} (${refs.length}):`, ...lines].join('\n');
    });
    if (groups.length === 0)
      return `[${n}] ${entry.title} não tem ligações no kb.`;
    return [`Ligações de [${n}] ${entry.title}:`, ...groups].join('\n');
  }

  /**
   * The document's kb relations in its own collection, by their ids in the scope, without
   * the tracks this turn may not see; empty groups left out.
   */
  private relatedGroups(entry: CatalogEntry, context: ToolContext) {
    const view = this.deps.catalog.scopeView(context.topic);
    if (!view) return [];
    const catalog = view.catalogOf(entry);
    const own = { ...entry, id: entry.home?.id ?? entry.id };
    const inScope = (ref: { id: string; title: string }) => ({
      ...ref,
      id: view.idOf(catalog.topic.slug, ref.id),
    });
    // Seen before copies collapse: a hidden copy never hides a visible one (QA F-1).
    const seen = (ref: { id: string; title: string }) => {
      const one = view.entries.get(inScope(ref).id);
      return !one || isVisible(one, context);
    };
    return Object.entries(catalog.relations.groupsOf(own, seen))
      .map(([group, refs]) => [group, refs.map(inScope)] as const)
      .filter(([, refs]) => refs.length > 0);
  }

  private relatedLine(
    topic: string,
    ref: { id: string; title: string },
    { book, labels }: Pick<ToolContext, 'book' | 'labels'>,
  ): string {
    const entry = this.entry(topic, ref.id);
    // The catalog entry carries the authorship the source keeps (KBC-020).
    const n = book.number(entry ?? ref);
    return entry ? refLine(n, entry, labels) : `[${n}] ${ref.title}`;
  }

  private resolve(
    ref: string | number,
    context: ToolContext,
  ): CatalogEntry | null {
    return resolveEntry(this.deps.catalog, ref, context);
  }

  /** A document of the collection or of one of its sub-collections (KBC-101 FR-5). */
  private entry(topic: string, id: string): CatalogEntry | null {
    return this.deps.catalog.scopeView(topic)?.entries.get(id) ?? null;
  }

  /** A hit's entry in the scope: a sub-collection's hit by its id from the parent. */
  private hitEntry(topic: string, hit: SearchHit): CatalogEntry | null {
    const view = this.deps.catalog.scopeView(topic);
    return view?.entries.get(view.idOf(hit.topic, hit.id)) ?? null;
  }
}
