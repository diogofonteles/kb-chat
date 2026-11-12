// KBC-111 FR-3 (ADR 0036 §7, NFR-1, NFR-2): recall@10 and p95 of the documents search for a
// member who sees 100 %, 50 %, 20 % or 5 % of a collection, with the adaptive candidate budget.
// In process, over a synthetic enlarged collection whose texts use the words of the 20 real
// questions of the latency fitness function (`latency-queries.ts`), ranked by a deterministic
// in-memory index (CI has no QMD; QMD's own time per call is added on top of the app's).
// (With --qmd, the recall column is an upper bound, see qmdIndexes.)
// Oracle: the same member's search with an unlimited budget (every hit, filtered by the
// view), the master's ranking restricted to what the member sees.
// With `--qmd <index>` the same searches run on a real `qmd mcp` over a named QMD index of the
// same texts (written by `--write-vault <dir>`, then `qmd --index <index> collection add
// <dir>/hermetismo --name hermetismo` and `qmd --index <index> embed`), so QMD's own time and
// the deeper call are measured too.
// Usage: tsx src/scripts/levels-recall.ts [--texts 4000] [--runs 3] [--out <file.md>]
//          [--write-vault <dir>] [--qmd <index>]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { QmdMcpAdapter } from '../adapters/qmd-mcp-adapter.js';
import type { SearchMode } from '@kb-chat/contracts';
import { MemoryDocumentStore } from '../adapters/memory-document-store.js';
import type { StoredPerson } from '../modules/auth/index.js';
import {
  ContentGate,
  LevelDirectory,
  type LevelView,
} from '../modules/access-levels/index.js';
import { CatalogRegistry } from '../modules/catalog/index.js';
import { SearchService } from '../modules/search/index.js';
import type { IndexHit, IndexQuery } from '../ports/search-index.js';
import type { TopicFolder } from '../ports/vault-reader.js';
import { LATENCY_QUERIES } from './latency-queries.js';

const arg = (name: string, fallback: number): number => {
  const at = process.argv.indexOf(name);
  const value = at >= 0 ? Number(process.argv[at + 1]) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const text = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const OUT = text('--out');
const WRITE_VAULT = text('--write-vault');
const QMD_INDEX = text('--qmd');
const TEXTS = arg('--texts', 4_000);
const RUNS = arg('--runs', 3);
const TOPIC = 'hermetismo';
const MODES: readonly SearchMode[] = ['exact', 'semantic', 'all'];
const SLICES = [1, 0.5, 0.2, 0.05] as const;
const NFR1: Readonly<Record<number, number>> = {
  0.5: 0.95,
  0.2: 0.95,
  0.05: 0.9,
};
const NFR2_FACTOR = 1.25;

/** A stable number per text (FNV-1a). */
function hashOf(text: string): number {
  let hash = 2166136261;
  for (const char of text)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

const fold = (text: string) =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const tokensOf = (text: string) =>
  fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 2);

/** The words of the real questions, and filler: every text says a few of them. */
const VOCABULARY = [...new Set(LATENCY_QUERIES.flatMap(tokensOf))];
const FILLER = Array.from({ length: 400 }, (_, i) => `termo${i}`);

function textOf(n: number): string {
  const words = Array.from({ length: 120 }, (_, i) => {
    const pick = hashOf(`${n}:${i}`);
    return pick % 5 === 0
      ? VOCABULARY[pick % VOCABULARY.length]
      : FILLER[pick % FILLER.length];
  });
  return `---\ntitle: Texto ${n}\ngenre: article_or_essay\ndepth: 2\nrelevance: core\nauthor_group: outros-autores\n---\n\n${words.join(' ')}\n`;
}

const idOf = (n: number) => `raw/articles/texto-${n}.md`;

function vaultOf() {
  const docs = new Map<string, string>();
  for (let n = 0; n < TEXTS; n++) docs.set(idOf(n), textOf(n));
  const topic: TopicFolder = { slug: TOPIC, title: 'Hermetismo' };
  return {
    docs,
    listTopics: async () => [topic],
    listDocuments: async () => [...docs.keys()].sort(),
    readDocument: async (_topic: string, id: string) => docs.get(id) ?? null,
  };
}

type Postings = ReadonlyMap<string, ReadonlySet<string>>;

function postingsOf(docs: ReadonlyMap<string, string>): Postings {
  const postings = new Map<string, Set<string>>();
  for (const [id, text] of docs)
    for (const token of new Set(tokensOf(text)))
      postings.set(token, (postings.get(token) ?? new Set()).add(id));
  return postings;
}

/** "exact" needs every token, the others any; each mode has its own tie order. */
function scored(postings: Postings, { q, mode }: IndexQuery): IndexHit[] {
  const tokens = [...new Set(tokensOf(q))];
  const counts = new Map<string, number>();
  for (const token of tokens)
    for (const id of postings.get(token) ?? [])
      counts.set(id, (counts.get(id) ?? 0) + 1);
  const needed = mode === 'exact' ? tokens.length : 1;
  return [...counts]
    .filter(([, found]) => found >= needed)
    .map(([id, found]) => ({
      id,
      score:
        found / tokens.length + (hashOf(`${mode}:${q}:${id}`) % 1000) / 1e6,
      snippet: q,
    }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** A deterministic in-memory index: an inverted list per token (a lexical and a "vector" order). */
function indexOf(docs: ReadonlyMap<string, string>, unlimited: boolean) {
  const postings = postingsOf(docs);
  return {
    status: () => 'ok' as const,
    close: async () => undefined,
    search: async (query: IndexQuery): Promise<IndexHit[]> => {
      const hits = scored(postings, query);
      return unlimited ? hits : hits.slice(0, query.limit);
    },
  };
}

/** How often the app asked the index and for how many candidates (the deeper call shows). */
const calls = { count: 0, candidates: 0 };

function counted<
  T extends { search(query: IndexQuery): Promise<readonly IndexHit[]> },
>(index: T): T {
  const search = (query: IndexQuery) => {
    calls.count += 1;
    calls.candidates += query.limit;
    return index.search(query);
  };
  return Object.assign(Object.create(index) as T, { search });
}

const NOW = '2026-11-12T00:00:00.000Z';
const level = (id: string, code: string) => ({
  id,
  code,
  description: '',
  createdBy: 'owner@example.com',
  createdAt: NOW,
});

/** QS < CI, each text at QS with the slice's chance: a QS member sees about that share. */
async function gateOf(catalog: CatalogRegistry, share: number) {
  const scales = new MemoryDocumentStore();
  const documents = new MemoryDocumentStore();
  if (share < 1) {
    await scales.write({
      version: 1,
      scales: { [TOPIC]: [level('qs', 'QS'), level('ci', 'CI')] },
    });
    const placed = Object.fromEntries(
      Array.from({ length: TEXTS }, (_, n) => [
        idOf(n),
        {
          level: hashOf(`level:${n}`) % 10_000 < share * 10_000 ? 'qs' : 'ci',
          setBy: 'owner@example.com',
          setAt: NOW,
        },
      ]),
    );
    await documents.write({ version: 1, collections: { [TOPIC]: placed } });
  }
  const directory = new LevelDirectory({
    scales,
    documents,
    presence: new MemoryDocumentStore(),
  });
  await directory.load();
  return new ContentGate({ directory, catalog });
}

const MEMBER: StoredPerson = {
  id: '00000000-0000-4000-8000-000000000001',
  sub: null,
  email: 'ana@example.com',
  name: 'Ana',
  picture: null,
  role: 'member',
  topics: [TOPIC],
  features: ['search'],
  invitedBy: 'owner@example.com',
  createdAt: NOW,
  lastLoginAt: null,
};

const p95 = (samples: number[]): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
};

interface Searchers {
  readonly budgeted: SearchService;
  readonly oracle: SearchService;
}

interface Asked {
  readonly q: string;
  readonly mode: SearchMode;
  readonly view: LevelView;
}

const top10 = async (search: SearchService, { q, mode, view }: Asked) =>
  (await search.search(TOPIC, { q, mode, limit: 10 }, { view })).items.map(
    (item) => item.id,
  );

interface Row {
  readonly mode: SearchMode;
  readonly share: number;
  readonly visible: number;
  readonly recall: number;
  readonly p95: number;
  /** Index calls and candidates asked, per search. */
  readonly calls: number;
  readonly candidates: number;
}

/** The first answer and every run's time of one question. */
async function timed(search: SearchService, asked: Asked) {
  const samples: number[] = [];
  let first: string[] = [];
  for (let run = 0; run < RUNS; run++) {
    const started = performance.now();
    const got = await top10(search, asked);
    samples.push(performance.now() - started);
    if (run === 0) first = got;
  }
  return { first, samples };
}

async function measure(
  searchers: Searchers,
  { mode, share, view }: { mode: SearchMode; share: number; view: LevelView },
): Promise<Omit<Row, 'visible'>> {
  let hits = 0;
  let wanted = 0;
  const samples: number[] = [];
  const before = { ...calls };
  for (const q of LATENCY_QUERIES) {
    const truth = await top10(searchers.oracle, { q, mode, view });
    const got = await timed(searchers.budgeted, { q, mode, view });
    samples.push(...got.samples);
    // QMD's ranking is not the in-memory one: count how many of the page it fills.
    hits += QMD_INDEX
      ? Math.min(got.first.length, truth.length)
      : truth.filter((id) => got.first.includes(id)).length;
    wanted += truth.length;
  }
  const searches = LATENCY_QUERIES.length * RUNS;
  return {
    mode,
    share,
    recall: wanted ? hits / wanted : 1,
    p95: p95(samples),
    calls: (calls.count - before.count) / searches,
    candidates: (calls.candidates - before.candidates) / searches,
  };
}

/** One slice: its view, a warm-up pass (JIT, catalog memo) not counted, then each mode. */
async function sliceRows(
  searchers: Searchers,
  { catalog, share }: { catalog: CatalogRegistry; share: number },
): Promise<Row[]> {
  const view = (await gateOf(catalog, share)).viewFor(MEMBER, TOPIC);
  const collection = catalog.get(TOPIC);
  const visible = collection ? view.visibleShare(collection) : 1;
  for (const mode of MODES) await measure(searchers, { mode, share, view });
  const rows: Row[] = [];
  for (const mode of MODES)
    rows.push({
      ...(await measure(searchers, { mode, share, view })),
      visible,
    });
  return rows;
}

/**
 * The real QMD as the app calls it. QMD 2.8.3 cannot give an unlimited ranking (its `query`
 * tool takes 20 hits per sub-search whatever the limit), so the oracle stays the in-memory one
 * and the recall column is an upper bound: how much of the first page QMD's hits can fill.
 */
async function qmdIndexes(name: string, docs: ReadonlyMap<string, string>) {
  const qmd = new QmdMcpAdapter({
    command: 'qmd',
    args: ['--index', name, 'mcp'],
  });
  await qmd.start();
  return {
    budgeted: qmd,
    oracle: indexOf(docs, true),
    close: () => qmd.close(),
  };
}

function memoryIndexes(docs: ReadonlyMap<string, string>) {
  return {
    budgeted: indexOf(docs, false),
    oracle: indexOf(docs, true),
    close: async () => undefined,
  };
}

async function rowsOf(): Promise<Row[]> {
  const vault = vaultOf();
  const catalog = new CatalogRegistry(vault);
  await catalog.load();
  const indexes = QMD_INDEX
    ? await qmdIndexes(QMD_INDEX, vault.docs)
    : memoryIndexes(vault.docs);
  const searchers = {
    budgeted: new SearchService({
      catalog,
      index: counted(indexes.budgeted),
      vault,
    }),
    oracle: new SearchService({ catalog, index: indexes.oracle, vault }),
  };
  const rows: Row[] = [];
  for (const share of SLICES)
    rows.push(...(await sliceRows(searchers, { catalog, share })));
  await indexes.close();
  return rows;
}

function report(rows: readonly Row[]): { text: string; ok: boolean } {
  let ok = true;
  const lines = [
    `| Modo | Fatia | Visível | Recall@10 | Limite | p95 (ms) | Limite p95 (ms) | Chamadas ao índice | Candidatos pedidos | Resultado |`,
    `|---|---|---|---|---|---|---|---|---|---|`,
  ];
  for (const row of rows) {
    const base = rows.find((one) => one.mode === row.mode && one.share === 1);
    const recallMin = NFR1[row.share];
    const p95Max =
      row.share === 0.2 && base ? base.p95 * NFR2_FACTOR : undefined;
    const pass =
      (recallMin === undefined || row.recall >= recallMin) &&
      (p95Max === undefined || row.p95 <= p95Max);
    ok &&= pass;
    lines.push(
      `| ${row.mode} | ${row.share * 100} % | ${(row.visible * 100).toFixed(1)} % | ${row.recall.toFixed(3)} | ${recallMin ?? '—'} | ${row.p95.toFixed(2)} | ${p95Max?.toFixed(2) ?? '—'} | ${row.calls.toFixed(2)} | ${Math.round(row.candidates)} | ${pass ? 'OK' : 'FALHA'} |`,
    );
  }
  return { text: lines.join('\n'), ok };
}

function writeVault(dir: string): void {
  const vault = vaultOf();
  for (const [id, body] of vault.docs) {
    const path = join(dir, TOPIC, id);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
  }
  process.stdout.write(
    `${vault.docs.size} texts written under ${dir}/${TOPIC}\n`,
  );
}

if (WRITE_VAULT) {
  writeVault(WRITE_VAULT);
  process.exit(0);
}
const rows = await rowsOf();
const { text: table, ok } = report(rows);
const index = QMD_INDEX
  ? `QMD 2.8.3 real (índice "${QMD_INDEX}", sem rerank)`
  : 'índice em memória determinístico';
const header = `Coleção sintética: ${TEXTS} textos, ${index}, ${LATENCY_QUERIES.length} perguntas reais por modo, ${RUNS} medições por pergunta (p95 sobre ${LATENCY_QUERIES.length * RUNS}), Node ${process.version}, ${new Date().toISOString()}.`;
process.stdout.write(
  `${header}\n\n${table}\n\n${ok ? 'NFR-1 e NFR-2: OK' : 'NFR-1 ou NFR-2: FALHA'}\n`,
);
if (OUT) writeFileSync(OUT, `${header}\n\n${table}\n`);
process.exit(ok ? 0 : 1);
