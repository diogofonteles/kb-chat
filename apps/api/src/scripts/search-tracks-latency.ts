// NFR-3 of KBC-101: the documents search (T2) with 2,000 track documents more in the
// collection, the media.db check counted. In process, over a synthetic collection of texts
// and a throwaway media database with the tracks and their transcripts; the index is an
// in-memory one whose cost does not grow with the tracks (QMD's own time is the same with or
// without them, and is added on top). Prints p95 per mode without and with the tracks.
// Usage: tsx src/scripts/search-tracks-latency.ts [--texts 3000] [--tracks 2000]
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { SearchMode } from '@kb-chat/contracts';
import { openMediaDatabase } from '../adapters/sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from '../adapters/sqlite/media-migrations.js';
import { SqliteMediaSearch } from '../adapters/sqlite/sqlite-media-search.js';
import { SqliteMediaStore } from '../adapters/sqlite/sqlite-media-store.js';
import { SqliteTranscriptStore } from '../adapters/sqlite/sqlite-transcript-store.js';
import { CatalogRegistry } from '../modules/catalog/index.js';
import { MediaTrackShelf } from '../modules/media-documents/index.js';
import { ResearchTools } from '../modules/research/index.js';
import { SearchService, SearchWithMedia } from '../modules/search/index.js';
import type { IndexHit, IndexQuery } from '../ports/search-index.js';
import type { TopicFolder } from '../ports/vault-reader.js';

const arg = (name: string, fallback: number): number => {
  const at = process.argv.indexOf(name);
  const value = at >= 0 ? Number(process.argv[at + 1]) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const TEXTS = arg('--texts', 3_000);
const TRACKS = arg('--tracks', 2_000);
const SEGMENTS = 40;
const RUNS = 5;
const TOPIC = 'udv';
const NOW = new Date().toISOString();
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

const trackId = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const recordingId = (n: number) =>
  `00000000-0000-4000-8000-${String(Math.floor(n / 6)).padStart(12, '0')}`;

function textDocument(n: number): string {
  return `---\ntitle: Texto ${n}\ngenre: article_or_essay\ndepth: 2\nrelevance: core\nauthor_group: outros-autores\n---\n\n${wordsOf(n, 200)}\n`;
}

function trackDocument(n: number): string {
  const anchors = Array.from(
    { length: SEGMENTS },
    (_, i) =>
      `[${Math.floor((i * 5) / 60)}:${String((i * 5) % 60).padStart(2, '0')}] ${wordsOf(n + i, 12)}`,
  ).join('\n\n');
  return `---\ntitle: Faixa ${n}\ngenre: talk_or_interview\ndepth: 2\nrelevance: core\nauthor_group: outros-autores\nkb_chat_media_id: ${trackId(n)}\nkb_chat_media_kind: track\nkb_chat_recording_id: ${recordingId(n)}\nkb_chat_recording_title: Palestra ${Math.floor(n / 6)}\nkb_chat_track_ordinal: ${(n % 6) + 1}\nkb_chat_tracks_total: 6\nkb_chat_fingerprint: f${n}\n---\n\n# Faixa ${n}\n\nGravação: Palestra · faixa 1 de 6\n\n${anchors}\n`;
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
    const text = trackDocument(n);
    docs.set(
      `raw/media/${recordingId(n)}/${trackId(n)}.md`,
      asTexts ? text.replace(/^kb_chat_.*\n/gm, '') : text,
    );
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

function insertTrack(db: DatabaseSync, n: number): void {
  const id = trackId(n);
  const insert = db.prepare(
    `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
       upload_bytes, status, duration_ms, created_at, updated_at, parent_media_id,
       parent_start_ms, parent_end_ms, track_ordinal)
     VALUES (?, ?, ?, 'outros-autores', 'owner', 'a.m4a', 1, 'ready', 200000, ?, ?, ?, 0, 200000, ?)`,
  );
  insert.run(id, TOPIC, `Faixa ${n}`, NOW, NOW, recordingId(n), (n % 6) + 1);
  db.prepare(
    `INSERT INTO transcripts (id, media_id, version, provider, model, parameters,
       parameters_version, terms_version, vad, speech_ratio, elapsed_ms, raw_path,
       filter_version, confidence_version, confidence, word_count, removed_words,
       low_words, created_at)
     VALUES (?, ?, 1, 'mlx-whisper', 'synthetic', '{}', '1', 1, 'applied', 1, 0, 'r.json',
       1, 1, 'normal', 0, 0, 0, ?)`,
  ).run(`t-${id}`, id, NOW);
  const segment = db.prepare(
    `INSERT INTO segments (transcript_id, position, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < SEGMENTS; i++)
    segment.run(`t-${id}`, i, i * 5000, (i + 1) * 5000, wordsOf(n + i, 12));
}

function insertRecordings(db: DatabaseSync): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO media (id, topic, title, authorship, owner_principal, file_name,
       upload_bytes, status, duration_ms, created_at, updated_at)
     VALUES (?, ?, ?, 'outros-autores', 'owner', 'a.mp3', 1, 'ready', 1200000, ?, ?)`,
  );
  for (let n = 0; n < TRACKS; n++)
    insert.run(
      recordingId(n),
      TOPIC,
      `Palestra ${Math.floor(n / 6)}`,
      NOW,
      NOW,
    );
}

function mediaDatabase(dir: string): DatabaseSync {
  const db = openMediaDatabase(join(dir, 'media.db'), MEDIA_MIGRATIONS);
  db.exec('BEGIN');
  insertRecordings(db);
  for (let n = 0; n < TRACKS; n++) insertTrack(db, n);
  db.exec('COMMIT');
  return db;
}

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

async function measure(
  db: DatabaseSync,
  tracks: number,
): Promise<Record<SearchMode, number>> {
  const { combined, shelf } = await searcherOf(db, tracks);
  const result = {} as Record<SearchMode, number>;
  let seen = 0;
  for (const mode of ['exact', 'semantic', 'all'] as const) {
    const samples: number[] = [];
    for (let run = 0; run < RUNS; run++)
      for (const q of QUERIES) {
        const started = performance.now();
        const found = await combined.search(
          TOPIC,
          { q, mode },
          {
            viewer: {
              mayHear: true,
              seesTracks: true,
              canSee: () => true,
              tracks: shelf(),
            },
          },
        );
        samples.push(performance.now() - started);
        seen += found.trackTotal;
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

const dir = mkdtempSync(join(tmpdir(), 'kbchat-search-tracks-'));
try {
  const db = mediaDatabase(dir);
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
