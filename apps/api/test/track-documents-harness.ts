/**
 * Track documents in a vault copy, published through the fake Mac (KBC-099, KBC-101): the
 * world, a member with chosen features, and the media.db changes no route makes in one step
 * (a track moved to a sub-collection with its document, another author).
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MediaItem } from '@kb-chat/contracts';
import { expect } from 'vitest';
import type { StubLlmAdapter } from '../src/adapters/stub-llm-adapter.js';
import { caller, signIn, type Call } from './ai-app-harness.js';
import { FIXTURE_VAULT } from './fixture-paths.js';
import {
  kbResult,
  leaseKb,
  publishedTracks,
  publisherMac,
  writeAsMac,
} from './kb-publish-harness.js';
import { startWorld, type World } from './track-items-harness.js';

export type { World } from './track-items-harness.js';

export interface TrackWorld {
  readonly world: World;
  readonly vault: string;
  readonly track: MediaItem;
  readonly other: MediaItem;
  readonly recording: MediaItem;
  /** The first track's document, relative to `hermetismo`. */
  readonly path: string;
}

/** The sub-collection a test may move a track into (ADR 0028). */
export const SUB = 'hermetismo/palestras';

/**
 * A recording of `hermetismo` with two tracks published through the Mac (the fake kb), in a
 * vault copy that also has the empty sub-collection `hermetismo/palestras`.
 */
export async function trackWorld(
  options: {
    readonly llm?: StubLlmAdapter;
    readonly beforeCatalog?: (world: World) => Promise<void>;
    /** Runs before the tracks exist (a recording that never gets one, KBC-100). */
    readonly beforeTracks?: (world: World) => Promise<void>;
  } = {},
): Promise<TrackWorld> {
  const vault = await mkdtemp(join(tmpdir(), 'kbchat-vault-'));
  await cp(FIXTURE_VAULT, vault, { recursive: true });
  await mkdir(join(vault, SUB, 'raw'), { recursive: true });
  await writeFile(join(vault, SUB, 'topic.yaml'), 'title: Palestras\n');
  const world = await startWorld({
    vault,
    ...(options.llm && { llm: options.llm }),
  });
  await options.beforeTracks?.(world);
  const { recording, tracks } = await publishedTracks(world);
  const mac = await publisherMac(world.media);
  const job = await leaseKb(world.media, mac.token);
  await options.beforeCatalog?.(world);
  await writeAsMac(vault, job);
  const result = await kbResult(world.media, { token: mac.token, job });
  expect(result.statusCode, result.body).toBe(204);
  await world.media.started.catalog.load();
  const [track, other] = tracks;
  if (!track || !other) throw new Error('two tracks expected');
  const path = `raw/media/${recording.id}/${track.id}.md`;
  return { world, vault, track, other, recording, path };
}

/** A member of `hermetismo` (and so of its sub-collections) with exactly these features. */
export async function memberWith(
  world: World,
  features: readonly string[],
): Promise<Call> {
  const { media } = world;
  const email = `${features.join('-') || 'nada'}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const invited = await media.owner('POST', '/api/v1/people', { email });
  expect(invited.statusCode, invited.body).toBe(201);
  const updated = await media.owner(
    'PATCH',
    `/api/v1/people/${invited.json<{ id: string }>().id}`,
    { topics: ['hermetismo'], features },
  );
  expect(updated.statusCode, updated.body).toBe(200);
  return caller(media.started.app, await signIn(media.started, email));
}

/** Writes to media.db as the app would after an edit (a move, another author). */
export function changeMedia(
  world: World,
  { id, set }: { id: string; set: Record<string, string | null> },
): void {
  const db = new DatabaseSync(join(world.media.mediaDir, 'media.db'));
  try {
    const columns = Object.keys(set);
    db.prepare(
      `UPDATE media SET ${columns.map((one) => `${one} = ?`).join(', ')} WHERE id = ?`,
    ).run(...columns.map((one) => set[one] ?? null), id);
  } finally {
    db.close();
  }
}

/**
 * A track moved to the sub-collection and published there by the Mac: its document leaves
 * `hermetismo` for `hermetismo/palestras`, written by another author when asked.
 */
export async function moveToSub(
  tracks: TrackWorld,
  { otherAuthor = false }: { otherAuthor?: boolean } = {},
): Promise<string> {
  const { world, vault, track, path } = tracks;
  const from = join(vault, 'hermetismo', path);
  const text = await readFile(from, 'utf8');
  const to = join(vault, SUB, path);
  await mkdir(dirname(to), { recursive: true });
  await writeFile(
    to,
    otherAuthor
      ? text.replace(/^author_group: .*$/m, 'author_group: outros-autores')
      : text,
  );
  await rm(from);
  changeMedia(world, {
    id: track.id,
    set: {
      topic: SUB,
      ...(otherAuthor && { author: null, authorship: 'outros-autores' }),
    },
  });
  await world.media.started.catalog.load();
  return `palestras/${path}`;
}
