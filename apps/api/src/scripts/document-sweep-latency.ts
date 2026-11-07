// KBC-100 review 6: how long the track documents' backstop sweep holds the event loop over a
// synthetic library of 2,000 h (1.5 h talks of 5 s segments, each cut into six tracks), every
// track already documented. Real media.db reads (media, transcripts, segments) and the real
// render; who speaks is read as a second pass over the segments, as the app reads the
// transcript again with its voices. Builds a throwaway database in the OS temp dir.
// Prints the longest slice (the longest the API waits) and exits 0 unless --strict.
// Usage: tsx src/scripts/document-sweep-latency.ts [--hours 2000] [--limit n] [--slice n] [--strict]
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  inTransaction,
  openMediaDatabase,
} from '../adapters/sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from '../adapters/sqlite/media-migrations.js';
import { SqliteMediaDocumentStore } from '../adapters/sqlite/sqlite-media-document-store.js';
import { SqliteMediaStore } from '../adapters/sqlite/sqlite-media-store.js';
import { SqliteTranscriptStore } from '../adapters/sqlite/sqlite-transcript-store.js';
import {
  MediaDocumentReconciler,
  SWEEP_LIMIT,
  SWEEP_SLICE,
  TrackDocumentSource,
} from '../modules/media-documents/index.js';

const arg = (name: string, fallback: number): number => {
  const at = process.argv.indexOf(name);
  const value = at >= 0 ? Number(process.argv[at + 1]) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const HOURS = arg('--hours', 2_000);
const STRICT = process.argv.includes('--strict');
/** `--limit 100000 --slice 100000` measures the sweep as it was: everything in one go. */
const LIMIT = arg('--limit', SWEEP_LIMIT);
const SLICE = arg('--slice', SWEEP_SLICE);
/** The longest the sweep may hold the event loop at once (a research stream's tick). */
const TARGET_MS = 100;
const TALK_MS = 1.5 * 3_600_000;
const SEGMENT_MS = 5_000;
const TRACKS_PER_TALK = 6;
const NOW = new Date().toISOString();
const WORDS = Array.from({ length: 400 }, (_, at) => `palavra${at}`);

const idOf = (prefix: string, n: number) =>
  `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;

function insertMedia(
  db: DatabaseSync,
  row: { id: string; title: string; durationMs: number; parent?: TrackSpan },
): void {
  db.prepare(
    `INSERT INTO media (id, topic, title, authorship, author, owner_principal, file_name,
       upload_bytes, status, duration_ms, created_at, updated_at, parent_media_id,
       parent_start_ms, parent_end_ms, track_ordinal)
     VALUES (?, 'udv', ?, 'outros-autores', NULL, 'owner', 'a.m4a', 1, 'ready', ?, ?, ?,
       ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.title,
    row.durationMs,
    NOW,
    NOW,
    row.parent?.parent ?? null,
    row.parent?.startMs ?? null,
    row.parent?.endMs ?? null,
    row.parent?.ordinal ?? null,
  );
  db.prepare(
    `INSERT INTO transcripts (id, media_id, version, provider, model, parameters,
       parameters_version, terms_version, vad, speech_ratio, elapsed_ms, raw_path,
       filter_version, confidence_version, confidence, word_count, removed_words,
       low_words, created_at)
     VALUES (?, ?, 1, 'mlx-whisper', 'synthetic', '{}', '1', 1, 'applied', 1, 0, 'r.json',
       1, 1, 'normal', 0, 0, 0, ?)`,
  ).run(`t-${row.id}`, row.id, NOW);
}

interface TrackSpan {
  readonly parent: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly ordinal: number;
}

function insertSegments(db: DatabaseSync, mediaId: string, count: number) {
  const segment = db.prepare(
    `INSERT INTO segments (transcript_id, position, start_ms, end_ms, text)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (let position = 0; position < count; position++)
    segment.run(
      `t-${mediaId}`,
      position,
      position * SEGMENT_MS,
      (position + 1) * SEGMENT_MS,
      Array.from(
        { length: 12 },
        (_, at) => WORDS[(position * 7 + at * 13) % WORDS.length],
      ).join(' '),
    );
}

/** One talk and its six tracks, each with its own share of the speech; the tracks' ids. */
function insertTalk(db: DatabaseSync, talk: number): [string, string[]] {
  const parent = idOf('00000000', talk);
  const length = TALK_MS / TRACKS_PER_TALK;
  insertMedia(db, {
    id: parent,
    title: `Palestra ${talk}`,
    durationMs: TALK_MS,
  });
  insertSegments(db, parent, TALK_MS / SEGMENT_MS);
  const ids: string[] = [];
  for (let ordinal = 1; ordinal <= TRACKS_PER_TALK; ordinal++) {
    const id = idOf('10000000', talk * 10 + ordinal);
    const startMs = (ordinal - 1) * length;
    insertMedia(db, {
      id,
      title: `Pergunta ${ordinal} da palestra ${talk}`,
      durationMs: length,
      parent: { parent, startMs, endMs: startMs + length, ordinal },
    });
    insertSegments(db, id, length / SEGMENT_MS);
    ids.push(id);
  }
  return [parent, ids];
}

/** Talks cut into tracks; the tracks of each talk, by talk id. */
function buildLibrary(db: DatabaseSync): Map<string, string[]> {
  const talks = Math.ceil(HOURS / 1.5);
  const tracks = new Map<string, string[]>();
  inTransaction(db, () => {
    for (let talk = 1; talk <= talks; talk++)
      tracks.set(...insertTalk(db, talk));
  });
  return tracks;
}

/** The app's source, over the database, with the tracks known without their approvals. */
function sourceOver(
  db: DatabaseSync,
  tracks: Map<string, string[]>,
): TrackDocumentSource {
  const transcripts = new SqliteTranscriptStore(db);
  return new TrackDocumentSource({
    store: new SqliteMediaStore(db),
    transcripts,
    items: {
      published: (parentId) =>
        (tracks.get(parentId) ?? []).map((mediaId) => ({ mediaId })) as never,
    },
    hasTracks: (recordingId) => tracks.has(recordingId),
    // The app reads the transcript once more with its voices and names (KBC-065).
    speakersOf: (mediaId) => {
      const [current] = transcripts.transcripts(mediaId);
      return current
        ? transcripts
            .segments(current.id)
            .map((_, at) => (at % 2 ? 'Mestre' : null))
        : [];
    },
    mainOf: () => null,
    authorOf: () => null,
    domainOf: () => 'udv',
    subjectsOf: () => [],
  });
}

function reconcilerOver(
  db: DatabaseSync,
  tracks: Map<string, string[]>,
  pause: () => Promise<void>,
): MediaDocumentReconciler {
  return new MediaDocumentReconciler({
    source: sourceOver(db, tracks),
    documents: new SqliteMediaDocumentStore(db),
    hasFolder: () => true,
    mediaOf: (topic) => (topic === 'udv' ? [...tracks.keys()] : []),
    sweep: { pause, limit: LIMIT, slice: SLICE },
  });
}

const dir = mkdtempSync(join(tmpdir(), 'kbchat-sweep-latency-'));
try {
  const db = openMediaDatabase(join(dir, 'media.db'), MEDIA_MIGRATIONS);
  const tracks = buildLibrary(db);
  const slices: number[] = [];
  let since = performance.now();
  const reconciler = reconcilerOver(db, tracks, async () => {
    slices.push(performance.now() - since);
    await new Promise((resolve) => setImmediate(resolve));
    since = performance.now();
  });
  // Every track documented once, as a library looks after the first sweeps.
  for (const parent of tracks.keys()) reconciler.reconcileRecording(parent);
  const documents = [...tracks.values()].flat().length;
  slices.length = 0;
  const started = performance.now();
  since = started;
  const report = await reconciler.reconcileAll();
  const total = performance.now() - started;
  const longest = Math.max(...slices);
  console.log(
    `${HOURS} h, ${documents} track documents; one sweep (limit ${LIMIT}, slice ${SLICE}):`,
  );
  console.log(
    `  rendered ${report.rendered} in ${report.slices} slices, ${total.toFixed(0)} ms in all`,
  );
  console.log(
    `  longest slice ${longest.toFixed(1)} ms (target ≤ ${TARGET_MS} ms), ${(total / report.rendered).toFixed(2)} ms per document`,
  );
  console.log(
    `  a whole pass over the library: ${Math.ceil(documents / LIMIT)} sweeps`,
  );
  db.close();
  if (STRICT && longest > TARGET_MS) process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
