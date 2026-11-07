import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type {
  MediaPublication,
  TrackDocumentsOverview,
} from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp } from '../test/ai-app-harness.js';
import {
  documentPath,
  documentsWorld,
  jobStatuses,
  publicationOf,
  runMac,
  type DocumentsWorld,
} from '../test/documents-world.js';
import {
  kbResult,
  leaseAs,
  leaseKb,
  publishedTracks,
  spendTheCap,
  writeAsMac,
} from '../test/kb-publish-harness.js';
import { member } from '../test/media-harness.js';
import { asTranscriber } from '../test/transcription-harness.js';

afterEach(closeApp);

const urlOf = (id: string) => `/api/v1/media/${id}`;

/** The Mac was last seen at `at`: it has been off since then (ADR 0035 §10). */
function lastSeen(docs: DocumentsWorld, at: string): void {
  const db = new DatabaseSync(join(docs.world.media.mediaDir, 'media.db'));
  try {
    db.prepare('UPDATE transcribers SET last_seen_at = ? WHERE id = ?').run(
      at,
      docs.mac.transcriber.id,
    );
  } finally {
    db.close();
  }
}

/** kb fails on the Mac: the job goes back with kb's output. */
async function failOnce(docs: DocumentsWorld, detail: string): Promise<void> {
  const { world, mac } = docs;
  const job = await leaseKb(world.media, mac.token);
  const failed = await asTranscriber(world.media, mac.token, {
    method: 'POST',
    url: `/api/v1/media-worker/jobs/${job.id}/fail`,
    payload: {
      worker: 'mac',
      leaseId: job.leaseId,
      failure: 'conversion-failed',
      detail,
    },
  });
  expect(failed.statusCode, failed.body).toBe(204);
}

describe('Where a track stands in the AI research (KBC-100 BR-4, FR-3)', () => {
  it('AC-7: with the Mac off it waits, saying since when; when the Mac comes back it updates, then is live by itself', async () => {
    const docs = await documentsWorld();
    const { world, vault, mac } = docs;
    const { tracks } = await publishedTracks(world);
    const track = tracks[0];
    if (!track) throw new Error('no track');
    const off = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    lastSeen(docs, off);

    expect(await publicationOf(world, track.id)).toEqual({
      state: 'waiting-mac',
      offSince: off,
    });

    const job = await leaseKb(world.media, mac.token);
    expect((await publicationOf(world, track.id))?.state).toBe('updating');
    await writeAsMac(vault, job);
    expect(
      (await kbResult(world.media, { token: mac.token, job })).statusCode,
    ).toBe(204);
    // Written on the Mac, not yet seen by production's catalog: still updating.
    expect((await publicationOf(world, track.id))?.state).toBe('updating');

    // The sync reached production: the catalog reads the vault again.
    await world.media.started.catalog.refresh('hermetismo');
    const live = await publicationOf(world, track.id);
    expect(live?.state).toBe('live');
  });

  it('BR-4: a change after it was live is "updating" until production sees the new text', async () => {
    const docs = await documentsWorld();
    const { world } = docs;
    const { tracks } = await publishedTracks(world);
    const track = tracks[0];
    if (!track) throw new Error('no track');
    await runMac(docs);
    expect((await publicationOf(world, track.id))?.state).toBe('live');

    const db = new DatabaseSync(join(world.media.mediaDir, 'media.db'));
    try {
      // The Mac is on (it just worked): a new title waits only for it.
      db.prepare('UPDATE transcribers SET last_seen_at = ?').run(
        new Date().toISOString(),
      );
    } finally {
      db.close();
    }
    const read = await world.media.owner('GET', `${urlOf(track.id)}/track-edit`);
    const renamed = await world.media.started.app.inject({
      method: 'PATCH',
      url: urlOf(track.id),
      headers: {
        ...world.media.ownerHeaders,
        'if-match': `"${read.json<{ version: number }>().version}"`,
      },
      payload: { title: 'Outro título' },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect((await publicationOf(world, track.id))?.state).toBe('updating');
    await runMac(docs);
    expect((await publicationOf(world, track.id))?.state).toBe('live');
  });

  it('AC-10: kb failing 4 times leaves it failed with kb\'s output; "Tentar de novo" queues it again', async () => {
    const docs = await documentsWorld();
    const { world, mac } = docs;
    const { tracks } = await publishedTracks(world);
    const track = tracks[0];
    if (!track) throw new Error('no track');
    const output =
      'kb classify: OpenRouter 502 Bad Gateway\nnothing classified, re-run';
    for (let attempt = 1; attempt <= 4; attempt += 1)
      await failOnce(docs, output);

    const failed = await publicationOf(world, track.id);
    expect(failed).toMatchObject({
      state: 'failed',
      reason: 'kb classify: OpenRouter 502 Bad Gateway',
    });
    expect((await leaseAs(world.media, mac.token)).statusCode).toBe(204);

    const retried = await world.media.owner(
      'POST',
      `${urlOf(track.id)}/publication/retry`,
    );
    expect(retried.statusCode, retried.body).toBe(202);
    expect(retried.json<MediaPublication>().publication?.state).toBe(
      'updating',
    );
    expect(jobStatuses(world)).toContain('hermetismo:queued');
    const again = await leaseKb(world.media, mac.token);
    expect(again.items.some((item) => item.path.endsWith(`${track.id}.md`))).toBe(
      true,
    );
  });

  it('AC-11: with the media ceiling spent no job goes out and the track says why', async () => {
    const docs = await documentsWorld();
    const { world, mac } = docs;
    spendTheCap(world.media, 10);
    const { tracks } = await publishedTracks(world);
    const track = tracks[0];
    if (!track) throw new Error('no track');

    expect((await leaseAs(world.media, mac.token)).statusCode).toBe(204);
    expect(await publicationOf(world, track.id)).toEqual({
      state: 'out',
      reason: 'cap',
    });
  });

  it('AC-12: a collection created on the screen with no vault folder gets no job, and the track says so', async () => {
    const docs = await documentsWorld();
    const { world } = docs;
    const { recording, tracks } = await publishedTracks(world);
    const track = tracks[0];
    if (!track) throw new Error('no track');
    await runMac(docs);
    const created = await world.media.owner('POST', '/api/v1/topics', {
      title: 'Coleção nova',
    });
    expect(created.statusCode, created.body).toBe(201);
    const topic = created.json<{ slug: string }>().slug;

    const moved = await world.media.owner('PATCH', urlOf(recording.id), {
      topic,
      author: null,
    });
    expect(moved.statusCode, moved.body).toBe(200);

    expect(await publicationOf(world, track.id)).toEqual({
      state: 'out',
      reason: 'no-folder',
    });
    // Only the removal from the old folder waits; nothing for the new collection.
    expect(jobStatuses(world)).toEqual(['hermetismo:queued']);
    const jobs = await runMac(docs);
    expect(jobs.map((job) => job.topic)).toEqual(['hermetismo']);
    expect(jobs.flatMap((job) => job.items.map((item) => item.op))).toEqual([
      'remove',
      'remove',
    ]);
    expect(
      world.media.started.catalog
        .get('hermetismo')
        ?.entries.has(documentPath(recording.id, track.id)),
    ).toBe(false);
  });

  it('a recording with tracks has no state of its own; an unknown or unseen media is 404', async () => {
    const docs = await documentsWorld();
    const { world } = docs;
    const { recording } = await publishedTracks(world);

    expect(await publicationOf(world, recording.id)).toBeNull();
    const unknown = await world.media.owner(
      'GET',
      '/api/v1/media/0b9c1f7e-1111-4a2b-8c3d-00000000ffff/publication',
    );
    expect(unknown.statusCode).toBe(404);
  });

  it('only who edits media reads the state or retries, in the collections they see', async () => {
    const docs = await documentsWorld();
    const { world } = docs;
    const { tracks } = await publishedTracks(world);
    const track = tracks[0];
    if (!track) throw new Error('no track');
    const listener = await member(world.media, {
      email: 'ouvinte@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-tracks'],
    });
    const elsewhere = await member(world.media, {
      email: 'editor-udv@example.com',
      topics: ['udv'],
      features: ['media', 'media-tracks', 'media-edit'],
    });
    const url = `${urlOf(track.id)}/publication`;

    expect((await listener.call('GET', url)).statusCode).toBe(403);
    expect((await listener.call('POST', `${url}/retry`)).statusCode).toBe(403);
    expect((await elsewhere.call('GET', url)).statusCode).toBe(404);
    expect((await elsewhere.call('POST', `${url}/retry`)).statusCode).toBe(
      404,
    );
  });
});

describe('The publishing queue for masters in Transcritores (KBC-100 FR-3, FR-4)', () => {
  it('counts what waits, names what failed and keeps the Mac\'s last sync report', async () => {
    const docs = await documentsWorld();
    const { world, mac } = docs;
    const { tracks } = await publishedTracks(world);
    for (let attempt = 1; attempt <= 4; attempt += 1)
      await failOnce(docs, 'kb link: exit 1');
    const report = {
      ok: false,
      detail: 'sync-vault: would delete 250 files on the VM (limit 200)',
      startedAt: '2026-11-07T14:00:00.000Z',
      finishedAt: '2026-11-07T14:00:09.000Z',
    };
    const sent = await asTranscriber(world.media, mac.token, {
      method: 'POST',
      url: '/api/v1/media-worker/vault-sync',
      payload: report,
    });
    expect(sent.statusCode, sent.body).toBe(204);

    const read = await world.media.owner('GET', '/api/v1/media/track-documents');
    expect(read.statusCode, read.body).toBe(200);
    const { queue } = read.json<TrackDocumentsOverview>();
    expect(queue?.waiting).toBe(2);
    expect(queue?.lastSync).toEqual(report);
    expect(queue?.failed.map((one) => one.mediaId).sort()).toEqual(
      tracks.map((one) => one.id).sort(),
    );
    expect(queue?.failed[0]?.error).toBe('kb link: exit 1');
  });

  it('a sync report comes only from a Mac marked "Publica no acervo"', async () => {
    const docs = await documentsWorld();
    const { world } = docs;
    const refused = await asTranscriber(world.media, world.token, {
      method: 'POST',
      url: '/api/v1/media-worker/vault-sync',
      payload: {
        ok: true,
        detail: '',
        startedAt: '2026-11-07T14:00:00.000Z',
        finishedAt: '2026-11-07T14:00:09.000Z',
      },
    });
    expect(refused.statusCode).toBe(404);
  });
});
