/**
 * A recording with three tracks in a collection with QS < CI < CDC (KBC-106): the scene the
 * track-level tests share, and what reads and rewrites its real audio.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MediaItem } from '@kb-chat/contracts';
import { expect } from 'vitest';
import type { Call } from './ai-app-harness.js';
import {
  SIX,
  createScale,
  memberOf,
  setPersonLevel,
  startLevels,
  type LevelsWorld,
} from './levels-world.js';
import { AUDIO, leaseJob, upload, type Media } from './media-harness.js';
import { ffmpegBins } from './media-tools.js';
import {
  approve,
  convertLong,
  finishCuts,
  libraryEntry,
  say,
} from './track-items-harness.js';
import { pair } from './transcription-harness.js';

export const FEATURES = [
  'search',
  'media',
  'media-upload',
  'media-edit',
  'media-library',
  'media-tracks',
];
export const SECRET = 'segredo velado do cume';
export const OPEN = 'lua aberta do comeco';
export const LATE = 'sol final da palestra';

export const mediaOf = (world: LevelsWorld): Media => ({
  started: world.started,
  owner: world.owner,
  ownerHeaders: world.ownerHeaders,
  mediaDir: join(world.started.state, 'media'),
});

export async function transcriber(media: Media): Promise<string> {
  const { token, transcriber: mac } = await pair(media);
  const unmarked = await media.owner(
    'PATCH',
    `/api/v1/media/transcribers/${mac.id}`,
    { kinds: ['transcribe'] },
  );
  expect(unmarked.statusCode, unmarked.body).toBe(200);
  return token;
}

export interface Scene {
  readonly world: LevelsWorld;
  readonly ana: {
    readonly call: Call;
    readonly headers: Record<string, string>;
  };
  readonly recording: MediaItem;
  readonly tracks: readonly MediaItem[];
}

/** What the recording says: a passage in each track to be. */
const PASSAGES = [
  { at: 10, text: OPEN },
  { at: 70, text: SECRET },
  { at: 130, text: LATE },
];

/** Who sends the recording (the owner by default) and what it says. */
export interface RecordingOptions {
  readonly by?: {
    readonly call: Call;
    readonly headers: Record<string, string>;
  };
  readonly passages?: readonly { readonly at: number; readonly text: string }[];
}

/** A CI recording of hermetismo sent by the owner (or `by`), converted and transcribed. */
export async function transcribedRecording(
  world: LevelsWorld,
  options: RecordingOptions = {},
): Promise<MediaItem> {
  const media = mediaOf(world);
  const token = await transcriber(media);
  const call = options.by?.call ?? world.owner;
  const created = await call('POST', '/api/v1/topics/hermetismo/media', {
    title: 'Palestra Aberta',
    author: null,
    fileName: 'palestra.mp3',
    bytes: AUDIO.length,
    level: 'ci',
  });
  expect(created.statusCode, created.body).toBe(201);
  const recording: MediaItem = created.json();
  const headers = options.by?.headers ?? world.ownerHeaders;
  const sent = await upload(media, { id: recording.id, body: AUDIO, headers });
  expect(sent.statusCode).toBe(200);
  await convertLong(media, await leaseJob(media));
  await say({ media, token }, options.passages ?? PASSAGES);
  return recording;
}

/** QS < CI < CDC; a CI recording of three tracks, Ana (CI) with media and tracks. */
export async function scene(
  options: Parameters<typeof transcribedRecording>[1] = {},
): Promise<Scene> {
  const world = await startLevels(SIX, { media: true });
  const ana = await memberOf(world, 'ana@example.com', {
    topics: ['hermetismo'],
    features: FEATURES,
  });
  await createScale(world, ['QS', 'CI', 'CDC']);
  await setPersonLevel(world, ana.id, { hermetismo: 'ci' });
  const recording = await transcribedRecording(world, options);
  const media = mediaOf(world);
  await approve(media, recording.id, [
    { startMs: 0, endMs: 60_000, title: 'Primeira' },
    { startMs: 60_000, endMs: 120_000, title: 'Pergunta Sensivel' },
    { startMs: 120_000, endMs: 180_000, title: 'Terceira' },
  ]);
  await finishCuts(media);
  const entry = await libraryEntry(world.owner, recording.id);
  return { world, ana, recording, tracks: entry?.tracks ?? [] };
}

/** PATCH a track's level with the version its edit view gives. */
export async function setTrackLevel(
  world: LevelsWorld,
  trackId: string,
  level: string | null,
) {
  const view = await world.owner('GET', `/api/v1/media/${trackId}/track-edit`);
  expect(view.statusCode, view.body).toBe(200);
  return world.started.app.inject({
    method: 'PATCH',
    url: `/api/v1/media/${trackId}`,
    headers: {
      ...world.ownerHeaders,
      'if-match': `"${view.json<{ version: number }>().version}"`,
    },
    payload: { level },
  });
}

/** The recording's file replaced by real AAC: 3 minutes of tone, as the worker makes it. */
/** Where a recording's converted file is on disk. */
function renditionPath(world: LevelsWorld, recordingId: string): string {
  const db = new DatabaseSync(join(world.started.state, 'media', 'media.db'), {
    readOnly: true,
  });
  const row = db
    .prepare(
      `SELECT path FROM media_files WHERE media_id = ? AND rendition = 'audio'`,
    )
    .get(recordingId);
  db.close();
  return join(world.started.state, 'media', String(row?.['path']));
}

export function realRendition(
  world: LevelsWorld,
  recordingId: string,
  options: { readonly video?: boolean } = {},
): string {
  const path = renditionPath(world, recordingId);
  // With `video`, a picture track beside the sound (a file the mask cannot vouch for).
  const video = options.video
    ? ['-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=180', '-c:v', 'mpeg4']
    : [];
  execFileSync(ffmpegBins().ffmpeg, [
    ...['-hide_banner', '-loglevel', 'error', '-y'],
    ...['-f', 'lavfi', '-i', 'sine=frequency=330:duration=180'],
    ...video,
    ...['-ac', '1', '-c:a', 'aac', '-b:a', '64k'],
    ...['-movflags', '+faststart', '-f', 'mp4', path],
  ]);
  return path;
}

/** The byte where the AAC packet nearest `seconds` starts, by ffprobe. */
export function packetAt(path: string, seconds: number): number {
  const rows = execFileSync(ffmpegBins().ffprobe, [
    '-v',
    'error',
    '-select_streams',
    'a',
    '-show_entries',
    'packet=pts_time,pos',
    '-of',
    'csv=p=0',
    path,
  ])
    .toString()
    .trim()
    .split('\n')
    .map((line) => line.split(',').map(Number));
  const found = rows.find(([at]) => (at ?? 0) >= seconds);
  return found?.[1] ?? 0;
}
