// NFR-1 of KBC-039 (ADR 0024): p95 of the media query over a synthetic corpus of 2,000 h of
// transcripts (5 s segments, 12 words each from a Zipf-like vocabulary with the UDV terms).
// Builds a throwaway database in the OS temp dir; prints and exits 0 unless --strict.
// KBC-070 NFR-1: every talk also cut into tracks, with 20,000 accepted subject links.
// KBC-096 NFR-1: the library's search over those tracks, adapter and whole service.
// Usage: tsx src/scripts/media-search-latency.ts [--hours 2000] [--links 20000] [--strict]
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  EMPTY_FILTERS,
  LIBRARY_PAGE_SIZE,
  LIBRARY_SEARCH_MAX,
  MAX_MEDIA_HITS,
} from '@kb-chat/contracts';
import {
  inTransaction,
  openMediaDatabase,
} from '../adapters/sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from '../adapters/sqlite/media-migrations.js';
import { SqliteMediaSearch } from '../adapters/sqlite/sqlite-media-search.js';
import { SqliteListeningStore } from '../adapters/sqlite/sqlite-listening-store.js';
import { SqliteMediaStore } from '../adapters/sqlite/sqlite-media-store.js';
import { SqliteTrackSubjectStore } from '../adapters/sqlite/sqlite-track-subject-store.js';
import { LibraryService } from '../modules/media/library-service.js';
import { SubjectSearch } from '../modules/search/index.js';
import { termsOf } from '../modules/search/media-hits.js';
import { SubjectDirectory } from '../modules/track-subjects/index.js';
import type { MediaSearchQuery } from '../ports/media-search.js';

const arg = (name: string, fallback: number): number => {
  const at = process.argv.indexOf(name);
  const value = at >= 0 ? Number(process.argv[at + 1]) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const HOURS = arg('--hours', 2_000);
const LINKS = arg('--links', 20_000);
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

const TRACKS_PER_TALK = 6;
const CONCEPTS = Array.from({ length: 300 }, (_, i) => `Conceito ${i}`);

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

/** Six tracks over the talk, each with its own share of the speech, as a publish leaves. */
function insertTracks(db: DatabaseSync, talk: number): void {
  const parent = `00000000-0000-4000-8000-${String(talk).padStart(12, '0')}`;
  const length = (TALK_HOURS * 3_600_000) / TRACKS_PER_TALK;
  for (let ordinal = 1; ordinal <= TRACKS_PER_TALK; ordinal++) {
    const id = `10000000-0000-4000-8000-${String(talk * 10 + ordinal).padStart(12, '0')}`;
    const startMs = (ordinal - 1) * length;
    db.prepare(
      `INSERT INTO media (id, topic, title, authorship, author, owner_principal, file_name,
         upload_bytes, status, duration_ms, created_at, updated_at, parent_media_id,
         parent_start_ms, parent_end_ms, track_ordinal)
       VALUES (?, ?, ?, 'outros-autores', ?, 'owner', 'a.m4a', 1, 'ready', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      topicOf(talk),
      `Pergunta ${ordinal} da palestra ${talk}`,
      talk % 2 === 0 ? 'mestre-gabriel' : null,
      length,
      NOW,
      NOW,
      parent,
      startMs,
      startMs + length,
      ordinal,
    );
    copySpeech(db, { parent, id, startMs, endMs: startMs + length });
  }
}

interface TrackSpan {
  readonly parent: string;
  readonly id: string;
  readonly startMs: number;
  readonly endMs: number;
}

function copySpeech(db: DatabaseSync, span: TrackSpan): void {
  copyTranscript(db, span);
  db.prepare(
    `INSERT INTO segments (transcript_id, position, start_ms, end_ms, text)
     SELECT ?, position, start_ms - ?, end_ms - ?, text FROM segments
     WHERE transcript_id = ? AND start_ms >= ? AND end_ms <= ?`,
  ).run(
    `t-${span.id}`,
    span.startMs,
    span.startMs,
    `t-${span.parent}`,
    span.startMs,
    span.endMs,
  );
}

function copyTranscript(db: DatabaseSync, span: TrackSpan): void {
  db.prepare(
    `INSERT INTO transcripts (id, media_id, version, provider, model, parameters,
       parameters_version, terms_version, vad, speech_ratio, elapsed_ms, raw_path,
       filter_version, confidence_version, confidence, word_count, removed_words,
       low_words, created_at)
     SELECT ?, ?, version, provider, model, parameters, parameters_version, terms_version, vad,
       speech_ratio, elapsed_ms, raw_path, filter_version, confidence_version, confidence,
       word_count, removed_words, low_words, created_at
     FROM transcripts WHERE media_id = ?`,
  ).run(`t-${span.id}`, span.id, span.parent);
}

/** Accepted links spread over the tracks, popular concepts holding many (1/rank). */
function insertLinks(db: DatabaseSync, next: () => number): void {
  const tracks = db
    .prepare('SELECT id FROM media WHERE parent_media_id IS NOT NULL')
    .all()
    .map((row) => String(row['id']));
  const summary = db.prepare(
    `INSERT INTO media_track_subjects (media_id, summary, updated_at) VALUES (?, ?, ?)`,
  );
  const link = db.prepare(
    `INSERT OR IGNORE INTO media_subject_links (id, media_id, kind, subject_key, concept_name,
       source, status, created_at)
     VALUES (?, ?, 'concept', ?, ?, 'manual', 'accepted', ?)`,
  );
  for (const [at, id] of tracks.entries())
    summary.run(
      id,
      `Resumo com ${TERMS[at % TERMS.length]} e ${COMMON[at % COMMON.length]}.`,
      NOW,
    );
  for (let at = 0; at < LINKS; at++) {
    const rank = Math.min(
      CONCEPTS.length - 1,
      Math.floor(Math.exp(next() * Math.log(CONCEPTS.length))) - 1,
    );
    const name = CONCEPTS[rank] ?? 'Conceito 0';
    const media = tracks[at % tracks.length] ?? '';
    link.run(`l${at}`, media, `concept:${name.toLowerCase()}`, name, NOW);
  }
}

/** After the KBC-039 measure, which keeps its corpus: the talks cut, with their links. */
function buildTracks(db: DatabaseSync, talks: number): void {
  const firstRow = Number(
    db.prepare('SELECT max(rowid) AS n FROM segments').get()?.['n'],
  );
  inTransaction(db, () => {
    for (let talk = 1; talk <= talks; talk++) insertTracks(db, talk);
    insertLinks(db, random(70));
    db.prepare(
      'INSERT INTO segments_fts (rowid, text) SELECT rowid, text FROM segments WHERE rowid > ?',
    ).run(firstRow);
  });
  db.exec("INSERT INTO segments_fts (segments_fts) VALUES ('optimize')");
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
  // As the API does: one tally for the "Autoria" counts, then the passages.
  const terms = termsOf(q);
  const tally = search.tally({
    terms,
    topics: scenario.topics,
    mainOf: MAIN_OF,
  });
  search.search({
    terms,
    topics: scenario.topics,
    authors: scenario.authors,
    limit: MAX_MEDIA_HITS,
    count: false,
  });
  const total = tally.main + tally.others;
  return { ms: performance.now() - startedAt, total };
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

const SUBJECT_QUERIES = ['', 'hoasca', 'vegetal', 'palavra7', 'mestre caminho'];
const SUBJECT_CONCEPTS = [
  'Conceito 0',
  'Conceito 5',
  'Conceito 60',
  'Conceito 299',
];
const WHOLE_TREE = SCENARIOS[0]?.topics ?? [];

function subjectSearchOver(db: DatabaseSync, search: SqliteMediaSearch) {
  return new SubjectSearch({
    links: search,
    lookup: new SubjectDirectory({
      store: new SqliteTrackSubjectStore(db),
      rootOf: () => 'udv',
      conceptsOf: () => CONCEPTS,
    }),
    authors: {
      mainOf: () => 'mestre-gabriel',
      authorOf: () => null,
    },
  });
}

/** One search with a subject on, as the API runs it: hits, chips and the counts. */
function timeSubject(
  subjects: SubjectSearch,
  concepts: readonly string[],
  q: string,
): number {
  const startedAt = performance.now();
  const query = {
    topic: 'udv',
    topics: WHOLE_TREE,
    q,
    filters: { ...EMPTY_FILTERS, concepts: [...concepts] },
  };
  const part = subjects.find(query);
  subjects.withSubjects(part.hits);
  subjects.counts(query, { kind: 'any' });
  return performance.now() - startedAt;
}

/** The same with no subject chosen: only the counts and chips are new (KBC-039's budget). */
function timeCounts(subjects: SubjectSearch, q: string): number {
  const startedAt = performance.now();
  const query = { topic: 'udv', topics: WHOLE_TREE, q, filters: EMPTY_FILTERS };
  subjects.counts(query, { kind: 'any' });
  return performance.now() - startedAt;
}

const SUBJECT_CASES = SUBJECT_CONCEPTS.flatMap((concept) =>
  SUBJECT_QUERIES.map((q) => ({ concept, q })),
);

function measureFiltered(subjects: SubjectSearch): number[] {
  return Array.from({ length: RUNS }).flatMap((_, run) =>
    SUBJECT_CASES.map(({ concept, q }) => {
      const ms = timeSubject(subjects, [concept], q);
      if (run === 0) console.log(`  ${concept} · "${q}": ${ms.toFixed(1)} ms`);
      return ms;
    }),
  );
}

function measureSubjects(subjects: SubjectSearch): void {
  const filtered = measureFiltered(subjects);
  const counted = Array.from({ length: RUNS }).flatMap(() =>
    QUERIES.map((q) => timeCounts(subjects, q)),
  );
  console.log(
    `Subject filter p95: ${p95(filtered).toFixed(1)} ms (target ≤ ${TARGET_MS} ms, ${filtered.length} queries, ${LINKS} links)`,
  );
  console.log(
    `Subject counts alone p95: ${p95(counted).toFixed(1)} ms, on top of the media query`,
  );
  if (STRICT && p95(filtered) > TARGET_MS) process.exitCode = 1;
}

const LIBRARY_QUERIES = [...QUERIES, 'padre orlando', 'pergunta 3', '???'];
const LIBRARY_ADAPTER_MS = 150;
const LIBRARY_SERVICE_MS = 400;

/** A person who sees all of it, or one small sub-collection. */
const seesAll = {
  principal: 'someone',
  isMaster: false,
  canUpload: false,
  seesTracks: true,
  seesSubjects: false,
  searchesSpeech: true,
  canSee: () => true,
};

/** The transcript part alone: every media asked, a page of passages read. */
function timeSpeech(
  search: SqliteMediaSearch,
  ids: readonly string[],
  q: string,
): number {
  const startedAt = performance.now();
  const terms = termsOf(q);
  const { places } = search.spokenAmong({
    terms,
    ids,
    tracks: true,
    limit: LIBRARY_SEARCH_MAX,
  });
  search.passagesAt(
    terms,
    places.slice(0, LIBRARY_PAGE_SIZE).map((one) => one.place),
  );
  return performance.now() - startedAt;
}

function libraryServiceOver(db: DatabaseSync, search: SqliteMediaSearch) {
  return new LibraryService({
    store: new SqliteMediaStore(db),
    listening: new SqliteListeningStore(db),
    authorOf: () => null,
    speech: search,
    about: search,
    scopeOf: (topic) => [topic],
  });
}

function timeLibrary(
  library: LibraryService,
  q: string,
  topic?: string,
): { readonly ms: number; readonly total: number } {
  const startedAt = performance.now();
  const page = library.search(seesAll, { q, ...(topic ? { topic } : {}) });
  return { ms: performance.now() - startedAt, total: page.total };
}

/** Everyone's library and one small sub-collection, as whole searches. */
function timeWhole(library: LibraryService, q: string, log: boolean): number[] {
  return [undefined, 'udv/pequeno'].map((topic) => {
    const { ms, total } = timeLibrary(library, q, topic);
    if (log)
      console.log(
        `  library "${q}" in ${topic ?? 'everything'}: ${total} results, ${ms.toFixed(1)} ms`,
      );
    return ms;
  });
}

function measureLibrary(db: DatabaseSync, search: SqliteMediaSearch): void {
  const ids = db
    .prepare('SELECT id FROM media ORDER BY parent_media_id IS NULL, id')
    .all()
    .map((row) => String(row['id']));
  const library = libraryServiceOver(db, search);
  const runs = Array.from({ length: RUNS }, (_, run) => run);
  const cases = runs.flatMap((run) => LIBRARY_QUERIES.map((q) => ({ q, run })));
  const speech = cases.map(({ q }) => timeSpeech(search, ids, q));
  const whole = cases.flatMap(({ q, run }) => timeWhole(library, q, run === 0));
  console.log(
    `Library speech p95: ${p95(speech).toFixed(1)} ms, worst ${Math.max(...speech).toFixed(1)} (target ≤ ${LIBRARY_ADAPTER_MS} ms, ${ids.length} media)`,
  );
  console.log(
    `Library search p95: ${p95(whole).toFixed(1)} ms, worst ${Math.max(...whole).toFixed(1)} (target ≤ ${LIBRARY_SERVICE_MS} ms)`,
  );
  if (
    STRICT &&
    (p95(speech) > LIBRARY_ADAPTER_MS || p95(whole) > LIBRARY_SERVICE_MS)
  )
    process.exitCode = 1;
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
  const search = new SqliteMediaSearch(db);
  const samples = measure(search);
  const all = [...samples.values()].flat();
  for (const [q, times] of samples)
    console.log(`  p95 ${q}: ${p95(times).toFixed(1)} ms`);
  const overall = p95(all);
  console.log(
    `Media query p95: ${overall.toFixed(1)} ms (target ≤ ${TARGET_MS} ms, ${all.length} queries)`,
  );
  buildTracks(db, talks);
  measureSubjects(subjectSearchOver(db, search));
  measureLibrary(db, search);
  db.close();
  if (STRICT && overall > TARGET_MS) process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
