// Synthetic track documents and the media.db behind them (KBC-101 NFR-1, NFR-3): the same
// tracks for the in-process measure (search-tracks-latency.ts) and for a running API
// (seed-track-world.ts), so both measure one corpus.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openMediaDatabase } from '../adapters/sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from '../adapters/sqlite/media-migrations.js';

/** Spoken segments per track: a track of about 3 minutes, as kb gets it. */
export const SEGMENTS = 40;
const TRACKS_PER_RECORDING = 6;
const NOW = new Date().toISOString();

/** The words a track is made of, from its number and a segment's (deterministic). */
export type Words = (seed: number, count: number) => string;

export interface TrackWorld {
  readonly topic: string;
  readonly tracks: number;
  readonly words: Words;
}

export const trackId = (n: number): string =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const recordingId = (n: number): string =>
  `00000000-0000-4000-8000-${String(Math.floor(n / TRACKS_PER_RECORDING)).padStart(12, '0')}`;

/** The vault path of a track's document, inside its collection's folder. */
export const trackPath = (n: number): string =>
  `raw/media/${recordingId(n)}/${trackId(n)}.md`;

/** A track's document as the app renders it for kb (ADR 0035 §2). */
export function trackDocument(n: number, words: Words): string {
  const anchors = Array.from(
    { length: SEGMENTS },
    (_, i) =>
      `[${Math.floor((i * 5) / 60)}:${String((i * 5) % 60).padStart(2, '0')}] ${words(n + i, 12)}`,
  ).join('\n\n');
  const recording = Math.floor(n / TRACKS_PER_RECORDING);
  const ordinal = (n % TRACKS_PER_RECORDING) + 1;
  return `---\ntitle: Faixa ${n}\ngenre: talk_or_interview\ndepth: 2\nrelevance: core\nauthor_group: outros-autores\nkb_chat_media_id: ${trackId(n)}\nkb_chat_media_kind: track\nkb_chat_recording_id: ${recordingId(n)}\nkb_chat_recording_title: Palestra ${recording}\nkb_chat_track_ordinal: ${ordinal}\nkb_chat_tracks_total: ${TRACKS_PER_RECORDING}\nkb_chat_fingerprint: f${n}\n---\n\n# Faixa ${n}\n\nGravação: Palestra ${recording} · faixa ${ordinal} de ${TRACKS_PER_RECORDING}\n\n${anchors}\n`;
}

/** The same text without its `kb_chat_*` keys: what the catalog reads as a text. */
export const asText = (document: string): string =>
  document.replace(/^kb_chat_.*\n/gm, '');

/**
 * Writes every track's document under `folder` (a collection's folder in the vault); with
 * `asTexts`, the same text as plain texts.
 */
export function writeTrackDocuments(
  folder: string,
  world: TrackWorld,
  { asTexts = false }: { asTexts?: boolean } = {},
): void {
  for (let n = 0; n < world.tracks; n++) {
    const file = join(folder, trackPath(n));
    const document = trackDocument(n, world.words);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, asTexts ? asText(document) : document);
  }
}

function insertTrack(db: DatabaseSync, n: number, world: TrackWorld): void {
  const id = trackId(n);
  db.prepare(
    `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
       upload_bytes, status, duration_ms, created_at, updated_at, parent_media_id,
       parent_start_ms, parent_end_ms, track_ordinal)
     VALUES (?, ?, ?, 'outros-autores', 'owner', 'a.m4a', 1, 'ready', 200000, ?, ?, ?, 0, 200000, ?)`,
  ).run(
    id,
    world.topic,
    `Faixa ${n}`,
    NOW,
    NOW,
    recordingId(n),
    (n % TRACKS_PER_RECORDING) + 1,
  );
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
    segment.run(`t-${id}`, i, i * 5000, (i + 1) * 5000, world.words(n + i, 12));
}

function insertRecordings(db: DatabaseSync, world: TrackWorld): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO media (id, topic, title, authorship, owner_principal, file_name,
       upload_bytes, status, duration_ms, created_at, updated_at)
     VALUES (?, ?, ?, 'outros-autores', 'owner', 'a.mp3', 1, 'ready', 1200000, ?, ?)`,
  );
  for (let n = 0; n < world.tracks; n++)
    insert.run(
      recordingId(n),
      world.topic,
      `Palestra ${Math.floor(n / TRACKS_PER_RECORDING)}`,
      NOW,
      NOW,
    );
}

/** `<dir>/media.db` with the recordings, the ready tracks and their transcripts. */
export function trackDatabase(dir: string, world: TrackWorld): DatabaseSync {
  const db = openMediaDatabase(join(dir, 'media.db'), MEDIA_MIGRATIONS);
  db.exec('BEGIN');
  insertRecordings(db, world);
  for (let n = 0; n < world.tracks; n++) insertTrack(db, n, world);
  // The "Na fala" index, as the transcript store fills it when a transcript is saved.
  db.exec(
    'INSERT INTO segments_fts (rowid, text) SELECT rowid, text FROM segments',
  );
  db.exec('COMMIT');
  return db;
}
