import type { ResearchStep } from '@kb-chat/contracts';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import type { ToolCall, ToolDefinition } from '../../ports/llm.js';
import type { VaultReaderPort } from '../../ports/vault-reader.js';
import {
  splitFrontmatter,
  type CatalogEntry,
  type CatalogRegistry,
} from '../catalog/index.js';
import type { SearchService } from '../search/index.js';
import { windowOf } from './body-window.js';
import type { SourceBook } from './source-book.js';
import {
  foldName,
  headerLines,
  hitLine,
  quote,
  refLine,
  windowLines,
} from './tool-output.js';
import {
  TOOL_DEFINITIONS,
  readArgsSchema,
  relatedArgsSchema,
  searchArgsSchema,
  subjectsArgsSchema,
  type ToolName,
} from './tool-schemas.js';

const MAX_SUBJECTS = 60;
const MAX_REFS_PER_GROUP = 10;

export interface ResearchToolsDeps {
  readonly search: SearchService;
  readonly catalog: CatalogRegistry;
  readonly vault: VaultReaderPort;
}

export interface ToolContext {
  readonly topic: string;
  readonly book: SourceBook;
}

/** A tool call ready to run: the step shown to the reader and the text for the model. */
export interface PreparedCall {
  readonly step: ResearchStep | null;
  run(): Promise<string>;
}

type Handler = (args: unknown, context: ToolContext) => PreparedCall;
type ReadArgs = z.output<typeof readArgsSchema>;
type SearchArgs = z.output<typeof searchArgsSchema>;

const RELATION_LABELS = {
  exampleOf: 'É exemplo de',
  extends: 'Estende',
  related: 'Relacionado a',
  examples: 'Exemplos',
  extendedBy: 'Estendido por',
  relatedFrom: 'Citado como relacionado por',
} as const;

const failed = (text: string): PreparedCall => ({
  step: null,
  run: async () => text,
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
    list_subjects: (args, context) => this.subjectsCall(args, context),
    read_document: (args, context) => this.readCall(args, context),
    related_documents: (args, context) => this.relatedCall(args, context),
  };

  constructor(private readonly deps: ResearchToolsDeps) {}

  /** The topic's display title, or null when the topic does not exist. */
  topicTitle(topic: string): string | null {
    return this.deps.catalog.get(topic)?.topic.title ?? null;
  }

  prepare(call: ToolCall, context: ToolContext): PreparedCall {
    const handler = this.handlers[call.name as ToolName] as Handler | undefined;
    if (!handler) return failed(`Ferramenta desconhecida: ${call.name}.`);
    const prepared = handler(parseArguments(call.arguments), context);
    return {
      step: prepared.step,
      run: () => prepared.run().catch(describeFailure),
    };
  }

  private parsed<T extends z.ZodType>(
    schema: T,
    args: unknown,
  ): z.output<T> | string {
    const result = schema.safeParse(args);
    if (result.success) return result.data;
    const issues = result.error.issues
      .map(
        (issue) => `${issue.path.join('.') || 'argumentos'}: ${issue.message}`,
      )
      .join('; ');
    return `Argumentos inválidos (${issues}). Corrija e chame de novo.`;
  }

  private searchCall(args: unknown, context: ToolContext): PreparedCall {
    const parsed = this.parsed(searchArgsSchema, args);
    if (typeof parsed === 'string') return failed(parsed);
    return {
      step: { kind: 'search', text: `Buscando ${quote(parsed.query)}` },
      run: () => this.runSearch(parsed, context),
    };
  }

  private async runSearch(
    args: SearchArgs,
    { topic, book }: ToolContext,
  ): Promise<string> {
    const concepts = this.knownSubjects(topic, args.subjects ?? []);
    const response = await this.deps.search.search(topic, {
      q: args.query,
      mode: args.mode,
      limit: args.limit,
      filters: { concepts },
    });
    const scope = `${quote(args.query)} (modo ${args.mode}${concepts.length > 0 ? `; assuntos: ${concepts.join(', ')}` : ''})`;
    if (response.items.length === 0)
      return `Nenhum documento encontrado para ${scope}. Tente sinônimos, termos mais gerais ou mais específicos, outro modo (semantic/exact) ou list_subjects.`;
    const lines = response.items.map((hit) =>
      hitLine(
        book.number(hit),
        hit,
        this.entry(topic, hit.id)?.summary ?? null,
      ),
    );
    return [
      `Busca ${scope}: ${response.items.length} de ${response.total} documento(s).`,
      ...lines,
    ].join('\n');
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
    const parsed = this.parsed(subjectsArgsSchema, args);
    if (typeof parsed === 'string') return failed(parsed);
    const text = parsed.query
      ? `Listando os assuntos sobre ${quote(parsed.query)}`
      : 'Listando os assuntos';
    return {
      step: { kind: 'subjects', text },
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
    const parsed = this.parsed(readArgsSchema, args);
    if (typeof parsed === 'string') return failed(parsed);
    const entry = this.resolve(parsed.document, context);
    if (!entry) return failed(this.notFound(parsed.document));
    return {
      step: { kind: 'read', text: `Lendo ${quote(entry.title)}` },
      run: () => this.read(entry, parsed, context),
    };
  }

  private async read(
    entry: CatalogEntry,
    args: ReadArgs,
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
    const parsed = this.parsed(relatedArgsSchema, args);
    if (typeof parsed === 'string') return failed(parsed);
    const entry = this.resolve(parsed.document, context);
    if (!entry) return failed(this.notFound(parsed.document));
    return {
      step: {
        kind: 'related',
        text: `Seguindo as ligações de ${quote(entry.title)}`,
      },
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
    const n = book.number(ref);
    return entry ? refLine(n, entry) : `[${n}] ${ref.title}`;
  }

  /** A [n] already met this turn ("3", "[3]" or 3) or a document id of the topic. */
  private resolve(
    ref: string | number,
    { topic, book }: ToolContext,
  ): CatalogEntry | null {
    const digits =
      typeof ref === 'number' ? ref : /^\[?(\d+)\]?$/.exec(ref)?.[1];
    const id =
      digits === undefined ? String(ref) : book.find(Number(digits))?.id;
    return id ? this.entry(topic, id) : null;
  }

  private entry(topic: string, id: string): CatalogEntry | null {
    return this.deps.catalog.get(topic)?.entries.get(id) ?? null;
  }

  private notFound(ref: string | number): string {
    return `Documento ${typeof ref === 'number' ? `[${ref}]` : quote(ref)} não encontrado. Use o número [n] de um resultado de busca ou de uma ligação.`;
  }
}
