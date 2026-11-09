/**
 * Word corrections under test (KBC-093): a recording transcribed by the fake Mac, its tracks
 * approved and cut, and calls to the correction routes as the owner or a member.
 */
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  CorrectionHistory,
  MediaItem,
  MediaTranscript,
  MediaTranscriptWords,
  SearchResponse,
  TranscriptWord,
} from '@kb-chat/contracts';
import { expect } from 'vitest';
import type { Call } from './ai-app-harness.js';
import type { Media } from './media-harness.js';
import { mediaDb } from './kb-publish-harness.js';
import {
  approve,
  finishCuts,
  libraryEntry,
  transcribed,
  type Bounds,
  type Spoken,
  type World,
} from './track-items-harness.js';

export const transcriptUrl = (id: string) => `/api/v1/media/${id}/transcript`;
export const correctionsUrl = (id: string) =>
  `${transcriptUrl(id)}/corrections`;

/** Four segments over three tracks; the words of interest in each. */
export const SPEECH: readonly Spoken[] = [
  { at: 10, text: 'O mestre Tiuako disse assim' },
  { at: 100, text: 'foi con certeza e Mariri falou' },
  { at: 200, text: 'veio concerteza a Hoasca' },
  { at: 310, text: 'tiuako, na terceira faixa' },
];

export const THREE: readonly Bounds[] = [
  { startMs: 0, endMs: 60_000, title: 'Primeira pergunta' },
  { startMs: 60_000, endMs: 240_000, title: 'Segunda pergunta' },
  { startMs: 300_000, endMs: 360_000, title: 'Terceira pergunta' },
];

/** A recording saying `speech`, its tracks approved, cut and published. */
export async function publishedRecording(
  world: World,
  speech: readonly Spoken[] = SPEECH,
  tracks: readonly Bounds[] = THREE,
): Promise<{ recording: MediaItem; tracks: readonly MediaItem[] }> {
  const recording = await transcribed(world, speech);
  await approve(world.media, recording.id, tracks);
  await finishCuts(world.media);
  const entry = await libraryEntry(world.media.owner, recording.id);
  return { recording, tracks: entry?.tracks ?? [] };
}

export async function transcriptOf(
  call: Call,
  id: string,
): Promise<MediaTranscript> {
  const read = await call('GET', transcriptUrl(id));
  expect(read.statusCode, read.body).toBe(200);
  return read.json<MediaTranscript>();
}

export const textOf = async (call: Call, id: string) =>
  (await transcriptOf(call, id)).segments.map((segment) => segment.text);

export async function wordsOf(
  call: Call,
  id: string,
): Promise<MediaTranscriptWords> {
  const read = await call('GET', `${transcriptUrl(id)}/words?from=0&count=200`);
  expect(read.statusCode, read.body).toBe(200);
  return read.json<MediaTranscriptWords>();
}

/** The first word that says `text`. */
export async function wordOf(
  call: Call,
  id: string,
  text: string,
): Promise<TranscriptWord & { position: number }> {
  const { words } = await wordsOf(call, id);
  const word = words.find((one) => one.text === text);
  if (word?.position === undefined) throw new Error(`no word ${text}`);
  return { ...word, position: word.position };
}

/** One word corrected, as the panel sends it. */
export async function fix(
  call: Call,
  id: string,
  change: { from: string; to: string; version?: number },
) {
  const word = await wordOf(call, id, change.from);
  return call('POST', correctionsUrl(id), {
    version: change.version ?? 1,
    position: word.position,
    count: 1,
    expected: [change.from],
    text: change.to,
  });
}

export async function historyOf(
  call: Call,
  id: string,
): Promise<CorrectionHistory> {
  const read = await call('GET', correctionsUrl(id));
  expect(read.statusCode, read.body).toBe(200);
  return read.json<CorrectionHistory>();
}

/** The spoken hits of a search in `hermetismo`: media, start and text. */
/**
 * The passages said with the words: "Na fala", and those a track's card took over when its
 * document matched too (KBC-101 BR-8: one card per track).
 */
export async function spokenHits(call: Call, q: string) {
  const found = await call('POST', '/api/v1/topics/hermetismo/searches', { q });
  expect(found.statusCode, found.body).toBe(200);
  const { items, media } = found.json<SearchResponse>();
  const onCards = items.flatMap(({ media: track }) =>
    track?.spoken
      ? [
          {
            mediaId: track.mediaId,
            startMs: track.startMs,
            text: track.spoken.text,
          },
        ]
      : [],
  );
  return [
    ...onCards,
    ...media.map(({ mediaId, startMs, text }) => ({ mediaId, startMs, text })),
  ];
}

/** Rows of the media database, read apart from the app. */
export function dbRows(media: Media, sql: string, ...args: string[]) {
  const db = mediaDb(media);
  try {
    return db.prepare(sql).all(...args);
  } finally {
    db.close();
  }
}

/** Runs DDL on the media database apart from the app (a trigger that fails a write). */
export function dbExec(media: Media, sql: string): void {
  const db = new DatabaseSync(join(media.mediaDir, 'media.db'));
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

/** Everything a failed correction must leave as it was (NFR-2, AC-26). */
export function snapshot(media: Media, recordingId: string) {
  return {
    words: dbRows(
      media,
      `SELECT w.position, w.text FROM words w JOIN transcripts t ON t.id = w.transcript_id
       WHERE t.media_id = ? ORDER BY w.position`,
      recordingId,
    ),
    segments: dbRows(
      media,
      `SELECT s.position, s.text FROM segments s JOIN transcripts t ON t.id = s.transcript_id
       WHERE t.media_id = ? ORDER BY s.position`,
      recordingId,
    ),
    index: dbRows(media, 'SELECT rowid, text FROM segments_fts ORDER BY rowid'),
    revisions: dbRows(
      media,
      'SELECT id, media_id, version, revision FROM transcripts ORDER BY id',
    ),
    log: dbRows(
      media,
      'SELECT id, state FROM transcript_corrections ORDER BY id',
    ),
    documents: dbRows(
      media,
      'SELECT media_id, desired_sha256 FROM media_documents ORDER BY media_id',
    ),
  };
}
