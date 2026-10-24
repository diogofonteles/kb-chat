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
import { TextFinder, foldPhrase, type TextSearch } from './text-finder.js';
import {
  foldName,
  headerLines,
  hitLine,
  quote,
  refLine,
  textHitLine,
  windowLines,
} from './tool-output.js';
import {
  PHRASE_SEPARATOR,
  TOOL_DEFINITIONS,
  findArgsSchema,
  readArgsSchema,
  relatedArgsSchema,
  searchArgsSchema,
  subjectsArgsSchema,
  type ToolName,
} from './tool-schemas.js';

const MAX_SUBJECTS = 60;
const MAX_REFS_PER_GROUP = 10;
const MAX_PHRASES = 8;
const MIN_PHRASE_CHARS = 3;

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
type FindArgs = z.output<typeof findArgsSchema>;

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

/** The alternatives of a find_text phrase ("a | b"), without repeats or too-short ones. */
function phrasesOf(phrase: string): string[] {
  const byFolded = new Map<string, string>();
  for (const part of phrase.split(PHRASE_SEPARATOR)) {
    const folded = foldPhrase(part);
    if (folded.length >= MIN_PHRASE_CHARS && !byFolded.has(folded))
      byFolded.set(folded, part.trim());
  }
  return [...byFolded.values()].slice(0, MAX_PHRASES);
}

const phraseList = (phrases: readonly string[]): string =>
  phrases.map(quote).join(' ou ');

function noTextFound(phrases: readonly string[], scanned: number): string {
  return `Nenhum dos ${scanned} documentos contém ${phraseList(phrases)}. Antes de concluir que o acervo não trata disso, tente variantes: sinônimos (ocultos, secretos, velados, universais, adicionais), singular e plural, o número por extenso e em algarismos, uma parte menor da frase, e search_collection.`;
}

function findSummary(phrases: readonly string[], found: TextSearch): string {
  const shown =
    found.hits.length < found.documents
      ? `; mostrando os ${found.hits.length} com mais ocorrências`
      : '';
  return `Texto ${phraseList(phrases)} em ${found.scanned} documentos: ${found.documents} documento(s), ${found.occurrences} ocorrência(s)${shown}.`;
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
    find_text: (args, context) => this.findCall(args, context),
    list_subjects: (args, context) => this.subjectsCall(args, context),
    read_document: (args, context) => this.readCall(args, context),
    related_documents: (args, context) => this.relatedCall(args, context),
  };

  private readonly finder: TextFinder;

  constructor(private readonly deps: ResearchToolsDeps) {
    this.finder = new TextFinder(deps);
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

  private findCall(args: unknown, context: ToolContext): PreparedCall {
    const parsed = this.parsed(findArgsSchema, args);
    if (typeof parsed === 'string') return failed(parsed);
    if (phrasesOf(parsed.phrase).length === 0)
      return failed(
        `Texto curto demais: use ao menos ${MIN_PHRASE_CHARS} letras por variante.`,
      );
    return {
      step: {
        kind: 'search',
        text: `Procurando o texto ${quote(parsed.phrase)} em todo o acervo`,
      },
      run: () => this.findText(parsed, context),
    };
  }

  private async findText(
    args: FindArgs,
    { topic, book }: ToolContext,
  ): Promise<string> {
    const phrases = phrasesOf(args.phrase);
    const found = await this.finder.find({
      topic,
      phrases,
      limit: args.limit,
    });
    if (!found) return 'O acervo deste tópico não está disponível.';
    if (found.hits.length === 0) return noTextFound(phrases, found.scanned);
    return [
      findSummary(phrases, found),
      ...found.hits.map((hit) => textHitLine(book.number(hit.entry), hit)),
      'Para ver o contexto: read_document com document=[n] e around=<o texto>.',
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
