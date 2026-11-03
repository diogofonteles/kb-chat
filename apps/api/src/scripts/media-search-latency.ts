// NFR-1 of KBC-039 (ADR 0024): p95 of the media query over a synthetic corpus of 2,000 h of
// transcripts (5 s segments, 12 words each from a Zipf-like vocabulary with the UDV terms).
// Builds a throwaway database in the OS temp dir; prints and exits 0 unless --strict.
// Usage: tsx src/scripts/media-search-latency.ts [--hours 2000] [--strict]
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { MAX_MEDIA_HITS } from '@kb-chat/contracts';
import {
  inTransaction,
  openMediaDatabase,
} from '../adapters/sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from '../adapters/sqlite/media-migrations.js';
import { SqliteMediaSearch } from '../adapters/sqlite/sqlite-media-search.js';
import { termsOf } from '../modules/search/media-hits.js';
import type { MediaSearchQuery } from '../ports/media-search.js';

const arg = (name: string, fallback: number): number => {
  const at = process.argv.indexOf(name);
  const value = at >= 0 ? Number(process.argv[at + 1]) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const HOURS = arg('--hours', 2_000);
const STRICT = process.argv.includes('--strict');
const TARGET_MS = 150;
const TALK_HOURS = 1.5;
const SEGMENT_MS = 5_000;
const WORDS_PER_SEGMENT = 12;
const RUNS = 3;

const TERMS = [
  'hoasca',
  'mariri',
  'chacrona',
  'tiuaco',
  'burracheira',
  'caiano',
];
const COMMON = ['vegetal', 'mestre', 'sessão', 'união', 'caminho', 'luz'];
/** 4,000 filler words; word i is drawn with weight 1/(i+1) (Zipf). */
const FILLER = Array.from({ length: 4_000 }, (_, i) => `palavra${i}`);

const QUERIES = [
  'hoasca',
  'tiuaco mariri',
  'burracheira',
  'vegetal',
  'mestre caminho',
  'luz do vegetal',
  'palavra7',
  'palavra3999',
  'o que é a chacrona',
  'caiano sessão',
];

/** A deterministic generator (mulberry32), so two runs measure the same corpus. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function zipfPicker(next: () => number): () => string {
  const weights = FILLER.map((_, i) => 1 / (i + 1));
  const cumulative: number[] = [];
  weights.reduce((sum, weight, i) => (cumulative[i] = sum + weight), 0);
  const total = cumulative.at(-1) ?? 1;
  return () => {
    const target = next() * total;
    let low = 0;
    let high = cumulative.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((cumulative[mid] ?? 0) < target) low = mid + 1;
      else high = mid;
    }
    return FILLER[low] ?? 'palavra';
  };
}

function sentence(next: () => number, filler: () => string): string {
  return Array.from({ length: WORDS_PER_SEGMENT }, () => {
    const roll = next();
    if (roll < 0.002) return TERMS[Math.floor(next() * TERMS.length)];
    if (roll < 0.05) return COMMON[Math.floor(next() * COMMON.length)];
    return filler();
  }).join(' ');
}

const NOW = new Date().toISOString();

/** Most talks in the UDV, a third in a large sub-collection, 1 in 50 in a small one. */
const topicOf = (talk: number): string => {
  if (talk % 50 === 0) return 'udv/pequeno';
  return talk % 3 === 0 ? 'udv/palavra-do-mestre' : 'udv';
};

function insertTalk(db: DatabaseSync, talk: number, text: () => string): void {
  const id = `00000000-0000-4000-8000-${String(talk).padStart(12, '0')}`;
  db.prepare(
    `INSERT INTO media (id, topic, title, authorship, author, owner_principal, file_name,
       upload_bytes, status, duration_ms, created_at, updated_at)
     VALUES (?, ?, ?, 'outros-autores', ?, 'owner', 'a.mp3', 1, 'ready', ?, ?, ?)`,
  ).run(
    id,
    topicOf(talk),
    `Palestra ${talk}`,
    talk % 2 === 0 ? 'mestre-gabriel' : null,
    TALK_HOURS * 3_600_000,
    NOW,
    NOW,
  );
  insertTranscript(db, { talk, id, text });
}

function insertTranscript(
  db: DatabaseSync,
  { talk, id, text }: { talk: number; id: string; text: () => string },
): void {
  const transcript = `t-${id}`;
  db.prepare(
    `INSERT INTO transcripts (id, media_id, version, provider, model, parameters,
       parameters_version, terms_version, vad, speech_ratio, elapsed_ms, raw_path,
       filter_version, confidence_version, confidence, word_count, removed_words,
       low_words, created_at)
     VALUES (?, ?, 1, 'mlx-whisper', 'synthetic', '{}', '1', 1, 'applied', 1, 0, 'r.json',
       1, 1, ?, 0, 0, 0, ?)`,
  ).run(transcript, id, talk % 10 === 0 ? 'low' : 'normal', NOW);
  const segment = db.prepare(
    `INSERT INTO segments (transcript_id, position, start_ms, end_ms, text)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const count = (TALK_HOURS * 3_600_000) / SEGMENT_MS;
  for (let position = 0; position < count; position++)
    segment.run(
      transcript,
      position,
      position * SEGMENT_MS,
      (position + 1) * SEGMENT_MS,
      text(),
    );
}

function buildCorpus(db: DatabaseSync): number {
  const next = random(39);
  const filler = zipfPicker(next);
  const talks = Math.ceil(HOURS / TALK_HOURS);
  inTransaction(db, () => {
    for (let talk = 1; talk <= talks; talk++)
      insertTalk(db, talk, () => sentence(next, filler));
    db.exec(
      'INSERT INTO segments_fts (rowid, text) SELECT rowid, text FROM segments',
    );
  });
  db.exec("INSERT INTO segments_fts (segments_fts) VALUES ('optimize')");
  return talks;
}

const p95 = (samples: readonly number[]): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ??
    0
  );
};

const MAIN_OF = new Map<string, string | null>([
  ['udv', 'mestre-gabriel'],
  ['udv/palavra-do-mestre', 'mestre-gabriel'],
  ['udv/pequeno', 'mestre-gabriel'],
]);

/** Where each query runs: the whole tree, a small sub-collection, the main author only. */
const SCENARIOS: readonly {
  readonly name: string;
  readonly topics: readonly string[];
  readonly authors: MediaSearchQuery['authors'];
}[] = [
  {
    name: 'acervo',
    topics: ['udv', 'udv/palavra-do-mestre', 'udv/pequeno'],
    authors: { kind: 'any' },
  },
  {
    name: 'sub-acervo pequeno',
    topics: ['udv/pequeno'],
    authors: { kind: 'any' },
  },
  {
    name: 'autor principal',
    topics: ['udv', 'udv/palavra-do-mestre', 'udv/pequeno'],
    authors: { kind: 'main', mainOf: MAIN_OF },
  },
];

function timeOne(
  search: SqliteMediaSearch,
  q: string,
  scenario: (typeof SCENARIOS)[number],
): { readonly ms: number; readonly total: number } {
  const startedAt = performance.now();
  search.hasTranscripts(scenario.topics);
  const found = search.search({
    terms: termsOf(q),
    topics: scenario.topics,
    authors: scenario.authors,
    limit: MAX_MEDIA_HITS,
  });
  return { ms: performance.now() - startedAt, total: found.total };
}

const CASES = SCENARIOS.flatMap((scenario) =>
  QUERIES.map((q) => ({ scenario, q, key: `${scenario.name} · ${q}` })),
);

function measure(search: SqliteMediaSearch): Map<string, number[]> {
  const samples = new Map<string, number[]>();
  const runs = Array.from({ length: RUNS }, (_, run) => run);
  for (const [run, { scenario, q, key }] of runs.flatMap((run) =>
    CASES.map((one) => [run, one] as const),
  )) {
    const { ms, total } = timeOne(search, q, scenario);
    samples.set(key, [...(samples.get(key) ?? []), ms]);
    if (run === 0) console.log(`  ${key}: ${total} passages`);
  }
  return samples;
}

const dir = mkdtempSync(join(tmpdir(), 'kbchat-media-latency-'));
try {
  const db = openMediaDatabase(join(dir, 'media.db'), MEDIA_MIGRATIONS);
  const builtAt = performance.now();
  const talks = buildCorpus(db);
  const segments = Number(
    db.prepare('SELECT count(*) AS n FROM segments').get()?.['n'],
  );
  console.log(
    `Corpus: ${HOURS} h, ${talks} talks, ${segments} segments, built in ${Math.round((performance.now() - builtAt) / 1000)} s`,
  );
  const samples = measure(new SqliteMediaSearch(db));
  const all = [...samples.values()].flat();
  for (const [q, times] of samples)
    console.log(`  p95 ${q}: ${p95(times).toFixed(1)} ms`);
  const overall = p95(all);
  console.log(
    `Media query p95: ${overall.toFixed(1)} ms (target ≤ ${TARGET_MS} ms, ${all.length} queries)`,
  );
  db.close();
  if (STRICT && overall > TARGET_MS) process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
