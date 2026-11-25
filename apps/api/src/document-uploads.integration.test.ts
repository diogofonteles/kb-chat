import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CreateDocumentUploadResponse } from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL, closeApp } from '../test/ai-app-harness.js';
import {
  DOCUMENTS,
  PDF,
  PDF_SHA,
  UPLOADS,
  announce,
  asMac,
  docMac,
  docResult,
  docState,
  leaseDoc,
  localHeaders,
  sendPart,
  sentFile,
  uploadsOf,
  writeConverted,
} from '../test/document-uploads-harness.js';
import { leaseAs, publisherMac } from '../test/kb-publish-harness.js';
import {
  member,
  startMedia,
  vaultWithUdv,
  type Media,
} from '../test/media-harness.js';

afterEach(closeApp);

async function world() {
  const vault = await vaultWithUdv();
  const media = await startMedia({ vault });
  const ana = await member(media, {
    email: 'ana@example.com',
    topics: ['hermetismo'],
    features: ['search', 'media', 'media-upload'],
  });
  return { vault, media, ana };
}

const created = (body: string) => {
  const answer = JSON.parse(body) as CreateDocumentUploadResponse;
  if (answer.outcome !== 'created') throw new Error(body);
  return answer.upload;
};

describe('Sending documents and links from the app (KBC-149)', () => {
  it('AC-1: a PDF goes through every state to "pronto" and reaches the catalog', async () => {
    const { vault, media, ana } = await world();
    const announced = await announce(ana.call);
    expect(announced.statusCode, announced.body).toBe(201);
    const upload = created(announced.body);
    expect(upload).toMatchObject({
      kind: 'file',
      state: 'receiving',
      name: 'O Caibalion.pdf',
      uploadUrl: `${UPLOADS}/${upload.id}/upload`,
      received: 0,
    });
    // Resumable (tus): half, a HEAD that says where it stopped, then the rest.
    const half = Math.floor(PDF.length / 2);
    const first = await sendPart(media, {
      id: upload.id,
      body: PDF.subarray(0, half),
      offset: 0,
      headers: ana.headers,
    });
    expect(first.headers['upload-offset']).toBe(String(half));
    const head = await media.started.app.inject({
      method: 'HEAD',
      url: `${UPLOADS}/${upload.id}/upload`,
      headers: ana.headers,
    });
    expect(head.headers['upload-offset']).toBe(String(half));
    expect(head.headers['upload-length']).toBe(String(PDF.length));
    const wrongOffset = await sendPart(media, {
      id: upload.id,
      body: PDF.subarray(half),
      offset: 0,
      headers: ana.headers,
    });
    expect(wrongOffset.statusCode).toBe(409);
    const rest = await sendPart(media, {
      id: upload.id,
      body: PDF.subarray(half),
      offset: half,
      headers: ana.headers,
    });
    expect(rest.headers['upload-offset']).toBe(String(PDF.length));
    expect((await uploadsOf(ana.call))[0]?.state).toBe('received');

    const mac = await docMac(media);
    const job = await leaseDoc(media, mac.token);
    expect(job).toMatchObject({
      topic: 'hermetismo',
      source: {
        kind: 'file',
        name: 'O Caibalion.pdf',
        sha256: PDF_SHA,
        bytes: PDF.length,
        filePath: `/api/v1/media-worker/jobs/${job.id}/document`,
      },
    });
    expect(job.budgetUsd).toBeGreaterThan(0);
    const file = await media.started.app.inject({
      method: 'GET',
      url: `${job.source.kind === 'file' ? job.source.filePath : ''}?leaseId=${job.leaseId}`,
      headers: localHeaders(mac.token),
    });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(PDF)).toBe(true);
    expect((await uploadsOf(ana.call))[0]?.state).toBe('converting');
    for (const state of ['classifying', 'mapping']) {
      const step = await docState(media, { token: mac.token, job, state });
      expect(step.statusCode, step.body).toBe(204);
      expect((await uploadsOf(ana.call))[0]?.state).toBe(state);
    }
    const document = {
      id: 'raw/articles/o-caibalion.md',
      title: 'O Caibalion',
    };
    const done = await docResult(media, {
      token: mac.token,
      job,
      outcome: { state: 'ready', document },
      spendUsd: 0.002,
    });
    expect(done.statusCode, done.body).toBe(204);
    // Done on the Mac, not in the app yet: "no mapa", and no link to a document not there.
    expect((await uploadsOf(ana.call))[0]).toMatchObject({
      state: 'mapped',
      document: null,
    });
    await writeConverted(media, { vault, ...document, sha256: PDF_SHA });
    expect((await uploadsOf(ana.call))[0]).toMatchObject({
      state: 'ready',
      document,
      failure: null,
    });
    const found = await ana.call(
      'GET',
      `${DOCUMENTS}/${encodeURIComponent(document.id)}`,
    );
    expect(found.statusCode).toBe(200);
    // The file is kept only until the job ends; nothing left for the Mac.
    expect((await leaseAs(media, mac.token, ['doc-ingest'])).statusCode).toBe(
      204,
    );
  });

  it('AC-2: Beto without the upload permission gets 403, and outside the collection 404', async () => {
    const { media } = await world();
    const beto = await member(media, {
      email: 'beto@example.com',
      topics: ['hermetismo'],
      features: ['search', 'media'],
    });
    const refused = await announce(beto.call);
    expect(refused.statusCode).toBe(403);
    expect((await beto.call('GET', UPLOADS)).statusCode).toBe(403);
    const caio = await member(media, {
      email: 'caio@example.com',
      topics: ['alquimia'],
      features: ['media', 'media-upload'],
    });
    const outside = await announce(caio.call);
    expect([403, 404]).toContain(outside.statusCode);
    const anonymous = await media.started.app.inject({
      method: 'POST',
      url: DOCUMENTS,
      headers: LOCAL,
      payload: { kind: 'url', url: 'https://example.org' },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('AC-3: a PDF already in the collection answers with the document, not a new upload', async () => {
    const { vault, media, ana } = await world();
    const document = {
      id: 'raw/articles/o-caibalion.md',
      title: 'O Caibalion',
    };
    await writeConverted(media, { vault, ...document, sha256: PDF_SHA });

    const again = await announce(ana.call, { name: 'copia.pdf' });

    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({
      outcome: 'duplicate',
      document,
      upload: null,
    });
    expect(await uploadsOf(ana.call)).toEqual([]);
  });

  it('BR-3: the same file on its way, or the same link, is not sent twice', async () => {
    const { media, ana } = await world();
    const first = await sentFile(media, ana);
    const second = await announce(ana.call);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      outcome: 'duplicate',
      document: null,
      upload: { id: first.id, state: 'received' },
    });
    const link = { kind: 'url', url: 'https://example.org/artigo' };
    expect((await ana.call('POST', DOCUMENTS, link)).statusCode).toBe(201);
    expect((await ana.call('POST', DOCUMENTS, link)).json().outcome).toBe(
      'duplicate',
    );
  });

  it('AC-4: a link that does not convert fails with why, and nothing enters', async () => {
    const { media, ana } = await world();
    const sent = await ana.call('POST', DOCUMENTS, {
      kind: 'url',
      url: 'https://example.org/quebrado',
    });
    expect(created(sent.body)).toMatchObject({
      kind: 'url',
      state: 'received',
    });
    const mac = await docMac(media);
    const job = await leaseDoc(media, mac.token);
    expect(job.source).toEqual({
      kind: 'url',
      url: 'https://example.org/quebrado',
    });

    await docResult(media, {
      token: mac.token,
      job,
      outcome: {
        state: 'failed',
        failure: 'conversion-failed',
        detail: 'firecrawl: HTTP 404; jina: HTTP 404',
      },
    });

    const [mine] = await uploadsOf(ana.call);
    expect(mine).toMatchObject({
      state: 'failed',
      failure: 'conversion-failed',
      detail: null,
      document: null,
    });
    const [asOwner] = await uploadsOf(media.owner);
    expect(asOwner?.detail).toBe('firecrawl: HTTP 404; jina: HTTP 404');
    // A failed one can be sent again.
    expect(
      (
        await ana.call('POST', DOCUMENTS, {
          kind: 'url',
          url: 'https://example.org/quebrado',
        })
      ).statusCode,
    ).toBe(201);
  });

  it('a Mac without "Publica no acervo" never gets doc-ingest, nor its routes', async () => {
    const { media, ana } = await world();
    const upload = await sentFile(media, ana);
    const plain = await publisherMac(media, ['transcribe']);
    expect((await leaseAs(media, plain.token, ['doc-ingest'])).statusCode).toBe(
      403,
    );
    expect((await leaseAs(media, plain.token, ['transcribe'])).statusCode).toBe(
      204,
    );
    const sneaky = await asMac(media, plain.token, {
      method: 'POST',
      url: `/api/v1/media-worker/jobs/${upload.id}/doc-state`,
      payload: {
        worker: 'mac',
        leaseId: '00000000-0000-4000-8000-000000000000',
        state: 'converting',
      },
    });
    expect(sneaky.statusCode).toBe(404);
  });

  it('a lost lease answers 409, a crash goes back to the queue, three of them give up', async () => {
    const { media, ana } = await world();
    await sentFile(media, ana);
    const mac = await docMac(media);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const job = await leaseDoc(media, mac.token);
      expect(job.attempt).toBe(attempt);
      const stale = await docState(media, {
        token: mac.token,
        job: { ...job, leaseId: '00000000-0000-4000-8000-000000000000' },
        state: 'classifying',
      });
      expect(stale.statusCode).toBe(409);
      const crashed = await asMac(media, mac.token, {
        method: 'POST',
        url: `/api/v1/media-worker/jobs/${job.id}/fail`,
        payload: {
          worker: 'mac',
          leaseId: job.leaseId,
          failure: 'conversion-failed',
          detail: 'RuntimeError: boom',
        },
      });
      expect(crashed.statusCode, crashed.body).toBe(204);
    }
    expect((await uploadsOf(ana.call))[0]).toMatchObject({
      state: 'failed',
      failure: 'gave-up',
    });
    expect((await leaseAs(media, mac.token, ['doc-ingest'])).statusCode).toBe(
      204,
    );
  });

  it('a different file than announced starts over; a part past the size is refused', async () => {
    const { media, ana } = await world();
    const upload = created((await announce(ana.call)).body);
    const other = Buffer.alloc(PDF.length, 1);
    const sent = await sendPart(media, {
      id: upload.id,
      body: other,
      offset: 0,
      headers: ana.headers,
    });
    expect(sent.headers['upload-offset']).toBe('0');
    const big = await sendPart(media, {
      id: upload.id,
      body: Buffer.concat([PDF, PDF]),
      offset: 0,
      headers: ana.headers,
    });
    expect(big.statusCode).toBe(413);
    expect((await uploadsOf(ana.call))[0]?.state).toBe('receiving');
    // Someone else's upload does not exist for them.
    const other2 = await member(media, {
      email: 'bia@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-upload'],
    });
    const foreign = await sendPart(media, {
      id: upload.id,
      body: PDF,
      offset: 0,
      headers: other2.headers,
    });
    expect(foreign.statusCode).toBe(404);
    expect(await uploadsOf(other2.call)).toEqual([]);
  });

  it('refuses what is not a document or not a web link', async () => {
    const { ana } = await world();
    for (const body of [
      { kind: 'file', name: 'aula.mp3', bytes: 10, sha256: PDF_SHA },
      { kind: 'url', url: 'file:///etc/passwd' },
      { kind: 'url', url: 'https://user:pw@example.org/x' },
      { kind: 'url', url: 'javascript:alert(1)' },
      { kind: 'url', url: 'não é um endereço' },
    ])
      expect((await ana.call('POST', DOCUMENTS, body)).statusCode).toBe(400);
  });

  it('keeps the uploads across a restart', async () => {
    const { media, ana } = await world();
    const upload = await sentFile(media, ana);
    const stored = JSON.parse(
      await readFile(
        join(media.started.state, 'document-uploads.json'),
        'utf8',
      ),
    );
    expect(stored.uploads.map((one: { id: string }) => one.id)).toEqual([
      upload.id,
    ]);
    expect(stored.uploads[0].owner.email).toBe('ana@example.com');
  });
});

describe('A recording link goes through the transcriber (KBC-142 BR-5)', () => {
  it("the Mac gives its audio back and it becomes the sender's recording", async () => {
    const { media, ana } = await world();
    const sent = await ana.call('POST', DOCUMENTS, {
      kind: 'url',
      url: 'https://www.youtube.com/watch?v=abc123',
    });
    expect(created(sent.body).kind).toBe('recording');
    const mac = await docMac(media);
    const job = await leaseDoc(media, mac.token);
    expect(job.source).toEqual({
      kind: 'recording',
      url: 'https://www.youtube.com/watch?v=abc123',
      audioPath: `/api/v1/media-worker/jobs/${job.id}/recording-audio`,
    });
    const audio = Buffer.from('ID3 fake m4a audio from youtube');
    const given = await media.started.app.inject({
      method: 'POST',
      url: `/api/v1/media-worker/jobs/${job.id}/recording-audio?leaseId=${job.leaseId}&name=${encodeURIComponent('Uma aula [abc123].m4a')}`,
      headers: {
        ...localHeaders(mac.token),
        'content-type': 'application/octet-stream',
      },
      payload: audio,
    });
    expect(given.statusCode, given.body).toBe(200);
    const { mediaId } = given.json<{ mediaId: string }>();
    const [mine] = await uploadsOf(ana.call);
    expect(mine).toMatchObject({ state: 'transcribing', mediaId });
    const item = await ana.call('GET', `/api/v1/media/${mediaId}`);
    expect(item.statusCode, item.body).toBe(200);
    expect(item.json()).toMatchObject({ title: 'Uma aula' });
  });
});

describe('One inclusion and its ceiling (KBC-009 R2, R3)', () => {
  const BATCH = '99999999-9999-4999-8999-999999999999';
  const link = (call: Media['owner'], url: string, fields: object = {}) =>
    call('POST', DOCUMENTS, { kind: 'url', url, ...fields });

  it('a collection made on the screen takes documents, and its job says how to make its folder', async () => {
    const { media } = await world();
    const made = await media.owner('POST', '/api/v1/topics', {
      title: 'Cocreation',
      description: '',
    });
    expect(made.statusCode, made.body).toBe(201);
    const sent = await media.owner(
      'POST',
      '/api/v1/topics/cocreation/documents',
      {
        kind: 'url',
        url: 'https://example.org/artigo',
      },
    );
    expect(sent.statusCode, sent.body).toBe(201);
    const mac = await docMac(media);
    const job = await leaseDoc(media, mac.token);
    expect(job.topic).toBe('cocreation');
    expect(job.collection).toMatchObject({ title: 'Cocreation', parent: null });
  });

  it('items sent together share the ceiling; spent, the rest waits until it is raised', async () => {
    const { media, ana } = await world();
    const batch = { id: BATCH, capUsd: 0.05 };
    for (const url of ['https://example.org/1', 'https://example.org/2']) {
      const sent = await link(ana.call, url, { batch });
      expect(sent.statusCode, sent.body).toBe(201);
    }
    const mac = await docMac(media);
    const job = await leaseDoc(media, mac.token);
    expect(job.budgetUsd).toBeCloseTo(0.05);
    await docResult(media, {
      token: mac.token,
      job,
      outcome: { state: 'ready', document: { id: 'raw/a.md', title: 'A' } },
      spendUsd: 0.05,
    });
    expect((await leaseAs(media, mac.token, ['doc-ingest'])).statusCode).toBe(
      204,
    );
    const held = (await uploadsOf(ana.call)).find(
      (one) => one.state === 'received',
    );
    expect(held).toMatchObject({
      heldBy: 'batch-cap',
      batch: { id: BATCH, capUsd: 0.05, spentUsd: 0.05 },
    });

    const raised = await ana.call(
      'PATCH',
      `/api/v1/document-batches/${BATCH}`,
      {
        capUsd: 0.2,
      },
    );
    expect(raised.statusCode, raised.body).toBe(200);
    expect(raised.json()).toEqual({ id: BATCH, capUsd: 0.2, spentUsd: 0.05 });
    expect((await leaseDoc(media, mac.token)).budgetUsd).toBeCloseTo(0.15);
  });

  it('nobody else joins or changes an inclusion, and a ceiling out of range is refused', async () => {
    const { media, ana } = await world();
    const beto = await member(media, {
      email: 'beto@example.com',
      topics: ['hermetismo'],
      features: ['search', 'media', 'media-upload'],
    });
    const batch = { id: BATCH, capUsd: 0.5 };
    await link(ana.call, 'https://example.org/1', { batch });
    const joined = await link(beto.call, 'https://example.org/2', { batch });
    expect(joined.statusCode).toBe(404);
    const changed = await beto.call(
      'PATCH',
      `/api/v1/document-batches/${BATCH}`,
      { capUsd: 5 },
    );
    expect(changed.statusCode).toBe(404);
    for (const capUsd of [0, 0.01, 5.01])
      expect(
        (
          await link(ana.call, 'https://example.org/3', {
            batch: { id: BATCH, capUsd },
          })
        ).statusCode,
      ).toBe(400);
  });

  it('a failed file goes again as it was sent; once its bytes are gone it does not', async () => {
    const { media, ana } = await world();
    const sent = await sentFile(media, ana);
    const url = `${UPLOADS}/${sent.id}/retry`;
    expect((await ana.call('POST', url)).statusCode).toBe(409);
    const mac = await docMac(media);
    await docResult(media, {
      token: mac.token,
      job: await leaseDoc(media, mac.token),
      outcome: { state: 'failed', failure: 'empty', detail: 'nothing' },
    });
    expect((await uploadsOf(ana.call))[0]).toMatchObject({
      state: 'failed',
      retriable: true,
    });
    const again = await ana.call('POST', url);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ state: 'received', failure: null });
    const job = await leaseDoc(media, mac.token);
    expect(job).toMatchObject({ id: sent.id, attempt: 1 });
    const file = await asMac(media, mac.token, {
      method: 'GET',
      url: `/api/v1/media-worker/jobs/${job.id}/document?leaseId=${job.leaseId}`,
    });
    expect(file.rawPayload.equals(PDF)).toBe(true);
    await docResult(media, {
      token: mac.token,
      job,
      outcome: { state: 'failed', failure: 'empty', detail: 'nothing' },
    });
    await rm(join(media.started.state, 'document-uploads'), {
      recursive: true,
    });
    expect((await uploadsOf(ana.call))[0]).toMatchObject({ retriable: false });
    expect((await ana.call('POST', url)).statusCode).toBe(409);
  });

  it('a folder of more than 100 files is announced without stopping at the audio limit', async () => {
    const { ana } = await world();
    const answers = [];
    for (let n = 0; n < 120; n += 1)
      answers.push(
        (await link(ana.call, `https://example.org/${n}`)).statusCode,
      );
    expect(new Set(answers)).toEqual(new Set([201]));
    expect(await uploadsOf(ana.call)).toHaveLength(120);
  });

  it('an item is taken out before the Mac has it; while it works, 409; the document stays', async () => {
    const { media, ana } = await world();
    const beto = await member(media, {
      email: 'beto@example.com',
      topics: ['hermetismo'],
      features: ['search', 'media', 'media-upload'],
    });
    const sent = created((await link(ana.call, 'https://example.org/1')).body);
    const url = `${UPLOADS}/${sent.id}`;
    expect((await beto.call('DELETE', url)).statusCode).toBe(404);
    const mac = await docMac(media);
    const job = await leaseDoc(media, mac.token);
    expect((await ana.call('DELETE', url)).statusCode).toBe(409);
    await docResult(media, {
      token: mac.token,
      job,
      outcome: { state: 'failed', failure: 'conversion-failed', detail: '404' },
    });
    expect((await ana.call('DELETE', url)).statusCode).toBe(204);
    expect(await uploadsOf(ana.call)).toEqual([]);
    expect((await ana.call('DELETE', url)).statusCode).toBe(404);
  });
});

describe('Recordings, lists and their cost (KBC-186)', () => {
  const PLAYLIST = 'https://www.youtube.com/playlist?list=PL1';
  const ENTRIES = [1, 2, 3].map((n) => ({
    url: `https://www.youtube.com/watch?v=${n}`,
    title: `Aula ${n}`,
    durationS: n * 60,
  }));
  const send = (call: Media['owner'], body: object) =>
    call('POST', DOCUMENTS, { kind: 'url', ...body });

  it.each([
    [{ url: 'https://vimeo.com/123' }, 'recording'],
    [{ url: 'https://example.org/aula.mp3' }, 'recording'],
    [{ url: 'https://example.org/artigo' }, 'url'],
    [{ url: 'https://example.org/artigo', as: 'recording' }, 'recording'],
    [{ url: 'https://vimeo.com/123', as: 'page' }, 'url'],
    [{ url: PLAYLIST }, 'list'],
  ])('%o is a %s', async (body, kind) => {
    const { ana } = await world();
    const sent = created((await send(ana.call, body)).body);
    expect(sent.kind).toBe(kind);
  });

  async function listed() {
    const { media, ana } = await world();
    const batch = { id: '99999999-9999-4999-8999-999999999999', capUsd: 1 };
    const list = created((await send(ana.call, { url: PLAYLIST, batch })).body);
    const mac = await docMac(media);
    const job = await leaseDoc(media, mac.token);
    const entries = (body: object) =>
      asMac(media, mac.token, {
        method: 'POST',
        url: `/api/v1/media-worker/jobs/${job.id}/doc-entries`,
        payload: { worker: 'mac', leaseId: job.leaseId, ...body },
      });
    return { media, ana, list, mac, job, entries };
  }

  it('a playlist waits for the person, and only the chosen recordings enter, in its inclusion', async () => {
    const { media, ana, list, mac, job, entries } = await listed();
    expect(job.source).toMatchObject({ kind: 'list', url: PLAYLIST });
    expect((await entries({ entries: ENTRIES })).statusCode).toBe(204);
    const [waiting] = await uploadsOf(ana.call);
    expect(waiting).toMatchObject({ state: 'choosing', entries: ENTRIES });
    // Nothing is on its way before the choice.
    expect((await leaseAs(media, mac.token, ['doc-ingest'])).statusCode).toBe(
      204,
    );

    const url = `${UPLOADS}/${list.id}/choose`;
    const urls = [ENTRIES[0]?.url, ENTRIES[2]?.url];
    const chosen = await ana.call('POST', url, { urls });
    expect(chosen.statusCode, chosen.body).toBe(200);
    expect(chosen.json()).toEqual({ created: 2, already: 0 });
    const uploads = await uploadsOf(ana.call);
    expect(uploads.map((one) => one.name).sort()).toEqual(['Aula 1', 'Aula 3']);
    expect(uploads[0]).toMatchObject({
      kind: 'recording',
      state: 'received',
      batch: { capUsd: 1 },
      entries: [],
    });
    // A second press finds nothing to choose from.
    expect((await ana.call('POST', url, { urls })).statusCode).toBe(404);
  });

  it('the same list later: what is on its way counts as already there', async () => {
    const { media, ana, list, mac, entries } = await listed();
    await entries({ entries: ENTRIES });
    const first = [ENTRIES[0]?.url];
    await ana.call('POST', `${UPLOADS}/${list.id}/choose`, { urls: first });
    const again = created((await send(ana.call, { url: PLAYLIST })).body);
    // The chosen recording is first in line; its audio given back, the list comes.
    const recording = await leaseDoc(media, mac.token);
    const given = await media.started.app.inject({
      method: 'POST',
      url: `/api/v1/media-worker/jobs/${recording.id}/recording-audio?leaseId=${recording.leaseId}&name=a.m4a`,
      headers: {
        ...localHeaders(mac.token),
        'content-type': 'application/octet-stream',
      },
      payload: Buffer.from('ID3 fake audio'),
    });
    expect(given.statusCode, given.body).toBe(200);
    const job = await leaseDoc(media, mac.token);
    expect(job.id).toBe(again.id);
    await asMac(media, mac.token, {
      method: 'POST',
      url: `/api/v1/media-worker/jobs/${job.id}/doc-entries`,
      payload: { worker: 'mac', leaseId: job.leaseId, entries: ENTRIES },
    });
    const chosen = await ana.call('POST', `${UPLOADS}/${again.id}/choose`, {
      urls: ENTRIES.map((one) => one.url),
    });
    expect(chosen.json()).toEqual({ created: 2, already: 1 });
  });

  it('refuses a recording the list does not have, another person, and a list not read yet', async () => {
    const { media, ana, list, entries } = await listed();
    const url = `${UPLOADS}/${list.id}/choose`;
    const urls = [ENTRIES[0]?.url];
    expect((await ana.call('POST', url, { urls })).statusCode).toBe(409);
    await entries({ entries: ENTRIES });
    const beto = await member(media, {
      email: 'beto@example.com',
      topics: ['hermetismo'],
      features: ['search', 'media', 'media-upload'],
    });
    expect((await beto.call('POST', url, { urls })).statusCode).toBe(404);
    const other = { urls: ['https://youtu.be/outra'] };
    expect((await ana.call('POST', url, other)).statusCode).toBe(400);
    expect((await ana.call('POST', url, { urls: [] })).statusCode).toBe(400);
  });

  it('an empty list fails with why; an entry that is not a web address is refused', async () => {
    const { ana, entries } = await listed();
    const file = { url: 'file:///x', title: 'x', durationS: null };
    expect((await entries({ entries: [file] })).statusCode).toBe(400);
    expect((await entries({ entries: [] })).statusCode).toBe(204);
    expect((await uploadsOf(ana.call))[0]).toMatchObject({
      state: 'failed',
      failure: 'empty',
    });
  });

  it('says what each kind costs here, to who may send', async () => {
    const { media, ana } = await world();
    const costs = await ana.call('GET', `${UPLOADS}/costs`);
    expect(costs.statusCode, costs.body).toBe(200);
    expect(costs.json()).toMatchObject({ document: { samples: 0 } });
    const beto = await member(media, {
      email: 'beto@example.com',
      topics: ['hermetismo'],
      features: ['search', 'media'],
    });
    expect((await beto.call('GET', `${UPLOADS}/costs`)).statusCode).toBe(403);
  });
});

describe('Levels (ADR 0036 §5)', () => {
  it('in a collection with levels a level is required, and the document is born at it', async () => {
    const { vault, media, ana } = await world();
    for (const code of ['QS', 'CI']) {
      const made = await media.owner(
        'POST',
        '/api/v1/topics/hermetismo/levels',
        {
          code,
        },
      );
      expect(made.statusCode, made.body).toBe(201);
    }
    const missing = await announce(ana.call);
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('LEVEL_REQUIRED');
    const above = await announce(ana.call, { level: 'ci' });
    expect(above.statusCode).toBe(403);
    await sentFile(media, ana, { level: 'qs' });
    const mac = await docMac(media);
    const job = await leaseDoc(media, mac.token);
    const document = { id: 'raw/articles/nivel.md', title: 'Nível' };
    await docResult(media, {
      token: mac.token,
      job,
      outcome: { state: 'ready', document },
    });

    const placed = JSON.parse(
      await readFile(join(media.started.state, 'document-levels.json'), 'utf8'),
    );
    expect(placed.collections.hermetismo[document.id]).toMatchObject({
      level: 'qs',
      setBy: 'ana@example.com',
    });
    await writeConverted(media, { vault, ...document, sha256: PDF_SHA });
    expect((await uploadsOf(ana.call))[0]).toMatchObject({
      state: 'ready',
      document,
    });
  });
});

export type { Media };
