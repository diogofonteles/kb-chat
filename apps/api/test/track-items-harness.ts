/**
 * Approved tracks becoming items (KBC-068), driven through the real routes: a fake VM worker
 * writes a stand-in file and answers what a stream copy would.
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CutJob,
  MediaItem,
  RawTranscript,
  WorkerJob,
} from '@kb-chat/contracts';
import { expect } from 'vitest';
import { caller, signIn, start, type StartOptions } from './ai-app-harness.js';
import { FIXTURE_VAULT } from './fixture-paths.js';
import {
  CONVERTED,
  leaseJob,
  queuedItem,
  worker,
  type Media,
} from './media-harness.js';
import {
  FLAC,
  leaseTranscription,
  pair,
  sendTranscript,
} from './transcription-harness.js';

export interface World {
  readonly media: Media;
  readonly token: string;
}

export interface Spoken {
  readonly at: number;
  readonly text: string;
}

export interface Bounds {
  readonly startMs: number;
  readonly endMs: number;
  readonly title?: string;
  readonly answererSpeakerId?: string | null;
  readonly answererVoice?: number | null;
}

const TEN_MINUTES_MS = 600_000;

/** One segment per passage (`at` in seconds), a word every 0.4 s. */
export function rawOf(passages: readonly Spoken[]): RawTranscript {
  return {
    chunks: [
      {
        offset: 0,
        end: 600,
        result: {
          segments: passages.map(({ at, text }) => {
            const words = text.split(' ');
            return {
              start: at,
              end: at + words.length * 0.4,
              text: ` ${text}`,
              avg_logprob: -0.2,
              compression_ratio: 1.3,
              no_speech_prob: 0.01,
              words: words.map((word, i) => ({
                word: ` ${word}`,
                start: at + i * 0.4,
                end: at + (i + 1) * 0.4,
                probability: 0.95,
              })),
            };
          }),
        },
      },
    ],
  };
}

/** A copy of the fixture vault with a second collection, `udv`. */
async function vaultWithTwoCollections(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kbchat-vault-'));
  await cp(FIXTURE_VAULT, root, { recursive: true });
  await mkdir(join(root, 'udv', 'raw'), { recursive: true });
  await writeFile(join(root, 'udv', 'topic.yaml'), 'title: UDV\n');
  return root;
}

export async function startWorld(
  options: {
    readonly vault?: string;
    readonly env?: StartOptions['env'];
    readonly llm?: StartOptions['llm'];
    readonly launchctl?: StartOptions['launchctl'];
  } = {},
): Promise<World> {
  const started = await start({
    media: true,
    vault: options.vault ?? (await vaultWithTwoCollections()),
    ...(options.env ? { env: options.env } : {}),
    ...(options.llm ? { llm: options.llm } : {}),
    ...(options.launchctl ? { launchctl: options.launchctl } : {}),
  });
  const ownerHeaders = await signIn(started, 'owner@example.com');
  const media: Media = {
    started,
    owner: caller(started.app, ownerHeaders),
    ownerHeaders,
    mediaDir: join(started.state, 'media'),
  };
  const { token, transcriber } = await pair(media);
  // The world's Mac only transcribes: a master unmarked "Publica no acervo", which comes
  // on at pairing (KBC-114 BR-7); the tests that publish pair a Mac of their own.
  const unmarked = await media.owner(
    'PATCH',
    `/api/v1/media/transcribers/${transcriber.id}`,
    { kinds: ['transcribe'] },
  );
  expect(unmarked.statusCode, unmarked.body).toBe(200);
  return { media, token };
}

export async function convertLong(media: Media, job: WorkerJob): Promise<void> {
  writeFileSync(join(media.mediaDir, job.targetPath), CONVERTED);
  if (job.flacTargetPath)
    writeFileSync(join(media.mediaDir, job.flacTargetPath), FLAC);
  const done = await worker(
    media,
    `/api/v1/media-worker/jobs/${job.id}/complete`,
    {
      worker: 'vm',
      leaseId: job.leaseId,
      durationMs: TEN_MINUTES_MS,
      bytes: CONVERTED.length,
      flacBytes: FLAC.length,
    },
  );
  expect(done.statusCode, done.body).toBe(204);
}

/** Ten "minutes" of converted audio that said `passages`. */
export async function transcribed(
  world: World,
  passages: readonly Spoken[],
  options: { readonly title?: string } = {},
): Promise<MediaItem> {
  const { media } = world;
  const item = await queuedItem(media, 'hermetismo', options);
  await convertLong(media, await leaseJob(media));
  await say(world, passages);
  return item;
}

/** The transcriber answers the next job of the queue. */
export async function say(
  { media, token }: World,
  passages: readonly Spoken[],
): Promise<void> {
  const job = await leaseTranscription(media, token);
  const sent = await sendTranscript(media, {
    token,
    job,
    raw: rawOf(passages),
  });
  expect(sent.statusCode, sent.body).toBe(204);
}

const editUrl = (id: string) => `/api/v1/media/${id}/edit`;

/** The edit's version now. */
export async function versionOf(media: Media, id: string): Promise<number> {
  const edit = await media.owner('GET', editUrl(id));
  expect(edit.statusCode, edit.body).toBe(200);
  return edit.json<{ version: number }>().version;
}

export const withVersion = async (
  media: Media,
  id: string,
  request: { method: 'PUT' | 'POST'; url: string; payload?: object },
) =>
  media.started.app.inject({
    ...request,
    headers: {
      ...media.ownerHeaders,
      'if-match': `"${await versionOf(media, id)}"`,
    },
  });

const draftOf = (tracks: readonly Bounds[]) =>
  tracks.map((track, index) => ({
    id: randomUUID(),
    source: 'manual',
    kind: 'qa',
    title: track.title ?? `Pergunta ${index + 1}`,
    startMs: track.startMs,
    endMs: track.endMs,
    askerVoice: null,
    answererVoice: track.answererVoice ?? null,
    askerSpeakerId: null,
    answererSpeakerId: track.answererSpeakerId ?? null,
  }));

async function reopenIfApproved(media: Media, id: string): Promise<void> {
  const edit = await media.owner('GET', editUrl(id));
  if (edit.json<{ status: string }>().status !== 'approved') return;
  const reopened = await withVersion(media, id, {
    method: 'POST',
    url: `${editUrl(id)}/reopen`,
  });
  expect(reopened.statusCode, reopened.body).toBe(200);
}

/** Saves `tracks` as the draft and approves it. */
export async function approve(
  media: Media,
  id: string,
  tracks: readonly Bounds[],
): Promise<void> {
  await reopenIfApproved(media, id);
  const saved = await withVersion(media, id, {
    method: 'PUT',
    url: editUrl(id),
    payload: { step: 3, tracks: draftOf(tracks) },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const approved = await withVersion(media, id, {
    method: 'POST',
    url: `${editUrl(id)}/approve`,
  });
  expect(approved.statusCode, approved.body).toBe(200);
}

export async function leaseCut(media: Media): Promise<CutJob | null> {
  const leased = await worker(media, '/api/v1/media-worker/jobs/lease', {
    worker: 'vm',
    kinds: ['cut'],
  });
  return leased.statusCode === 204 ? null : leased.json<CutJob>();
}

/** One cut done: 20 bytes on disk, ending `lateMs` past the asked time. */
export async function finishCut(
  media: Media,
  job: CutJob,
  lateMs = 0,
): Promise<void> {
  writeFileSync(join(media.mediaDir, job.targetPath), CONVERTED);
  const done = await worker(media, `/api/v1/media-worker/jobs/${job.id}/cut`, {
    worker: 'vm',
    leaseId: job.leaseId,
    bytes: CONVERTED.length,
    durationMs: job.endMs - job.startMs + lateMs,
  });
  expect(done.statusCode, done.body).toBe(204);
}

/** Every cut in the queue, done. */
export async function finishCuts(media: Media, lateMs = 0): Promise<number> {
  let count = 0;
  for (
    let job = await leaseCut(media);
    job !== null;
    job = await leaseCut(media)
  ) {
    await finishCut(media, job, lateMs);
    count++;
  }
  return count;
}

export interface LibraryEntry {
  readonly id: string;
  readonly title: string;
  readonly tracks: readonly MediaItem[];
}

/** The owner's library entry for a recording. */
export async function libraryEntry(
  call: Media['owner'],
  id: string,
): Promise<LibraryEntry | undefined> {
  const page = await call('GET', '/api/v1/media/library');
  expect(page.statusCode, page.body).toBe(200);
  return page
    .json<{ items: LibraryEntry[] }>()
    .items.find((item) => item.id === id);
}
