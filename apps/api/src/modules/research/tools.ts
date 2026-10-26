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
import { windowOf, type WindowRequest } from './body-window.js';
import {
  acceptsEntry,
  describeFilter,
  isFiltering,
  toFilter,
  type DocFilter,
} from './doc-filter.js';
import { GrepTool } from './grep-tool.js';
import type { SourceBook } from './source-book.js';
import { SourcesTool } from './sources-tool.js';
import { TextFinder } from './text-finder.js';
import {
  failed,
  notFound,
  parsedArgs,
  resolveEntry,
  type PreparedCall,
  type ToolContext,
} from './tool-context.js';
import {
  foldName,
  headerLines,
  hitLine,
  quote,
  refLine,
  windowLines,
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
}

type Handler = (args: unknown, context: ToolContext) => PreparedCall;
type ReadManyArgs = z.output<typeof readManyArgsSchema>;
type SearchArgs = z.output<typeof searchArgsSchema>;

/** "“ritmo” (modo all; assuntos: X; entidade contém “y”)" for the search's first line. */
function searchScope(
  args: SearchArgs,
  concepts: readonly string[],
  filter: DocFilter,
): string {
  const parts = [
    `modo ${args.mode}`,
    concepts.length > 0 && `assuntos: ${concepts.join(', ')}`,
    describeFilter(filter),
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

  private readonly finder: TextFinder;
  private readonly grep: GrepTool;
  private readonly sources: SourcesTool;

  constructor(private readonly deps: ResearchToolsDeps) {
    this.finder = new TextFinder(deps);
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

  prepare(call: ToolCall, context: ToolContext): PreparedCall {
    const handler = this.handlers[call.name as ToolName] as Handler | undefined;
    if (!handler) return failed(`Ferramenta desconhecida: ${call.name}.`);
    const prepared = handler(parseArguments(call.arguments), context);
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
    const { topic, book } = context;
    const concepts = this.knownSubjects(topic, args.subjects ?? []);
    const filter = toFilter(
      this.deps.catalog,
      { ...args, subjects: [] },
      context,
    );
    const found = await this.filteredSearch(args, { topic, concepts, filter });
    const scope = searchScope(args, concepts, filter);
    if (found.shown.length === 0) return noHits(scope, args.offset);
    const range = searchRange(args, { ...found, shown: found.shown.length });
    return [
      `Busca ${scope}: ${range}`,
      ...found.shown.map((hit) =>
        hitLine(
          book.number(hit),
          hit,
          this.entry(topic, hit.id)?.summary ?? null,
        ),
      ),
    ].join('\n');
  }

  /**
   * The meaning search, then (KBC-017) the entity/origin/exclusion filters over its
   * candidates: with a filter, all of them are fetched and filtered here, then paged.
   */
  private async filteredSearch(
    args: SearchArgs,
    scope: { topic: string; concepts: string[]; filter: DocFilter },
  ): Promise<{ shown: SearchHit[]; total: number; candidates: number }> {
    const filtering = isFiltering(scope.filter);
    const response = await this.deps.search.search(scope.topic, {
      q: args.query,
      mode: args.mode,
      limit: filtering ? MAX_RESULTS : args.limit,
      offset: filtering ? 0 : args.offset,
      filters: {
        concepts: scope.concepts,
        authorships: scope.filter.authorship ? [scope.filter.authorship] : [],
      },
    });
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

  private accepts(topic: string, hit: SearchHit, filter: DocFilter): boolean {
    const entry = this.entry(topic, hit.id);
    return entry !== null && acceptsEntry(filter, entry);
  }

  /** Subject names as the catalog spells them (the model may change accents or case). */
  private knownSubjects(topic: string, subjects: readonly string[]): string[] {
    if (subjects.length === 0) return [];
    const known = new Map(
      this.deps.search
        .topicFacets(topic)
        .concepts.map(({ value }) => [foldName(value), value]),
    );
    return subjects.map((name) => known.get(foldName(name)) ?? name);
  }

  private subjectsCall(args: unknown, { topic }: ToolContext): PreparedCall {
    const parsed = parsedArgs(subjectsArgsSchema, args);
    if (typeof parsed === 'string') return failed(parsed);
    const text = parsed.query
      ? `Listando os assuntos sobre ${quote(parsed.query)}`
      : 'Listando os assuntos';
    return {
      steps: [{ kind: 'subjects', text }],
      run: async () => this.listSubjects(topic, parsed.query),
    };
  }

  private listSubjects(topic: string, query: string | undefined): string {
    const needle = query ? foldName(query) : '';
    const subjects = this.deps.search
      .topicFacets(topic)
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
    { topic, book }: ToolContext,
  ): Promise<string> {
    const n = book.number(entry);
    const text = await this.deps.vault.readDocument(topic, entry.id);
    if (text === null) return `O documento [${n}] não pôde ser lido.`;
    const body = splitFrontmatter(text).body.normalize('NFC');
    const window = windowOf(body, args);
    return [
      ...headerLines(n, entry),
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

  private related(entry: CatalogEntry, { topic, book }: ToolContext): string {
    const catalog = this.deps.catalog.get(topic);
    const n = book.number(entry);
    if (!catalog) return `O documento [${n}] não tem ligações.`;
    const groups = Object.entries(catalog.relations.groupsOf(entry))
      .filter(([, refs]) => refs.length > 0)
      .map(([group, refs]) => {
        const label = RELATION_LABELS[group as keyof typeof RELATION_LABELS];
        const lines = refs
          .slice(0, MAX_REFS_PER_GROUP)
          .map((ref) => this.relatedLine(topic, ref, book));
        return [`${label} (${refs.length}):`, ...lines].join('\n');
      });
    if (groups.length === 0)
      return `[${n}] ${entry.title} não tem ligações no kb.`;
    return [`Ligações de [${n}] ${entry.title}:`, ...groups].join('\n');
  }

  private relatedLine(
    topic: string,
    ref: { id: string; title: string },
    book: SourceBook,
  ): string {
    const entry = this.entry(topic, ref.id);
    // The catalog entry carries the authorship the source keeps (KBC-020).
    const n = book.number(entry ?? ref);
    return entry ? refLine(n, entry) : `[${n}] ${ref.title}`;
  }

  private resolve(
    ref: string | number,
    context: ToolContext,
  ): CatalogEntry | null {
    return resolveEntry(this.deps.catalog, ref, context);
  }

  private entry(topic: string, id: string): CatalogEntry | null {
    return this.deps.catalog.get(topic)?.entries.get(id) ?? null;
  }
}
