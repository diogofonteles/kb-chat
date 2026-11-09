/**
 * Track documents kept up to date (KBC-100): a world with a vault copy the fake Mac writes
 * into, and the Mac's whole round (lease, write or remove, kb-result, the catalog read again
 * as production's is after a sync). No kb binary and no model run.
 */
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  KbPublishJob,
  MediaPublication,
  PairedTranscriber,
  TrackEditView,
} from '@kb-chat/contracts';
import { expect } from 'vitest';
import { FIXTURE_VAULT } from './fixture-paths.js';
import {
  kbResult,
  leaseAs,
  mediaDb,
  publisherMac,
  writeAsMac,
} from './kb-publish-harness.js';
import { startWorld, type World } from './track-items-harness.js';
import type { StartOptions } from './ai-app-harness.js';

export interface DocumentsWorld {
  readonly world: World;
  readonly vault: string;
  readonly mac: PairedTranscriber;
}

/** A vault copy with `hermetismo` and `udv`, a world over it and a Mac that publishes. */
export async function documentsWorld(
  options: {
    readonly env?: StartOptions['env'];
    readonly llm?: StartOptions['llm'];
  } = {},
): Promise<DocumentsWorld> {
  const vault = await mkdtemp(join(tmpdir(), 'kbchat-vault-'));
  await cp(FIXTURE_VAULT, vault, { recursive: true });
  await mkdir(join(vault, 'udv', 'raw'), { recursive: true });
  await writeFile(join(vault, 'udv', 'topic.yaml'), 'title: UDV\n');
  const world = await startWorld({ vault, ...options });
  const mac = await publisherMac(world.media);
  return { world, vault, mac };
}

/** Every waiting job of every collection, run by the Mac; the jobs it ran. */
export async function runMac(docs: DocumentsWorld): Promise<KbPublishJob[]> {
  const { world, vault, mac } = docs;
  const jobs: KbPublishJob[] = [];
  for (;;) {
    const leased = await leaseAs(world.media, mac.token);
    if (leased.statusCode === 204) break;
    expect(leased.statusCode, leased.body).toBe(200);
    const job = leased.json<KbPublishJob>();
    await writeAsMac(vault, job);
    const done = await kbResult(world.media, { token: mac.token, job });
    expect(done.statusCode, done.body).toBe(204);
    jobs.push(job);
  }
  for (const topic of new Set(jobs.map((job) => job.topic)))
    await world.media.started.catalog.refresh(topic);
  return jobs;
}

/** The text of a document in the vault copy; null when the file is not there. */
export async function vaultText(
  docs: DocumentsWorld,
  topic: string,
  path: string,
): Promise<string | null> {
  return readFile(join(docs.vault, topic, path), 'utf8').catch(() => null);
}

export const documentPath = (recordingId: string, mediaId: string) =>
  `raw/media/${recordingId}/${mediaId}.md`;

/** Rows of the media database, read apart from the app. */
export function rows(world: World, sql: string, ...args: string[]) {
  const db = mediaDb(world.media);
  try {
    return db.prepare(sql).all(...args);
  } finally {
    db.close();
  }
}

/** The jobs of the queue, by status. */
export const jobStatuses = (world: World) =>
  rows(world, 'SELECT topic, status FROM kb_publish_jobs ORDER BY created_at')
    .map((row) => `${String(row['topic'])}:${String(row['status'])}`)
    .filter((one) => !one.endsWith(':done'));

/** The track's editing view (its version, for If-Match). */
async function versionOfTrack(world: World, id: string): Promise<number> {
  const read = await world.media.owner('GET', `/api/v1/media/${id}/track-edit`);
  expect(read.statusCode, read.body).toBe(200);
  return read.json<TrackEditView>().version;
}

/** A request on a track with its current version, as the track's edit page sends it. */
export async function onTrack(
  world: World,
  request: {
    method: 'PATCH' | 'PUT' | 'DELETE';
    url: string;
    trackId: string;
    payload?: object;
  },
) {
  const { trackId, ...rest } = request;
  const version = await versionOfTrack(world, trackId);
  return world.media.started.app.inject({
    ...rest,
    headers: { ...world.media.ownerHeaders, 'if-match': `"${version}"` },
  });
}

/** Where a media stands in the research, as its edit page reads it. */
export async function publicationOf(world: World, mediaId: string) {
  const read = await world.media.owner(
    'GET',
    `/api/v1/media/${mediaId}/publication`,
  );
  expect(read.statusCode, read.body).toBe(200);
  return read.json<MediaPublication>().publication;
}
