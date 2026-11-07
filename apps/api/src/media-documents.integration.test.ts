import type { KbPublishJob } from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp } from '../test/ai-app-harness.js';
import {
  documentPath,
  documentsWorld,
  jobStatuses,
  onTrack,
  rows,
  runMac,
  vaultText,
  type DocumentsWorld,
} from '../test/documents-world.js';
import {
  forgetDocuments,
  kbResult,
  leaseKb,
  publishedTracks,
  removalsOf,
  writesOf,
} from '../test/kb-publish-harness.js';
import {
  leaseDiarization,
  pairDiarizer,
  requestVoices,
  sendTurns,
  transcribedItem,
} from '../test/diarization-harness.js';
import {
  approve,
  finishCuts,
  libraryEntry,
  say,
  transcribed,
} from '../test/track-items-harness.js';
import { StubLlmAdapter, type StubReply } from './adapters/stub-llm-adapter.js';

afterEach(closeApp);

/** A published recording of `hermetismo`, its two tracks' documents in the vault. */
async function published(docs: DocumentsWorld) {
  const { recording, tracks } = await publishedTracks(docs.world);
  const [first, second] = tracks;
  if (!first || !second) throw new Error('no tracks');
  await runMac(docs);
  return { recording, first, second };
}

const writeFor = (jobs: readonly KbPublishJob[], path: string) =>
  jobs.flatMap(writesOf).find((item) => item.path === path);

const allRemovals = (jobs: readonly KbPublishJob[]) =>
  jobs.flatMap(removalsOf).sort();

const urlOf = (id: string) => `/api/v1/media/${id}`;

describe('Track documents always up to date (KBC-100)', () => {
  it('AC-1: a new title goes out in a write, and after the job find_text finds it, not the old one', async () => {
    const script: StubReply[] = [];
    const llm = new StubLlmAdapter({ script });
    const docs = await documentsWorld({ llm });
    const { world } = docs;
    const { recording, first } = await published(docs);
    const path = documentPath(recording.id, first.id);

    const renamed = await onTrack(world, {
      method: 'PATCH',
      url: urlOf(first.id),
      trackId: first.id,
      payload: { title: 'Pêndulo renomeado' },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    const jobs = await runMac(docs);

    expect(writeFor(jobs, path)?.markdown).toContain('# Pêndulo renomeado');
    expect(jobs.flatMap(writesOf)).toHaveLength(1);
    const text = await vaultText(docs, 'hermetismo', path);
    expect(text).toContain('title: Pêndulo renomeado');
    expect(text).not.toContain('O que é o ritmo?');
    expect(
      world.media.started.catalog.get('hermetismo')?.entries.get(path)?.title,
    ).toBe('Pêndulo renomeado');

    const found = await findText(docs, { llm, script }, 'Pêndulo renomeado');
    expect(found).toContain('Pêndulo renomeado');
    const old = await findText(docs, { llm, script }, 'O que é o ritmo');
    expect(old).not.toContain('faixa de áudio');
  });

  it('AC-2: new bounds give the text of the new interval with its anchors on the new clock', async () => {
    const docs = await documentsWorld();
    const { world } = docs;
    const { recording, first } = await published(docs);

    const moved = await onTrack(world, {
      method: 'PUT',
      url: `${urlOf(first.id)}/bounds`,
      trackId: first.id,
      payload: { startMs: 100_000, endMs: 300_000 },
    });
    expect(moved.statusCode, moved.body).toBe(202);
    await finishCuts(world.media);
    const jobs = await runMac(docs);

    const markdown =
      writeFor(jobs, documentPath(recording.id, first.id))?.markdown ?? '';
    // 113 s in the recording is 13 s on the track's new clock (it was 0:41).
    expect(markdown).toContain(
      '[0:13] O ritmo é a lei do pêndulo que tudo governa',
    );
    expect(markdown).not.toContain('Pergunta sobre o ritmo');
    expect(markdown).not.toContain('[0:41]');
  });

  it('AC-3: a new transcript of the recording regenerates every track', async () => {
    const docs = await documentsWorld();
    const { world } = docs;
    const { recording, first, second } = await published(docs);

    const asked = await world.media.owner(
      'POST',
      `${urlOf(recording.id)}/transcription`,
      {},
    );
    expect(asked.statusCode, asked.body).toBeLessThan(300);
    await say(world, [
      { at: 113, text: 'O ritmo transcrito de novo' },
      { at: 400, text: 'A polaridade transcrita de novo' },
    ]);
    const jobs = await runMac(docs);

    expect(
      writeFor(jobs, documentPath(recording.id, first.id))?.markdown,
    ).toContain('O ritmo transcrito de novo');
    expect(
      writeFor(jobs, documentPath(recording.id, second.id))?.markdown,
    ).toContain('A polaridade transcrita de novo');
    // Each one wanted again is classified again: kb sees a changed body.
    expect(jobs.flatMap(writesOf)).toHaveLength(2);
  });

  it('AC-5: an archived track leaves the vault by a remove; restored, it comes back', async () => {
    const docs = await documentsWorld();
    const { world } = docs;
    const { recording, first } = await published(docs);
    const path = documentPath(recording.id, first.id);
    expect(await vaultText(docs, 'hermetismo', path)).not.toBeNull();

    const archived = await onTrack(world, {
      method: 'DELETE',
      url: urlOf(first.id),
      trackId: first.id,
    });
    expect(archived.statusCode, archived.body).toBeLessThan(300);
    const removing = await runMac(docs);
    expect(allRemovals(removing)).toEqual([path]);
    expect(await vaultText(docs, 'hermetismo', path)).toBeNull();
    expect(
      world.media.started.catalog.get('hermetismo')?.entries.has(path),
    ).toBe(false);
    expect(rows(world, 'SELECT * FROM media_document_removals').length).toBe(0);

    const restored = await world.media.owner(
      'POST',
      `${urlOf(first.id)}/restore`,
    );
    expect(restored.statusCode, restored.body).toBe(200);
    const writing = await runMac(docs);
    expect(writeFor(writing, path)).toBeDefined();
    expect(await vaultText(docs, 'hermetismo', path)).toContain(
      '# O que é o ritmo?',
    );
  });

  it('AC-6: a recording moved to another collection leaves the old folder and enters the new one', async () => {
    const docs = await documentsWorld();
    const { world } = docs;
    const { recording, first, second } = await published(docs);
    const paths = [first, second].map((one) =>
      documentPath(recording.id, one.id),
    );

    const moved = await world.media.owner('PATCH', urlOf(recording.id), {
      topic: 'udv',
      author: null,
    });
    expect(moved.statusCode, moved.body).toBe(200);
    const jobs = await runMac(docs);

    const byTopic = (topic: string) =>
      jobs.filter((job) => job.topic === topic);
    expect(allRemovals(byTopic('hermetismo'))).toEqual([...paths].sort());
    expect(
      byTopic('udv')
        .flatMap(writesOf)
        .map((item) => item.path)
        .sort(),
    ).toEqual([...paths].sort());
    for (const path of paths) {
      expect(await vaultText(docs, 'hermetismo', path)).toBeNull();
      expect(await vaultText(docs, 'udv', path)).toContain(
        'source_path: media/udv/',
      );
      expect(
        world.media.started.catalog.get('hermetismo')?.entries.has(path),
      ).toBe(false);
      expect(world.media.started.catalog.get('udv')?.entries.has(path)).toBe(
        true,
      );
    }
  });

  it('AC-8: the backfill gives a transcribed recording without tracks its document', async () => {
    const docs = await documentsWorld({
      env: { KB_CHAT_RECONCILE_MS: '50' },
    });
    const { world } = docs;
    const recording = await transcribed(
      world,
      [{ at: 30, text: 'Uma palestra inteira sem faixas' }],
      { title: 'Palestra sem faixas' },
    );
    // As a database from before KBC-100: the recording has no document yet.
    forgetDocuments(world.media);

    await expect
      .poll(() => jobStatuses(world), { timeout: 5_000 })
      .toEqual(['hermetismo:queued']);
    const job = await leaseKb(world.media, docs.mac.token);
    const [item] = writesOf(job);
    expect(item?.path).toBe(documentPath(recording.id, recording.id));
    expect(item?.markdown).toContain('kb_chat_media_kind: recording');
    expect(item?.markdown).toContain('[0:30] Uma palestra inteira sem faixas');
  });

  it('AC-8: a recording that gets tracks gives its whole document up for the tracks', async () => {
    const docs = await documentsWorld();
    const { world } = docs;
    const recording = await transcribed(world, [
      { at: 113, text: 'O ritmo é a lei do pêndulo que tudo governa' },
    ]);
    const whole = documentPath(recording.id, recording.id);
    await runMac(docs);
    expect(await vaultText(docs, 'hermetismo', whole)).toContain(
      'kb_chat_media_kind: recording',
    );

    const { approve } = await import('../test/track-items-harness.js');
    await approve(world.media, recording.id, [
      { startMs: 72_000, endMs: 300_000, title: 'O que é o ritmo?' },
    ]);
    await finishCuts(world.media);
    const jobs = await runMac(docs);

    expect(allRemovals(jobs)).toEqual([whole]);
    expect(jobs.flatMap(writesOf)).toHaveLength(1);
    expect(await vaultText(docs, 'hermetismo', whole)).toBeNull();
  });

  it('AC-9: ten changes in a minute leave at most one job running and one queued; the last state wins', async () => {
    const docs = await documentsWorld();
    const { world, mac } = docs;
    const { recording, first } = await published(docs);
    const rename = (title: string) =>
      onTrack(world, {
        method: 'PATCH',
        url: urlOf(first.id),
        trackId: first.id,
        payload: { title },
      });

    await rename('Título 1');
    const running = await leaseKb(world.media, mac.token);
    for (let n = 2; n <= 10; n += 1) await rename(`Título ${n}`);
    expect(jobStatuses(world)).toEqual([
      'hermetismo:leased',
      'hermetismo:queued',
    ]);

    const done = await kbResult(world.media, {
      token: mac.token,
      job: running,
    });
    expect(done.statusCode).toBe(204);
    const jobs = await runMac(docs);
    expect(jobs).toHaveLength(1);
    expect(
      writeFor(jobs, documentPath(recording.id, first.id))?.markdown,
    ).toContain('# Título 10');
    expect(
      await vaultText(docs, 'hermetismo', documentPath(recording.id, first.id)),
    ).toContain('title: Título 10');
  });

  it('FR-1: accepted subjects of a track go into its document', async () => {
    const docs = await documentsWorld();
    const { world } = docs;
    const { recording, first } = await published(docs);
    const created = await world.media.owner(
      'POST',
      '/api/v1/topics/hermetismo/subjects',
      { name: 'Lei do ritmo' },
    );
    expect(created.statusCode, created.body).toBeLessThan(300);
    const subject = created.json<{ id: string }>();
    const subjects = await world.media.owner(
      'GET',
      `${urlOf(first.id)}/subjects`,
    );
    expect(subjects.statusCode, subjects.body).toBe(200);
    const saved = await world.media.started.app.inject({
      method: 'PUT',
      url: `${urlOf(first.id)}/subjects`,
      headers: {
        ...world.media.ownerHeaders,
        'if-match': `"${subjects.json<{ version: number }>().version}"`,
      },
      payload: { subjects: [{ kind: 'free', id: subject.id }], summary: null },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const jobs = await runMac(docs);

    expect(
      writeFor(jobs, documentPath(recording.id, first.id))?.markdown,
    ).toContain('- Lei do ritmo');
  });

  it('BR-2: deleting a recording removes its documents', async () => {
    const docs = await documentsWorld();
    const { world } = docs;
    const { recording, first, second } = await published(docs);

    const removed = await world.media.owner(
      'DELETE',
      `${urlOf(recording.id)}?cascade=true`,
    );
    expect(removed.statusCode, removed.body).toBeLessThan(300);
    const jobs = await runMac(docs);

    expect(allRemovals(jobs)).toEqual(
      [first, second].map((one) => documentPath(recording.id, one.id)).sort(),
    );
  });
});

describe('A change to a whole collection rewrites its tracks right away (KBC-100 FR-1, BR-4)', () => {
  it("the collection's main author: every track of a recording by that author gets the main author's group", async () => {
    const docs = await documentsWorld();
    const { world } = docs;
    const { recording, first, second } = await published(docs);
    const added = await world.media.owner(
      'POST',
      '/api/v1/topics/hermetismo/authors',
      { name: 'Autora Convidada' },
    );
    expect(added.statusCode, added.body).toBe(201);
    const { slug } = added.json<{ slug: string }>();
    const byHer = await world.media.owner('PATCH', urlOf(recording.id), {
      author: slug,
    });
    expect(byHer.statusCode, byHer.body).toBe(200);
    await runMac(docs);

    const main = await world.media.owner('PATCH', '/api/v1/topics/hermetismo', {
      mainAuthor: slug,
    });
    expect(main.statusCode, main.body).toBe(200);
    // No sweep runs here (10 min): the job is queued by the change itself.
    expect(jobStatuses(world)).toEqual(['hermetismo:queued']);
    const jobs = await runMac(docs);

    const paths = [first, second].map((one) =>
      documentPath(recording.id, one.id),
    );
    expect(
      jobs
        .flatMap(writesOf)
        .map((one) => one.path)
        .sort(),
    ).toEqual([...paths].sort());
    for (const path of paths)
      expect(await vaultText(docs, 'hermetismo', path)).toContain(
        'author_group: mestre-laercio',
      );
  });

  it('a collection speaker renamed: every track where that speaker talks names them anew', async () => {
    const docs = await documentsWorld();
    const { world } = docs;
    const { media } = world;
    const { token } = await pairDiarizer(media);
    const recordingId = await transcribedItem(media, token);
    expect((await requestVoices(media, recordingId)).statusCode).toBe(202);
    const diarize = await leaseDiarization(media, token);
    expect((await sendTurns(media, { token, job: diarize })).statusCode).toBe(
      204,
    );
    await approve(media, recordingId, [
      { startMs: 0, endMs: 22_000, title: 'Faixa um' },
      { startMs: 22_000, endMs: 60_000, title: 'Faixa dois' },
    ]);
    await finishCuts(media);
    const tracks = (await libraryEntry(media.owner, recordingId))?.tracks ?? [];
    expect(tracks).toHaveLength(2);
    const created = await media.owner(
      'POST',
      '/api/v1/topics/hermetismo/speakers',
      { name: 'José' },
    );
    expect(created.statusCode, created.body).toBe(201);
    const speaker = created.json<{ id: string }>();
    const named = await media.owner(
      'PUT',
      `/api/v1/media/${recordingId}/voices/2`,
      { version: 1, speakerId: speaker.id, audience: false },
    );
    expect(named.statusCode, named.body).toBe(200);
    await runMac(docs);

    const renamed = await media.owner(
      'PATCH',
      `/api/v1/topics/hermetismo/speakers/${speaker.id}`,
      { name: 'Josué' },
    );
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(jobStatuses(world)).toEqual(['hermetismo:queued']);
    const jobs = await runMac(docs);

    const written = jobs.flatMap(writesOf);
    expect(written.map((one) => one.path).sort()).toEqual(
      tracks.map((one) => documentPath(recordingId, one.id)).sort(),
    );
    for (const one of written) {
      expect(one.markdown).toContain('**Josué:**');
      expect(one.markdown).not.toContain('**José:**');
    }
  });
});

const call = (name: string, args: Record<string, unknown>): StubReply => ({
  toolCalls: [{ name, arguments: args }],
});

/** What find_text tells the model for a phrase, in one research turn of the owner. */
async function findText(
  docs: DocumentsWorld,
  { llm, script }: { llm: StubLlmAdapter; script: StubReply[] },
  phrase: string,
): Promise<string> {
  script.splice(
    0,
    script.length,
    call('find_text', { phrase, output_mode: 'content' }),
    { text: 'ok' },
  );
  const asked = await docs.world.media.owner(
    'POST',
    '/api/v1/topics/hermetismo/research',
    { question: `Onde se fala de ${phrase}?`, profile: 'fast' },
  );
  expect(asked.statusCode, asked.body).toBe(200);
  return (llm.messagesSeen.at(-1) ?? [])
    .filter((message) => message.role === 'tool')
    .map((message) => message.content)
    .join('\n');
}
