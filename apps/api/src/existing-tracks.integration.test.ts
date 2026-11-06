import type {
  PublishExistingTracksResult,
  TrackDocumentsOverview,
} from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL, closeApp } from '../test/ai-app-harness.js';
import {
  forgetDocuments,
  kbResult,
  leaseAs,
  leaseKb,
  publishedTracks,
  publisherMac,
  spendTheCap,
} from '../test/kb-publish-harness.js';
import { member } from '../test/media-harness.js';
import { startWorld, type World } from '../test/track-items-harness.js';

afterEach(closeApp);

const OVERVIEW = '/api/v1/media/track-documents';
const PUBLISH = '/api/v1/media/track-documents/publish';

const overviewOf = async (world: World) => {
  const read = await world.media.owner('GET', OVERVIEW);
  expect(read.statusCode, read.body).toBe(200);
  return read.json<TrackDocumentsOverview>();
};

const hermetismoOf = async (world: World) =>
  (await overviewOf(world)).collections.find(
    (one) => one.topic === 'hermetismo',
  );

/** Two tracks published before KBC-099: no document, no job. */
async function oldTracks(): Promise<World> {
  const world = await startWorld();
  await publishedTracks(world);
  forgetDocuments(world.media);
  return world;
}

describe('Publicar no acervo as faixas que já existem (KBC-099 AC-16, scope of 2026-11-06)', () => {
  it('shows, per collection, the tracks to publish and the estimated kb cost before anything is queued', async () => {
    const world = await oldTracks();
    const overview = await overviewOf(world);
    expect(overview.usdPerTrack).toBe(0.001);
    expect(overview.remainingUsd).toBeGreaterThan(0);
    expect(await hermetismoOf(world)).toEqual({
      topic: 'hermetismo',
      title: 'Hermetismo',
      tracks: 2,
      toPublish: 2,
      queued: 0,
      published: 0,
      failed: 0,
    });
    // Looking is free: no document wanted, no job queued.
    const mac = await publisherMac(world.media);
    expect((await leaseAs(world.media, mac.token)).statusCode).toBe(204);
  });

  it('queues every published track of the chosen collections; the Mac publishes them and the counts follow', async () => {
    const world = await oldTracks();
    const done = await world.media.owner('POST', PUBLISH, {
      topics: ['hermetismo'],
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json<PublishExistingTracksResult>()).toEqual({
      queued: 2,
      skipped: 0,
    });
    expect(await hermetismoOf(world)).toMatchObject({
      toPublish: 2,
      queued: 2,
      published: 0,
    });
    const mac = await publisherMac(world.media);
    const job = await leaseKb(world.media, mac.token);
    expect(job.items).toHaveLength(2);
    expect(
      (await kbResult(world.media, { token: mac.token, job })).statusCode,
    ).toBe(204);
    expect(await hermetismoOf(world)).toMatchObject({
      tracks: 2,
      toPublish: 0,
      queued: 0,
      published: 2,
      failed: 0,
    });
  });

  it('is idempotent: tracks already in the vault as they are now are skipped, and nothing is queued', async () => {
    const world = await oldTracks();
    await world.media.owner('POST', PUBLISH, { topics: ['hermetismo'] });
    const mac = await publisherMac(world.media);
    const job = await leaseKb(world.media, mac.token);
    await kbResult(world.media, { token: mac.token, job });
    const again = await world.media.owner('POST', PUBLISH, {
      topics: ['hermetismo'],
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json<PublishExistingTracksResult>()).toEqual({
      queued: 0,
      skipped: 2,
    });
    expect((await leaseAs(world.media, mac.token)).statusCode).toBe(204);
  });

  it('twice before the Mac comes keeps one job for the collection', async () => {
    const world = await oldTracks();
    await world.media.owner('POST', PUBLISH, { topics: ['hermetismo'] });
    const twice = await world.media.owner('POST', PUBLISH, {
      topics: ['hermetismo'],
    });
    expect(twice.json<PublishExistingTracksResult>()).toEqual({
      queued: 2,
      skipped: 0,
    });
    const mac = await publisherMac(world.media);
    await leaseKb(world.media, mac.token);
    expect((await leaseAs(world.media, mac.token)).statusCode).toBe(204);
  });

  it('respects the media monthly ceiling: nothing is queued once it is spent (429)', async () => {
    const world = await oldTracks();
    spendTheCap(world.media, 10);
    expect((await overviewOf(world)).remainingUsd).toBe(0);
    const refused = await world.media.owner('POST', PUBLISH, {
      topics: ['hermetismo'],
    });
    expect(refused.statusCode, refused.body).toBe(429);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe(
      'MEDIA_SPEND_CAP',
    );
    expect((await hermetismoOf(world))?.queued).toBe(0);
  });

  it('refuses a body that names no collection, an unknown field or a bad slug (400), and an unknown collection (404)', async () => {
    const world = await oldTracks();
    for (const body of [
      {},
      { topics: [] },
      { topics: ['Hermetismo!'] },
      { topics: ['hermetismo'], all: true },
    ])
      expect(
        (await world.media.owner('POST', PUBLISH, body)).statusCode,
        JSON.stringify(body),
      ).toBe(400);
    expect(
      (await world.media.owner('POST', PUBLISH, { topics: ['nao-existe'] }))
        .statusCode,
    ).toBe(404);
  });

  it('is for masters only: 401 without a session, 403 to a member with every media permission', async () => {
    const world = await oldTracks();
    const { app } = world.media.started;
    for (const [method, url] of [
      ['GET', OVERVIEW],
      ['POST', PUBLISH],
    ] as const) {
      const anonymous = await app.inject({
        method,
        url,
        headers: LOCAL,
        ...(method === 'POST' && { payload: { topics: ['hermetismo'] } }),
      });
      expect(anonymous.statusCode, `${method} ${url}`).toBe(401);
    }
    const { call } = await member(world.media, {
      email: 'membro@example.com',
      topics: ['hermetismo'],
      features: [
        'search',
        'research',
        'media',
        'media-tracks',
        'media-research',
        'media-edit',
      ],
    });
    expect((await call('GET', OVERVIEW)).statusCode).toBe(403);
    expect(
      (await call('POST', PUBLISH, { topics: ['hermetismo'] })).statusCode,
    ).toBe(403);
    expect((await hermetismoOf(world))?.queued).toBe(0);
  });
});
