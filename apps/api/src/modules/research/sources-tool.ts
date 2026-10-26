import type { z } from 'zod';
import type { CatalogEntry, CatalogRegistry } from '../catalog/index.js';
import { originFolder } from './doc-filter.js';
import { PAGE_CHARS, fitting, pageFooter, pageRange } from './grep-output.js';
import {
  failed,
  parsedArgs,
  type PreparedCall,
  type ToolContext,
} from './tool-context.js';
import { foldName, oneLine, quote } from './tool-output.js';
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

/**
 * list_sources (KBC-017, ADR 0013): the collection's origin folders and kb entities with
 * document counts, so the agent learns the `source` and `entity` values of find_text.
 */
export class SourcesTool {
  constructor(private readonly catalog: CatalogRegistry) {}

  prepare(raw: unknown, { topic }: ToolContext): PreparedCall {
    const args = parsedArgs(sourcesArgsSchema, raw);
    if (typeof args === 'string') return failed(args);
    const about = args.query ? ` sobre ${quote(args.query)}` : '';
    return {
      steps: [
        { kind: 'subjects', text: `Listando as origens e entidades${about}` },
      ],
      run: async () => this.list(topic, args),
    };
  }

  private list(topic: string, args: SourcesArgs): string {
    const catalog = this.catalog.get(topic);
    if (!catalog) return 'O acervo deste tópico não está disponível.';
    const entries = [...catalog.entries.values()];
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
    return lines.join('\n');
  }
}
