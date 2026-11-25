import { mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DocIngestJob, DocumentRemoval } from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp } from '../test/ai-app-harness.js';
import {
  announce,
  docMac,
  docResult,
  leaseDoc,
  sentFile,
  uploadsOf,
  writeConverted,
  PDF_SHA,
} from '../test/document-uploads-harness.js';
import { leaseAs } from '../test/kb-publish-harness.js';
import {
  member,
  startMedia,
  vaultWithUdv,
  type Media,
} from '../test/media-harness.js';

afterEach(closeApp);

const REMOVALS = '/api/v1/document-removals';
const ID = 'raw/articles/o-caibalion.md';
const url = (id = ID, topic = 'hermetismo') =>
  `/api/v1/topics/${topic}/documents/${encodeURIComponent(id)}`;

async function world() {
  const vault = await vaultWithUdv();
  const media = await startMedia({ vault });
  const ana = await member(media, {
    email: 'ana@example.com',
    topics: ['hermetismo'],
    features: ['search', 'media', 'media-upload'],
  });
  const master = media.owner;
  return { vault, media, ana, master };
}

/** A document in the collection, sent from the app and gone through the Mac. */
async function withDocument() {
  const made = await world();
  const { vault, media, ana } = made;
  const upload = await sentFile(media, ana);
  const mac = await docMac(media);
  const job = await leaseDoc(media, mac.token);
  const document = { id: ID, title: 'O Caibalion' };
  await docResult(media, {
    token: mac.token,
    job,
    outcome: { state: 'ready', document },
  });
  await writeConverted(media, {
    vault,
    id: ID,
    title: 'O Caibalion',
    sha256: PDF_SHA,
  });
  return { ...made, upload, mac };
}

type World = Awaited<ReturnType<typeof withDocument>>;

const ownerOf = (media: Media) => ({
  call: media.owner,
  headers: media.ownerHeaders,
});

const removed = async (made: World): Promise<DocumentRemoval> => {
  const response = await made.master('POST', `${url()}/removal`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<DocumentRemoval>();
};

const listed = async ({ master }: Pick<World, 'master'>) =>
  (await master('GET', REMOVALS)).json<{ items: DocumentRemoval[] }>().items;

/** The Mac moves the file, as kb does, and says so. */
async function moved(
  { vault, media, mac }: World,
  job: DocIngestJob,
): Promise<void> {
  const inside = join(vault, 'hermetismo', ID);
  const apart = join(
    vault,
    'hermetismo',
    ID.replace('raw/', 'raw/_quarantine/'),
  );
  const [from, to] =
    job.source.kind === 'remove' ? [inside, apart] : [apart, inside];
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
  const done = await docResult(media, {
    token: mac.token,
    job,
    outcome: { state: 'moved' },
  });
  expect(done.statusCode, done.body).toBe(204);
  await media.started.catalog.refresh('hermetismo');
}

const nothingToLease = async ({ media, mac }: World) =>
  (await leaseAs(media, mac.token, ['doc-ingest'])).statusCode;

/** What a person may reach it by. */
async function reach(media: Media, call: World['master']) {
  const found = await call(
    'GET',
    '/api/v1/topics/hermetismo/search?q=Caibalion&mode=lexical',
  );
  return {
    read: (await call('GET', url())).statusCode,
    found: found.body.includes(ID),
    cataloged: media.started.catalog.get('hermetismo')?.entries.has(ID),
  };
}

describe('Removing a document from its collection in the app (KBC-187)', () => {
  it('is gone from the app at once, before the Mac moves anything (BR-2)', async () => {
    const made = await withDocument();
    const { media, ana, master } = made;
    expect(await reach(media, ana.call)).toMatchObject({
      read: 200,
      cataloged: true,
    });
    const removal = await removed(made);
    expect(removal).toMatchObject({
      topic: 'hermetismo',
      document: { id: ID, title: 'O Caibalion' },
      state: 'removing',
    });
    for (const call of [ana.call, master])
      expect(await reach(media, call)).toEqual({
        read: 404,
        found: false,
        cataloged: false,
      });
    // What sent it there leaves the list of what is being done.
    expect(await uploadsOf(ana.call)).toEqual([]);
  });

  it('only masters remove, list and bring back (BR-1)', async () => {
    const made = await withDocument();
    const { ana, master } = made;
    expect((await ana.call('POST', `${url()}/removal`)).statusCode).toBe(403);
    expect((await ana.call('GET', REMOVALS)).statusCode).toBe(403);
    const { id } = await removed(made);
    for (const what of ['restore', 'retry'])
      expect(
        (await ana.call('POST', `${REMOVALS}/${id}/${what}`)).statusCode,
      ).toBe(403);
    // Removed already, unknown, a page of kb's own, and another collection: the same answer.
    for (const at of [
      url(),
      url('raw/nada.md'),
      url('wiki/concepts/hermetismo.md'),
      url(ID, 'udv'),
      url('raw/../raw/articles/o-caibalion.md'),
    ])
      expect((await master('POST', `${at}/removal`)).statusCode).toBe(404);
  });

  it('the Mac moves it to the quarantine, and back when it is asked', async () => {
    const made = await withDocument();
    const { media, mac, master, ana } = made;
    const { id } = await removed(made);
    const job = await leaseDoc(media, mac.token);
    expect(job).toMatchObject({
      id,
      topic: 'hermetismo',
      budgetUsd: 0,
      source: { kind: 'remove', document: ID },
    });
    await moved(made, job);
    expect(await listed(made)).toMatchObject([{ id, state: 'removed' }]);
    expect(await nothingToLease(made)).toBe(204);

    const asked = await master('POST', `${REMOVALS}/${id}/restore`);
    expect(asked.json()).toMatchObject({ removal: { state: 'restoring' } });
    expect((await master('POST', `${REMOVALS}/${id}/restore`)).statusCode).toBe(
      409,
    );
    const back = await leaseDoc(media, mac.token);
    expect(back.source).toEqual({ kind: 'restore', document: ID });
    await moved(made, back);
    expect(await listed(made)).toEqual([]);
    expect(await reach(media, ana.call)).toMatchObject({
      read: 200,
      cataloged: true,
    });
  });

  it('brought back before the Mac took it, it is there at once and the Mac does nothing', async () => {
    const made = await withDocument();
    const { media, master, ana } = made;
    const { id } = await removed(made);
    const asked = await master('POST', `${REMOVALS}/${id}/restore`);
    expect(asked.json()).toEqual({ removal: null });
    expect(await nothingToLease(made)).toBe(204);
    expect(await reach(media, ana.call)).toMatchObject({ read: 200 });
  });

  it('asked back while the Mac moves it, it is moved back right after', async () => {
    const made = await withDocument();
    const { media, mac, master } = made;
    const { id } = await removed(made);
    const job = await leaseDoc(media, mac.token);
    await master('POST', `${REMOVALS}/${id}/restore`);
    await moved(made, job);
    const back = await leaseDoc(media, mac.token);
    expect(back.source.kind).toBe('restore');
    await moved(made, back);
    expect(await listed(made)).toEqual([]);
  });

  it('what the Mac could not do says why, stays hidden, and is asked again', async () => {
    const made = await withDocument();
    const { media, mac, master } = made;
    const { id } = await removed(made);
    const job = await leaseDoc(media, mac.token);
    await docResult(media, {
      token: mac.token,
      job,
      outcome: {
        state: 'failed',
        failure: 'conversion-failed',
        detail: 'kb review: no',
      },
    });
    expect(await listed(made)).toMatchObject([
      { id, state: 'failed', detail: 'kb review: no' },
    ]);
    expect(await nothingToLease(made)).toBe(204);
    expect(await reach(media, master)).toMatchObject({ read: 404 });
    expect(
      (await master('POST', `${REMOVALS}/${id}/retry`)).json(),
    ).toMatchObject({ state: 'removing', detail: null });
    expect((await leaseDoc(media, mac.token)).source.kind).toBe('remove');
    expect((await master('POST', `${REMOVALS}/${id}/retry`)).statusCode).toBe(
      409,
    );
  });

  it('what it was made of may be sent again: it comes back, and its removal ends (BR-6)', async () => {
    const made = await withDocument();
    const { media, mac, ana, vault } = made;
    await removed(made);
    const job = await leaseDoc(media, mac.token);
    await moved(made, job);
    // Who sends it again is a master: no one else brings it back.
    const upload = await sentFile(media, ownerOf(media));
    const again = await leaseDoc(media, mac.token);
    expect(again.id).toBe(upload.id);
    // As the Mac does it: kb tells the same text in its quarantine, and it is restored.
    await rename(
      join(vault, 'hermetismo', ID.replace('raw/', 'raw/_quarantine/')),
      join(vault, 'hermetismo', ID),
    );
    await docResult(media, {
      token: mac.token,
      job: again,
      outcome: { state: 'ready', document: { id: ID, title: 'O Caibalion' } },
    });
    await media.started.catalog.refresh('hermetismo');
    expect(await listed(made)).toEqual([]);
    expect(await reach(media, ana.call)).toMatchObject({ read: 200 });
  });

  it('sent again by who is no master, it stays out; a master brings it back so (BR-1)', async () => {
    const made = await withDocument();
    const { media, mac, ana, master } = made;
    await removed(made);
    await moved(made, await leaseDoc(media, mac.token));
    const refused = await announce(ana.call);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      error: { code: 'DOCUMENT_REMOVED' },
    });
    const byMaster = await announce(master);
    expect(byMaster.json()).toMatchObject({ outcome: 'created' });
  });

  it('a Mac from before, that calls it a repeat, leaves nothing that cannot be sent (BR-6)', async () => {
    const made = await withDocument();
    const { media, mac, ana } = made;
    await removed(made);
    await moved(made, await leaseDoc(media, mac.token));
    await sentFile(media, ownerOf(media));
    await docResult(media, {
      token: mac.token,
      job: await leaseDoc(media, mac.token),
      outcome: {
        state: 'duplicate',
        document: {
          id: ID.replace('raw/', 'raw/_quarantine/'),
          title: 'O Caibalion',
        },
      },
    });
    expect(await uploadsOf(ana.call)).toEqual([]);
    expect((await announce(media.owner)).json()).toMatchObject({
      outcome: 'created',
    });
  });

  it('one the Mac could not take, sent again, is there again (BR-6)', async () => {
    const made = await withDocument();
    const { media, mac, ana } = made;
    await removed(made);
    const outcome = {
      state: 'failed',
      failure: 'conversion-failed',
      detail: 'frontmatter: invalid_yaml',
    };
    await docResult(media, {
      token: mac.token,
      job: await leaseDoc(media, mac.token),
      outcome,
    });
    await sentFile(media, ownerOf(media));
    await docResult(media, {
      token: mac.token,
      job: await leaseDoc(media, mac.token),
      outcome: {
        state: 'duplicate',
        document: { id: ID, title: 'O Caibalion' },
      },
    });
    await media.started.catalog.refresh('hermetismo');
    expect(await listed(made)).toEqual([]);
    expect(await reach(media, ana.call)).toMatchObject({ read: 200 });
  });

  it('one asked for while the document was entering stands (I-3)', async () => {
    const made = await world();
    const { vault, media, ana, master } = made;
    await sentFile(media, ana);
    const mac = await docMac(media);
    const job = await leaseDoc(media, mac.token);
    await writeConverted(media, { vault, id: ID, title: 'O Caibalion' });
    const asked = await master('POST', `${url()}/removal`);
    expect(asked.statusCode).toBe(200);
    await docResult(media, {
      token: mac.token,
      job,
      outcome: { state: 'ready', document: { id: ID, title: 'O Caibalion' } },
    });
    expect(await listed(made)).toMatchObject([{ state: 'removing' }]);
    expect(await reach(media, master)).toMatchObject({ read: 404 });
  });

  it('its row is back on the list only with it', async () => {
    const made = await withDocument();
    const { ana, master } = made;
    expect(await uploadsOf(ana.call)).toHaveLength(1);
    const { id } = await removed(made);
    expect(await uploadsOf(ana.call)).toEqual([]);
    await master('POST', `${REMOVALS}/${id}/restore`);
    expect(await uploadsOf(ana.call)).toMatchObject([{ state: 'ready' }]);
  });

  it('an old answer that cites it keeps its prose, and its source is closed to all (BR-5)', async () => {
    const made = await withDocument();
    const { master } = made;
    const id = '9b2e6d2f-4a3b-4d6c-9e7f-8091a2b3c4d5';
    const source = {
      n: 1,
      id: ID,
      title: 'O Caibalion',
      authorship: 'outros-autores',
    };
    const at = '2026-11-25T12:00:00.000Z';
    const saved = {
      kind: 'research',
      id,
      topic: 'hermetismo',
      title: 'o todo',
      createdAt: at,
      updatedAt: at,
      turns: [
        {
          ...{ id: '8a1e6d2f-4a3b-4d6c-9e7f-8091a2b3c4d5', at },
          ...{ question: 'o todo?', answer: 'O todo é mente [1].' },
          ...{ sources: [source], steps: 1, usd: 0, interrupted: false },
          ...{ billing: 'subscription', model: 'stub/model' },
        },
      ],
    };
    const at1 = `/api/v1/conversations/${id}`;
    const put = await master('PUT', at1, saved);
    expect(put.statusCode, put.body).toBe(200);
    const turnNow = async () =>
      (await master('GET', at1)).json<{
        turns: { answer: string; sources: object[] }[];
      }>().turns[0];
    expect((await turnNow())?.sources[0]).toMatchObject({ id: ID });
    const { id: removal } = await removed(made);
    expect(await turnNow()).toMatchObject({
      answer: 'O todo é mente [1].',
      sources: [{ n: 1, restricted: true }],
    });
    // Back in the collection, it is its source again: nothing stored was lost.
    await master('POST', `${REMOVALS}/${removal}/restore`);
    expect((await turnNow())?.sources[0]).toMatchObject({ id: ID });
  });
});
