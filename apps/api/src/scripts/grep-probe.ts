// Read-only probe of the exhaustive research tools against a vault (KBC-017 NFR-1/NFR-2):
// pages find_text with an entity filter to the end and greps the biggest document of that
// entity. It never writes to the vault and makes no model call (no index, no LLM).
// Usage: KB_VAULT=<vault> pnpm --filter @kb-chat/api exec tsx src/scripts/grep-probe.ts \
//          [--topic hermetismo] [--entity "José Laércio do Egito"] [--phrase "livro | obra"]
import { FsVaultAdapter } from '../adapters/fs-vault-adapter.js';
import { loadConfig } from '../config.js';
import { CatalogRegistry } from '../modules/catalog/index.js';
import { ResearchTools, SourceBook } from '../modules/research/index.js';
import { SearchService } from '../modules/search/index.js';
import type { SearchIndexPort } from '../ports/search-index.js';

const arg = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? (process.argv[at + 1] ?? fallback) : fallback;
};

const TOPIC = arg('topic', 'hermetismo');
const ENTITY = arg('entity', 'José Laércio do Egito');
const PHRASE = arg('phrase', 'livro | obra | bibliografia');
const PAGE = 200;

const fold = (text: string): string =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** find_text never asks the index; search_collection is not probed here. */
const NO_INDEX: SearchIndexPort = {
  search: async () => [],
  status: () => 'ok',
  close: async () => undefined,
};

async function timed<T>(work: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const value = await work();
  return [value, Math.round(performance.now() - started)];
}

const config = loadConfig(process.env);
const vault = new FsVaultAdapter(config.KB_VAULT);
const catalog = new CatalogRegistry(vault);
await catalog.load();
const search = new SearchService({ catalog, index: NO_INDEX, vault });
const tools = new ResearchTools({ search, catalog, vault });
const context = { topic: TOPIC, book: new SourceBook() };
const call = (args: object) =>
  tools
    .prepare(
      { id: 'p', name: 'find_text', arguments: JSON.stringify(args) },
      context,
    )
    .run();

const [, warmMs] = await timed(() => tools.warm(TOPIC));
console.log(
  `documents: ${catalog.get(TOPIC)?.entries.size ?? 0}; find_text cache built in ${warmMs} ms`,
);

let offset = 0;
let pages = 0;
let listed = 0;
for (;;) {
  const [page, ms] = await timed(() =>
    call({ entity: ENTITY, head_limit: PAGE, offset }),
  );
  pages += 1;
  const lines = page.split('\n').filter((line) => /^\[\d+\] /.test(line));
  listed += lines.length;
  if (pages === 1) console.log(`page 1 (${ms} ms): ${page.split('\n')[0]}`);
  const next = /Próxima página: offset=(\d+)/.exec(page)?.[1];
  if (!next) {
    console.log(`last page ${pages} (${ms} ms): ${page.split('\n').at(-1)}`);
    break;
  }
  offset = Number(next);
}
console.log(
  `entity "${ENTITY}": ${listed} documents listed in ${pages} page(s) of ${PAGE}`,
);
const [text, textMs] = await timed(() =>
  call({ phrase: 'Laércio', output_mode: 'count', head_limit: 1 }),
);
console.log(`text "Laércio" anywhere (${textMs} ms): ${text.split('\n')[0]}`);

const biggest = [...(catalog.get(TOPIC)?.entries.values() ?? [])]
  .filter((entry) =>
    entry.entities.some((name) => fold(name).includes(fold(ENTITY))),
  )
  .map(async (entry) => ({
    entry,
    size: (await vault.readDocument(TOPIC, entry.id))?.length ?? 0,
  }));
const sized = (await Promise.all(biggest)).sort((a, b) => b.size - a.size);
const top = sized[0];
if (top) {
  const [scan, ms] = await timed(() =>
    call({
      document: top.entry.id,
      phrase: PHRASE,
      output_mode: 'content',
      head_limit: 100,
    }),
  );
  console.log(`biggest: ${top.entry.id} (${top.size} chars)`);
  console.log(`scan (${ms} ms): ${scan.split('\n')[0]}`);
  console.log(
    `scan footer: ${scan.split('\n').at(-2)}; output ${scan.length} chars`,
  );
}
