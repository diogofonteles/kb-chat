import type { ResearchStep } from '@kb-chat/contracts';
import type { z } from 'zod';
import type { CatalogEntry, CatalogRegistry } from '../catalog/index.js';
import {
  acceptsEntry,
  describeFilter,
  isFiltering,
  toFilter,
  type DocFilter,
} from './doc-filter.js';
import {
  PASSAGES_PER_PAGE,
  countLine,
  fileLine,
  groupLine,
  listedLine,
  occurrenceLine,
  pageFooter,
  pageRange,
  phraseList,
  type Page,
} from './grep-output.js';
import {
  foldPhrase,
  type DocMatch,
  type TextCount,
  type TextFinder,
} from './text-finder.js';
import {
  failed,
  notFound,
  parsedArgs,
  resolveEntry,
  type PreparedCall,
  type ToolContext,
} from './tool-context.js';
import { quote } from './tool-output.js';
import {
  GREP_PAGE,
  PHRASE_SEPARATOR,
  findArgsSchema,
  type GrepMode,
} from './tool-schemas.js';

const MAX_PHRASES = 8;
export const MIN_PHRASE_CHARS = 3;

type FindArgs = z.output<typeof findArgsSchema>;

export interface GrepToolDeps {
  readonly finder: TextFinder;
  readonly catalog: CatalogRegistry;
}

/** One find_text call over the collection, as validated and resolved. */
interface GrepRequest {
  readonly args: FindArgs;
  readonly phrases: readonly string[];
  readonly filter: DocFilter;
  readonly context: ToolContext;
}

type Renderer = (request: GrepRequest, counted: TextCount) => Promise<string>;

/** The alternatives of a find_text phrase ("a | b"), without repeats or too-short ones. */
export function phrasesOf(phrase: string): string[] {
  const byFolded = new Map<string, string>();
  for (const part of phrase.split(PHRASE_SEPARATOR)) {
    const folded = foldPhrase(part);
    if (folded.length >= MIN_PHRASE_CHARS && !byFolded.has(folded))
      byFolded.set(folded, part.trim());
  }
  return [...byFolded.values()].slice(0, MAX_PHRASES);
}

/**
 * Characters a page may take (NFR-3: every output stays under 60,000, below Claude Code's
 * MCP output limit): lines past it move to the next page, with an exact offset.
 */
export const PAGE_CHARS = 50_000;
/** What one content line takes besides its context: position, phrase, separators. */
const CONTENT_LINE_EXTRA = 120;
/** Room kept for a passage (or summary) line's " — Trecho: …" part. */
const PASSAGE_ESTIMATE = 320;

/** The page size asked for, bounded by the mode's maximum and, in content, by the budget. */
function pageSize(args: FindArgs, mode: GrepMode): number {
  const asked = Math.min(
    args.head_limit ?? args.limit ?? GREP_PAGE[mode].default,
    GREP_PAGE[mode].max,
  );
  if (mode !== 'content') return asked;
  // Group heads take some room too: the occurrences get 80% of the page.
  const fits = Math.floor(
    (PAGE_CHARS * 0.8) / (args.context_chars + CONTENT_LINE_EXTRA),
  );
  return Math.max(1, Math.min(asked, fits));
}

/** How many of the lines fit in the page's character budget (at least one). */
function fitting(lines: readonly string[], budget = PAGE_CHARS): number {
  let used = 0;
  let count = 0;
  for (const line of lines) {
    used += line.length + 1;
    if (used > budget && count > 0) break;
    count += 1;
  }
  return count;
}

const pageOf = (
  args: FindArgs,
  { mode, total }: { mode: GrepMode; total: number },
): Page => {
  const offset = args.offset;
  const size = Math.max(0, Math.min(pageSize(args, mode), total - offset));
  return { offset, size, total };
};

function scopeText(filter: DocFilter): string {
  return [
    filter.entity && `entidade ${quote(filter.entity)}`,
    filter.source && `origem ${quote(filter.source)}`,
  ]
    .filter(Boolean)
    .join(' e ');
}

function stepOf({ args, filter }: Omit<GrepRequest, 'phrases'>): ResearchStep {
  const from = args.offset > 0 ? ` (a partir do ${args.offset + 1}º)` : '';
  if (!args.phrase)
    return {
      kind: 'search',
      text: `Listando os documentos de ${scopeText(filter)}${from}`,
    };
  const where = isFiltering(filter)
    ? `em documentos de ${scopeText(filter) || 'um filtro'}`
    : 'em todo o acervo';
  return {
    kind: 'search',
    text: `Procurando o texto ${quote(args.phrase)} ${where}${from}`,
  };
}

function totalsLine(request: GrepRequest, counted: TextCount): string {
  const filter = describeFilter(request.filter);
  const scope = filter ? ` (${filter})` : '';
  const documents = `${counted.matches.length} documento(s)`;
  if (request.phrases.length === 0) {
    const rest = describeFilter({
      ...request.filter,
      entity: undefined,
      source: undefined,
    });
    const extra = rest ? ` (${rest})` : '';
    return `Documentos com ${scopeText(request.filter)}${extra}: ${documents}.`;
  }
  return `Texto ${phraseList(request.phrases)}${scope}: ${documents}, ${counted.occurrences} ocorrência(s), em ${counted.scanned} documentos varridos.`;
}

function nothingFound(request: GrepRequest, scanned: number): string {
  const filter = describeFilter(request.filter);
  if (request.phrases.length === 0)
    return `Nenhum documento com ${filter}. Use list_sources para ver os nomes de origens e entidades do acervo.`;
  const scope = filter ? ` do filtro (${filter})` : '';
  return `Nenhum dos ${scanned} documentos${scope} contém ${phraseList(request.phrases)}. Antes de concluir que o acervo não trata disso, tente variantes: sinônimos (ocultos, secretos, velados, universais, adicionais), singular e plural, o número por extenso e em algarismos, uma parte menor da frase, outro filtro, e search_collection.`;
}

/**
 * find_text as a grep (KBC-017, ADR 0013): every matching document of the collection,
 * counted and paged (`files`, `count`, `content`), filtered by entity, origin, subjects
 * and exclusions, or one document's whole body. Nothing is cut silently: the first line
 * has the totals and the last one says how to get the next page.
 */
export class GrepTool {
  private readonly renderers: Record<GrepMode, Renderer> = {
    files: (request, counted) => this.filesPage(request, counted),
    count: async (request, counted) => this.countPage(request, counted),
    content: (request, counted) => this.contentPage(request, counted),
  };

  constructor(private readonly deps: GrepToolDeps) {}

  prepare(raw: unknown, context: ToolContext): PreparedCall {
    const args = parsedArgs(findArgsSchema, raw);
    if (typeof args === 'string') return failed(args);
    const phrases = args.phrase ? phrasesOf(args.phrase) : [];
    if (args.phrase && phrases.length === 0)
      return failed(
        `Texto curto demais: use ao menos ${MIN_PHRASE_CHARS} letras por variante.`,
      );
    if (args.document !== undefined)
      return this.prepareDocument({ args, phrases, context });
    const filter = toFilter(this.deps.catalog, args, context);
    const request = { args, phrases, filter, context };
    return { steps: [stepOf(request)], run: () => this.grep(request) };
  }

  private async grep(request: GrepRequest): Promise<string> {
    const { filter, phrases, context } = request;
    const counted = await this.deps.finder.count({
      topic: context.topic,
      phrases,
      accept: (entry) => acceptsEntry(filter, entry),
    });
    if (!counted) return 'O acervo deste tópico não está disponível.';
    if (counted.matches.length === 0)
      return nothingFound(request, counted.scanned);
    const mode = phrases.length === 0 ? 'files' : request.args.output_mode;
    return this.renderers[mode](request, counted);
  }

  private async filesPage(
    request: GrepRequest,
    counted: TextCount,
  ): Promise<string> {
    const { args, phrases } = request;
    let page = pageOf(args, { mode: 'files', total: counted.matches.length });
    const shown = counted.matches.slice(page.offset, page.offset + page.size);
    // Sized before numbering, so no document gets an [n] it was not shown with.
    const estimates = shown.map(
      (match, i) =>
        `${fileLine(0, match, null)}${i < PASSAGES_PER_PAGE ? ' '.repeat(PASSAGE_ESTIMATE) : ''}`,
    );
    const lines = await Promise.all(
      shown
        .slice(0, fitting(estimates))
        .map((match, i) => this.fileLineOf(request, match, i)),
    );
    page = { ...page, size: lines.length };
    const hint =
      phrases.length > 0 && page.offset + page.size >= page.total
        ? [
            'Para ver cada ocorrência: output_mode content (todas) ou document=[n] (um documento inteiro).',
          ]
        : [];
    return [
      `${totalsLine(request, counted)} ${pageRange(page)}`,
      ...lines,
      ...hint,
      pageFooter(page),
    ].join('\n');
  }

  /** One files line; the first ones of a page carry a passage (or the kb summary). */
  private async fileLineOf(
    { phrases, context }: GrepRequest,
    match: DocMatch,
    index: number,
  ): Promise<string> {
    // Numbered before any await, so [n] follows the page order.
    const n = context.book.number(match.entry);
    const withText = index < PASSAGES_PER_PAGE;
    if (phrases.length === 0) return listedLine(n, match, withText);
    const passage = withText
      ? await this.deps.finder.snippet(context.topic, match)
      : null;
    return fileLine(n, match, passage);
  }

  private countPage(request: GrepRequest, counted: TextCount): string {
    const { args, context } = request;
    const full = pageOf(args, { mode: 'count', total: counted.matches.length });
    const shown = counted.matches.slice(full.offset, full.offset + full.size);
    const titles = shown.map((match) => countLine(0, match));
    const lines = shown
      .slice(0, fitting(titles))
      .map((match) => countLine(context.book.number(match.entry), match));
    const page = { ...full, size: lines.length };
    return [
      `${totalsLine(request, counted)} ${pageRange(page)}`,
      ...lines,
      pageFooter(page),
    ].join('\n');
  }

  /** Occurrences across documents, in rank order and reading order inside each one. */
  private async contentPage(
    request: GrepRequest,
    counted: TextCount,
  ): Promise<string> {
    const page = pageOf(request.args, {
      mode: 'content',
      total: counted.occurrences,
    });
    const lines: string[] = [];
    let skip = page.offset;
    let room = page.size;
    for (const match of counted.matches) {
      if (room === 0) break;
      if (skip >= match.occurrences) skip -= match.occurrences;
      else {
        const shown = await this.groupOf(request, { match, skip, room });
        lines.push(...shown.lines);
        room -= shown.count;
        skip = 0;
      }
    }
    return [
      `${totalsLine(request, counted)} ${pageRange(page)}`,
      ...lines,
      pageFooter(page),
      'Para ler em volta de uma ocorrência: read_document com document=[n] e offset=<posição @> (ou um pouco antes).',
    ].join('\n');
  }

  private async groupOf(
    { phrases, args, context }: GrepRequest,
    at: { match: DocMatch; skip: number; room: number },
  ): Promise<{ lines: string[]; count: number }> {
    const { entry } = at.match;
    const found = await this.deps.finder.occurrencesIn(context.topic, entry, {
      phrases,
      chars: args.context_chars,
    });
    const items = found?.items.slice(at.skip, at.skip + at.room) ?? [];
    if (items.length === 0) return { lines: [], count: 0 };
    const head = groupLine(context.book.number(entry), entry, {
      from: at.skip + 1,
      to: at.skip + items.length,
      of: at.match.occurrences,
    });
    const several = phrases.length > 1;
    return {
      lines: [head, ...items.map((item) => occurrenceLine(item, several))],
      count: items.length,
    };
  }

  private prepareDocument(request: Omit<GrepRequest, 'filter'>): PreparedCall {
    const { args, context } = request;
    const ref = args.document ?? '';
    const entry = resolveEntry(this.deps.catalog, ref, context);
    if (!entry) return failed(notFound(ref));
    const text = `Procurando ${quote(args.phrase ?? '')} em ${quote(entry.title)} inteiro`;
    return {
      steps: [{ kind: 'search', text }],
      run: () => this.grepDocument(request, entry),
    };
  }

  /** One document's whole body (the "scan_document" of KBC-017): every occurrence, paged. */
  private async grepDocument(
    { args, phrases, context }: Omit<GrepRequest, 'filter'>,
    entry: CatalogEntry,
  ): Promise<string> {
    const found = await this.deps.finder.occurrencesIn(context.topic, entry, {
      phrases,
      chars: args.context_chars,
    });
    const n = context.book.number(entry);
    if (!found) return `O documento [${n}] não pôde ser lido.`;
    const mode = args.output_mode === 'count' ? 'count' : 'content';
    const page = pageOf(args, { mode, total: found.items.length });
    const head = `Texto ${phraseList(phrases)} em [${n}] ${entry.title} (${found.length} caracteres): ${found.items.length} ocorrência(s).`;
    if (mode === 'count' || found.items.length === 0)
      return `${head}${found.items.length === 0 ? ' Tente variantes (sinônimos, singular e plural, uma parte menor da frase).' : ''}`;
    const items = found.items
      .slice(page.offset, page.offset + page.size)
      .map((item) => occurrenceLine(item, phrases.length > 1));
    return [
      `${head} ${pageRange(page)}`,
      ...items,
      pageFooter(page),
      `Para ler em volta de uma ocorrência: read_document com document=${n} e offset=<posição @> (ou um pouco antes).`,
    ].join('\n');
  }
}
