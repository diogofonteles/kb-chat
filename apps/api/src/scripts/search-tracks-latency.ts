// NFR-3 of KBC-101: the documents search (T2) with 2,000 track documents more in the
// collection, the media.db check counted. In process, over a synthetic collection of texts
// and a throwaway media database with the tracks and their transcripts; the index is an
// in-memory one whose cost does not grow with the tracks (QMD's own time is the same with or
// without them, and is added on top). Prints p95 per mode without and with the tracks.
// Usage: tsx src/scripts/search-tracks-latency.ts [--texts 3000] [--tracks 2000]
import { mkdtempSync, rmSync } from 'node:fs';
import { OPEN_VIEW } from '../modules/access-levels/index.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { SearchMode } from '@kb-chat/contracts';
import { privateTemp } from '../../../../tools/test-temp.mjs';
import { SqliteMediaSearch } from '../adapters/sqlite/sqlite-media-search.js';
import { SqliteMediaStore } from '../adapters/sqlite/sqlite-media-store.js';
import { SqliteTranscriptStore } from '../adapters/sqlite/sqlite-transcript-store.js';
import { CatalogRegistry } from '../modules/catalog/index.js';
import { MediaTrackShelf } from '../modules/media-documents/index.js';
import { ResearchTools } from '../modules/research/index.js';
import { SearchService, SearchWithMedia } from '../modules/search/index.js';
import type { IndexHit, IndexQuery } from '../ports/search-index.js';
import type { TopicFolder } from '../ports/vault-reader.js';
import {
  asText,
  trackDatabase,
  trackDocument,
  trackPath,
  type TrackWorld,
} from './track-world.js';

const arg = (name: string, fallback: number): number => {
  const at = process.argv.indexOf(name);
  const value = at >= 0 ? Number(process.argv[at + 1]) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const TEXTS = arg('--texts', 3_000);
const TRACKS = arg('--tracks', 2_000);
const RUNS = 5;
const TOPIC = 'udv';
const WORDS = Array.from({ length: 600 }, (_, i) => `palavra${i}`);
const QUERIES = [
  'palavra1',
  'palavra7 palavra9',
  'palavra42',
  'palavra100 palavra3',
  'palavra599',
  'hoasca',
  'palavra5 palavra6 palavra7',
  'palavra250',
];

/** Deterministic words: the same corpus every run. */
const wordsOf = (seed: number, count: number): string =>
  Array.from(
    { length: count },
    (_, i) => WORDS[(seed * 31 + i * 17) % WORDS.length],
  ).join(' ');

function textDocument(n: number): string {
  return `---\ntitle: Texto ${n}\ngenre: article_or_essay\ndepth: 2\nrelevance: core\nauthor_group: outros-autores\n---\n\n${wordsOf(n, 200)}\n`;
}

/**
 * The collection's files in memory: the texts, and the tracks when asked; `asTexts` writes
 * the same files without their `kb_chat_*` keys (the same text, read as texts).
 */
function vaultOf(tracks: number, asTexts = false) {
  const docs = new Map<string, string>();
  for (let n = 0; n < TEXTS; n++)
    docs.set(`raw/articles/texto-${n}.md`, textDocument(n));
  for (let n = 0; n < tracks; n++) {
    const text = trackDocument(n, wordsOf);
    docs.set(trackPath(n), asTexts ? asText(text) : text);
  }
  const topic: TopicFolder = { slug: TOPIC, title: 'UDV' };
  return {
    docs,
    listTopics: async () => [topic],
    listDocuments: async () => [...docs.keys()].sort(),
    readDocument: async (_topic: string, id: string) => docs.get(id) ?? null,
  };
}

/** A stable number per id (FNV-1a). */
function hashOf(text: string): number {
  let hash = 2166136261;
  for (const char of text)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

/** An index whose cost does not depend on how many documents match: a posting list. */
function indexOf(docs: ReadonlyMap<string, string>) {
  const postings = new Map<string, string[]>();
  // Tracks rank among the texts, not after them: the posting order mixes both.
  const mixed = [...docs].sort(([a], [b]) => hashOf(a) - hashOf(b));
  for (const [id, text] of mixed)
    for (const word of new Set(text.match(/palavra\d+/g) ?? []))
      postings.set(word, [...(postings.get(word) ?? []), id]);
  return {
    status: () => 'ok' as const,
    close: async () => undefined,
    search: async ({ q, limit }: IndexQuery): Promise<IndexHit[]> => {
      const [first] = q.split(' ');
      return (postings.get(first ?? '') ?? [])
        .slice(0, limit)
        .map((id, rank) => ({ id, score: 1 / (rank + 2), snippet: `${q}` }));
    },
  };
}

const WORLD: TrackWorld = { topic: TOPIC, tracks: TRACKS, words: wordsOf };

const p95 = (samples: number[]): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
};

async function searcherOf(db: DatabaseSync, tracks: number) {
  const vault = vaultOf(tracks);
  const catalog = new CatalogRegistry(vault);
  await catalog.load();
  const search = new SqliteMediaSearch(db);
  const documents = new SearchService({
    catalog,
    index: indexOf(vault.docs),
    vault,
  });
  const combined = new SearchWithMedia({
    documents,
    scopeOf: () => [TOPIC],
    media: search,
    passages: search,
    authors: { mainOf: () => null, authorOf: () => null },
  });
  const shelf = () =>
    new MediaTrackShelf({
      store: new SqliteMediaStore(db),
      transcripts: new SqliteTranscriptStore(db),
    });
  return { combined, shelf };
}

type Searcher = Awaited<ReturnType<typeof searcherOf>>;

/** One timed search; adds the track cards it counted. */
async function timedSearch(
  { combined, shelf }: Searcher,
  { q, mode }: { q: string; mode: SearchMode },
): Promise<{ ms: number; tracks: number }> {
  const viewer = {
    mayHear: true,
    seesTracks: true,
    canSee: () => true,
    tracks: shelf(),
  };
  const started = performance.now();
  // The bench measures a collection without levels (KBC-103: the open view).
  const found = await combined.search(
    TOPIC,
    { q, mode },
    { viewer, view: OPEN_VIEW },
  );
  return { ms: performance.now() - started, tracks: found.trackTotal };
}

async function measure(
  db: DatabaseSync,
  tracks: number,
): Promise<Record<SearchMode, number>> {
  const searcher = await searcherOf(db, tracks);
  const result = {} as Record<SearchMode, number>;
  let seen = 0;
  for (const mode of ['exact', 'semantic', 'all'] as const) {
    const samples: number[] = [];
    const queries = Array.from({ length: RUNS }, () => QUERIES).flat();
    for (const q of queries) {
      const timed = await timedSearch(searcher, { q, mode });
      samples.push(timed.ms);
      seen += timed.tracks;
    }
    result[mode] = p95(samples);
  }
  process.stdout.write(`track cards counted over every search: ${seen}\n`);
  return result;
}

/**
 * NFR-1: the exhaustive sweep's planning and its cut by phrases (no model), cold: the folded
 * corpus is built inside the first layout, as on a turn after a catalog load.
 */
interface Planning {
  readonly tracks: number;
  readonly asTexts?: boolean;
}

async function sweepPlanning(
  db: DatabaseSync,
  { tracks, asTexts = false }: Planning,
): Promise<number> {
  const vault = vaultOf(tracks, asTexts);
  const catalog = new CatalogRegistry(vault);
  await catalog.load();
  const search = new SearchService({
    catalog,
    index: indexOf(vault.docs),
    vault,
  });
  const tools = new ResearchTools({ search, catalog, vault });
  const shelf = new MediaTrackShelf({
    store: new SqliteMediaStore(db),
    transcripts: new SqliteTranscriptStore(db),
  });
  const started = performance.now();
  await tools.sweeps.layout(TOPIC, {
    plan: { target: {}, phrases: ['palavra7', 'palavra42'], extract: 'tudo' },
    batchChars: 24_000,
    tracks: shelf,
    view: OPEN_VIEW,
  });
  return performance.now() - started;
}

const median = (values: number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

async function planningTimes(
  db: DatabaseSync,
  planning: Planning,
): Promise<number> {
  const times: number[] = [];
  for (let run = 0; run < RUNS; run++)
    times.push(await sweepPlanning(db, planning));
  return median(times);
}

// Out of the system temp (CLAUDE.md, Quality): the repository's private temp root.
privateTemp();
const dir = mkdtempSync(join(tmpdir(), 'kbchat-search-tracks-'));
try {
  const db = trackDatabase(dir, WORLD);
  const without = await measure(db, 0);
  const withTracks = await measure(db, TRACKS);
  for (const mode of ['exact', 'semantic', 'all'] as const)
    process.stdout.write(
      `${mode}: p95 ${without[mode].toFixed(1)} ms without tracks, ${withTracks[mode].toFixed(1)} ms with ${TRACKS} track documents (+${(withTracks[mode] - without[mode]).toFixed(1)} ms)\n`,
    );
  const planned = await planningTimes(db, { tracks: 0 });
  const sameText = await planningTimes(db, { tracks: TRACKS, asTexts: true });
  const plannedTracks = await planningTimes(db, { tracks: TRACKS });
  const more = (value: number, base: number) =>
    `+${(((value - base) / base) * 100).toFixed(0)} %`;
  process.stdout.write(
    `sweep planning and phrase cut (median of ${RUNS}, cold): ${planned.toFixed(0)} ms over ${TEXTS} texts; ${sameText.toFixed(0)} ms with the same text of ${TRACKS} tracks as texts; ${plannedTracks.toFixed(0)} ms with ${TRACKS} tracks (${more(plannedTracks, planned)} over the texts alone, ${more(plannedTracks, sameText)} over the same text read as texts)\n`,
  );
  db.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
