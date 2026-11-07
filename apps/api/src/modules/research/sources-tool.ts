import { AUTHORSHIPS } from '@kb-chat/contracts';
import type { z } from 'zod';
import type { CatalogEntry, CatalogRegistry } from '../catalog/index.js';
import { originFolder } from './doc-filter.js';
import { PAGE_CHARS, fitting, pageFooter, pageRange } from './grep-output.js';
import {
  failed,
  isVisible,
  parsedArgs,
  type PreparedCall,
  type ToolContext,
} from './tool-context.js';
import {
  AUTHORSHIP_LABELS,
  foldName,
  oneLine,
  quote,
  type AuthorshipLabels,
} from './tool-output.js';
import { sourcesArgsSchema } from './tool-schemas.js';

type SourcesArgs = z.output<typeof sourcesArgsSchema>;

interface Counted {
  readonly name: string;
  readonly count: number;
}

/** Names counted once per document, the most frequent first (then by name). */
function countNames(
  entries: readonly CatalogEntry[],
  namesOf: (entry: CatalogEntry) => readonly string[],
): Counted[] {
  const counts = new Map<string, Counted>();
  for (const entry of entries)
    for (const name of new Set(namesOf(entry))) {
      const key = foldName(name);
      const known = counts.get(key);
      counts.set(key, {
        name: known?.name ?? name,
        count: (known?.count ?? 0) + 1,
      });
    }
  return [...counts.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  );
}

const lineOf = ({ name, count }: Counted): string =>
  `- ${oneLine(name, 160)} (${count} documento(s))`;

function section(
  label: string,
  items: readonly Counted[],
  args: SourcesArgs,
): string[] {
  const needle = args.query ? foldName(args.query) : '';
  const matching = items.filter(({ name }) => foldName(name).includes(needle));
  const asked = matching.slice(args.offset, args.offset + args.head_limit);
  // Half of a page's budget per list: both lists fit in one output (NFR-3).
  const size = fitting(asked.map(lineOf), PAGE_CHARS / 2);

  const page = { offset: args.offset, size, total: matching.length };
  if (matching.length === 0) return [`${label}: nenhuma.`];
  return [
    `${label} (${size} de ${matching.length}): ${pageRange(page)}`,
    ...asked.slice(0, size).map(lineOf),
    pageFooter(page),
  ];
}

/** "Autoria: Mestre Laércio 3 · Outros autores 2 · …": the whole collection per group (KBC-020). */
function authorshipLine(
  entries: readonly CatalogEntry[],
  labels: AuthorshipLabels,
): string {
  const counts = AUTHORSHIPS.map(
    (group) =>
      `${labels[group]} ${entries.filter((e) => e.authorship === group).length}`,
  );
  return `Autoria: ${counts.join(' · ')} documento(s).`;
}

/**
 * list_sources (KBC-017, ADR 0013): the collection's origin folders and kb entities with
 * document counts, so the agent learns the `source` and `entity` values of find_text.
 */
export class SourcesTool {
  constructor(private readonly catalog: CatalogRegistry) {}

  prepare(raw: unknown, context: ToolContext): PreparedCall {
    const { labels = AUTHORSHIP_LABELS } = context;
    const args = parsedArgs(sourcesArgsSchema, raw);
    if (typeof args === 'string') return failed(args);
    const about = [
      args.query && ` sobre ${quote(args.query)}`,
      args.authorship && ` de autoria ${labels[args.authorship]}`,
    ]
      .filter(Boolean)
      .join('');
    return {
      steps: [
        { kind: 'subjects', text: `Listando as origens e entidades${about}` },
      ],
      run: async () => this.list(context, args, labels),
    };
  }

  private list(
    context: ToolContext,
    args: SourcesArgs,
    labels: AuthorshipLabels,
  ): string {
    const catalog = this.catalog.get(context.topic);
    if (!catalog) return 'O acervo deste tópico não está disponível.';
    // A track only counts for whom it may be researched (KBC-099 BR-4).
    const all = [...catalog.entries.values()].filter((entry) =>
      isVisible(entry, context),
    );
    const entries = args.authorship
      ? all.filter((entry) => entry.authorship === args.authorship)
      : all;
    return [authorshipLine(all, labels), ...sectionsOf(entries, args)].join(
      '\n',
    );
  }
}

/** The origins and entities sections a call asked for. */
function sectionsOf(
  entries: readonly CatalogEntry[],
  args: SourcesArgs,
): string[] {
  const lines: string[] = [];
  if (args.kind !== 'entities')
    lines.push(
      ...section(
        'Origens',
        countNames(entries, (e) => [originFolder(e)]),
        args,
      ),
    );
  if (args.kind !== 'sources')
    lines.push(
      ...section(
        'Entidades',
        countNames(entries, (e) => e.entities),
        args,
      ),
    );
  return lines;
}
