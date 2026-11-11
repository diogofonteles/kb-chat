/**
 * Word corrections (KBC-093, ADR 0034): one word or a few, through the real routes and the
 * real media database, with what follows them (search, subtitles, tracks, documents).
 */
import type {
  MediaTranscriptWords,
  TranscriptCorrectionResult,
} from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL, closeApp } from '../test/ai-app-harness.js';
import {
  correctionsUrl,
  dbExec,
  fix,
  historyOf,
  publishedRecording,
  snapshot,
  spokenHits,
  textOf,
  transcriptOf,
  transcriptUrl,
  wordOf,
  wordsOf,
} from '../test/correction-harness.js';
import {
  documentPath,
  documentsWorld,
  runMac,
} from '../test/documents-world.js';
import { writesOf } from '../test/kb-publish-harness.js';
import { member } from '../test/media-harness.js';
import {
  leaseDiarization,
  pairDiarizer,
  requestVoices,
  sendTurns,
  transcribedItem,
} from '../test/diarization-harness.js';
import { say, startWorld, transcribed } from '../test/track-items-harness.js';

afterEach(closeApp);

const CORRECTOR = ['media', 'media-tracks', 'search', 'media-correct'];

describe('Transcript word corrections (KBC-093)', () => {
  it('AC-1, FR-5, FR-7, BR-4: a word changes in place, with its times, at a new revision of the same version', async () => {
    const world = await startWorld();
    const { owner } = world.media;
    const recording = await transcribed(world, [
      { at: 10, text: 'O mestre Tiuako disse assim' },
    ]);
    const before = await wordOf(owner, recording.id, 'Tiuako');

    const saved = await fix(owner, recording.id, {
      from: 'Tiuako',
      to: 'Tiuaco',
    });

    expect(saved.statusCode, saved.body).toBe(201);
    const body = saved.json<TranscriptCorrectionResult>();
    expect(body).toMatchObject({
      version: 1,
      revision: 1,
      segments: [{ index: 0, text: 'O mestre Tiuaco disse assim' }],
      correction: {
        kind: 'correct',
        state: 'active',
        before: ['Tiuako'],
        after: 'Tiuaco',
        position: before.position,
        startMs: before.startMs,
        endMs: before.endMs,
        mine: true,
        canUndo: true,
      },
    });
    const transcript = await transcriptOf(owner, recording.id);
    expect(transcript).toMatchObject({ version: 1, revision: 1 });
    expect(transcript.segments[0]?.text).toBe('O mestre Tiuaco disse assim');
    const after = await wordOf(owner, recording.id, 'Tiuaco');
    expect(after).toMatchObject({
      position: before.position,
      startMs: before.startMs,
      endMs: before.endMs,
    });
    expect((await wordsOf(owner, recording.id)).revision).toBe(1);
  });

  it('AC-2, AC-21, BR-10, KBC-100 AC-4: search finds the new word in the recording and the one track holding it, whose document alone is written again', async () => {
    const docs = await documentsWorld();
    const { world } = docs;
    const { owner } = world.media;
    const { recording, tracks } = await publishedRecording(world);
    const [first, second, third] = tracks;
    if (!first || !second || !third) throw new Error('three tracks');
    await runMac(docs);
    const versionOf = async (id: string) =>
      (await transcriptOf(owner, id)).version;
    const secondBefore = await versionOf(second.id);
    const thirdBefore = await versionOf(third.id);

    expect(
      (await fix(owner, recording.id, { from: 'Tiuako', to: 'Tiuaco' }))
        .statusCode,
    ).toBe(201);

    const jobs = await runMac(docs);
    expect(jobs.flatMap(writesOf).map((write) => write.path)).toEqual([
      documentPath(recording.id, first.id),
    ]);
    expect(jobs.flatMap(writesOf)[0]?.markdown).toContain('Tiuaco');
    expect(await textOf(owner, first.id)).toEqual([
      'O mestre Tiuaco disse assim',
    ]);
    expect(await versionOf(second.id)).toBe(secondBefore);
    expect(await versionOf(third.id)).toBe(thirdBefore);
    // A word inside a track is found in the track (KBC-068 FR-5), at its own minute.
    const found = await spokenHits(owner, 'tiuaco');
    expect(found).toEqual([
      expect.objectContaining({ mediaId: first.id, startMs: 10_000 }),
    ]);
    const old = await spokenHits(owner, 'tiuako');
    // The other "tiuako," is still said, in the third track only.
    expect(old.map((hit) => hit.mediaId)).toEqual([third.id]);
  });

  it('AC-3, FR-7: the subtitles get a new ETag, and the old one reads the new text', async () => {
    const world = await startWorld();
    const { owner, started, ownerHeaders } = world.media;
    const recording = await transcribed(world, [
      { at: 10, text: 'O mestre Tiuako disse assim' },
    ]);
    const url = `/api/v1/media/${recording.id}/subtitles.vtt`;
    const first = await owner('GET', url);
    const etag = String(first.headers.etag);
    expect(etag).toMatch(/\.r0\./);

    await fix(owner, recording.id, { from: 'Tiuako', to: 'Tiuaco' });

    const again = await started.app.inject({
      method: 'GET',
      url,
      headers: { ...ownerHeaders, 'if-none-match': etag },
    });
    expect(again.statusCode).toBe(200);
    expect(again.headers.etag).not.toBe(etag);
    expect(again.headers.etag).toMatch(/\.r1\./);
    expect(again.body).toContain('Tiuaco');
    expect(again.body).not.toContain('Tiuako');
  });

  it('AC-4, AC-5, BR-1: two words become one text and one word two, and search finds "certeza"', async () => {
    const world = await startWorld();
    const { owner } = world.media;
    const recording = await transcribed(world, [
      { at: 100, text: 'foi con certeza e falou' },
      { at: 200, text: 'veio concerteza a Hoasca' },
    ]);
    const con = await wordOf(owner, recording.id, 'con');

    const joined = await owner('POST', correctionsUrl(recording.id), {
      version: 1,
      position: con.position,
      count: 2,
      expected: ['con', 'certeza'],
      text: 'com certeza',
    });
    expect(joined.statusCode, joined.body).toBe(201);
    expect(
      (
        await fix(owner, recording.id, {
          from: 'concerteza',
          to: 'com certeza',
        })
      ).statusCode,
    ).toBe(201);

    expect(await textOf(owner, recording.id)).toEqual([
      'foi com certeza e falou',
      'veio com certeza a Hoasca',
    ]);
    const { words } = await wordsOf(owner, recording.id);
    expect(
      words
        .filter((word) => word.segment === 0)
        .map(({ text, startMs }) => [text, startMs]),
    ).toEqual([
      ['foi', 100_000],
      ['com certeza', 100_400],
      ['', 100_800],
      ['e', 101_200],
      ['falou', 101_600],
    ]);
    const hits = await spokenHits(owner, 'certeza');
    expect(hits.map((hit) => hit.startMs).sort()).toEqual([100_000, 200_000]);
  });

  it('AC-6, AC-7, AC-8, BR-1, BR-3: refuses across segments, over five words or a bad text, keeps the typed case and punctuation, writes nothing for the same text', async () => {
    const world = await startWorld();
    const { owner } = world.media;
    const recording = await transcribed(world, [
      { at: 10, text: 'O mestre tiuaco, disse' },
      { at: 100, text: 'um dois três quatro cinco seis' },
    ]);
    const url = correctionsUrl(recording.id);
    const disse = await wordOf(owner, recording.id, 'disse');
    const across = await owner('POST', url, {
      version: 1,
      position: disse.position,
      count: 2,
      expected: ['disse', 'um'],
      text: 'x',
    });
    expect(across.statusCode).toBe(409);
    expect(across.json()).toMatchObject({
      error: {
        code: 'CORRECTION_CONFLICT',
        details: { reason: 'not-contiguous' },
      },
    });
    const um = await wordOf(owner, recording.id, 'um');
    const six = await owner('POST', url, {
      version: 1,
      position: um.position,
      count: 6,
      expected: ['um', 'dois', 'três', 'quatro', 'cinco', 'seis'],
      text: 'x',
    });
    expect(six.json()).toMatchObject({
      error: { details: { reason: 'not-contiguous' } },
    });
    for (const text of ['x'.repeat(81), 'linha\noutra']) {
      const refused = await fix(owner, recording.id, {
        from: 'tiuaco,',
        to: text,
      });
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({
        error: { code: 'CORRECTION_INVALID' },
      });
    }

    const same = await fix(owner, recording.id, {
      from: 'tiuaco,',
      to: ' tiuaco, ',
    });
    expect(same.statusCode).toBe(200);
    expect(same.json()).toMatchObject({ correction: null, revision: 0 });
    expect(
      (await fix(owner, recording.id, { from: 'tiuaco,', to: 'Tiuaco,' }))
        .statusCode,
    ).toBe(201);
    expect((await textOf(owner, recording.id))[0]).toBe(
      'O mestre Tiuaco, disse',
    );
    expect(
      (
        await fix(owner, recording.id, { from: 'Tiuaco,', to: '  Tiuaco  ,' })
      ).json(),
    ).toMatchObject({ correction: { after: 'Tiuaco ,' } });
    expect((await textOf(owner, recording.id))[0]).toBe(
      'O mestre Tiuaco , disse',
    );
  });

  it('AC-9, AC-10, BR-2, BR-7: a removed word leaves the text, search and subtitles, and undo brings it back with two rows in the history', async () => {
    const world = await startWorld();
    const { owner } = world.media;
    const recording = await transcribed(world, [
      { at: 10, text: 'O mestre Tiuako disse assim' },
    ]);
    const vtt = async () =>
      (await owner('GET', `/api/v1/media/${recording.id}/subtitles.vtt`)).body;

    const removed = await fix(owner, recording.id, { from: 'Tiuako', to: '' });
    expect(removed.statusCode).toBe(201);
    expect(await textOf(owner, recording.id)).toEqual(['O mestre disse assim']);
    expect(await spokenHits(owner, 'tiuako')).toEqual([]);
    expect(await vtt()).not.toContain('Tiuako');

    const id = removed.json<TranscriptCorrectionResult>().correction?.id;
    const undone = await owner(
      'POST',
      `${correctionsUrl(recording.id)}/${id}/undo`,
    );
    expect(undone.statusCode, undone.body).toBe(201);
    expect(undone.json()).toMatchObject({
      revision: 2,
      correction: {
        kind: 'undo',
        reverts: id,
        after: 'Tiuako',
        canUndo: false,
      },
    });
    expect(await textOf(owner, recording.id)).toEqual([
      'O mestre Tiuako disse assim',
    ]);
    expect(await spokenHits(owner, 'tiuako')).toHaveLength(1);
    expect(await vtt()).toContain('Tiuako');
    const history = await historyOf(owner, recording.id);
    expect(history.total).toBe(2);
    expect(
      history.entries.map((entry) => [
        entry.items[0]?.kind,
        entry.items[0]?.state,
      ]),
    ).toEqual([
      ['undo', 'active'],
      ['correct', 'undone'],
    ]);
    // Undoing again writes nothing.
    const twice = await owner(
      'POST',
      `${correctionsUrl(recording.id)}/${id}/undo`,
    );
    expect(twice.statusCode).toBe(200);
  });

  it('AC-11 to AC-14, BR-6, BR-7: stale words are refused with who changed them, other words still save, a retry writes once, an undo after a change is refused', async () => {
    const world = await startWorld();
    const { media } = world;
    const recording = await transcribed(world, [
      { at: 10, text: 'O mestre Tiuako disse assim' },
    ]);
    const maria = await member(media, {
      email: 'maria@example.com',
      topics: ['hermetismo'],
      features: CORRECTOR,
    });
    const tiuako = await wordOf(media.owner, recording.id, 'Tiuako');
    const assim = await wordOf(media.owner, recording.id, 'assim');
    const url = correctionsUrl(recording.id);
    const byMaria = {
      version: 1,
      position: tiuako.position,
      count: 1,
      expected: ['Tiuako'],
      text: 'Tiuaco',
    };

    const first = await maria.call('POST', url, byMaria);
    expect(first.statusCode).toBe(201);
    const retry = await maria.call('POST', url, byMaria);
    expect(retry.statusCode).toBe(200);
    const stale = await media.owner('POST', url, {
      ...byMaria,
      text: 'Tiuacô',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: {
        details: {
          reason: 'word-changed',
          current: ['Tiuaco'],
          authorName: expect.any(String),
        },
      },
    });
    const other = await media.owner('POST', url, {
      version: 1,
      position: assim.position,
      count: 1,
      expected: ['assim'],
      text: 'assim.',
    });
    expect(other.statusCode).toBe(201);
    expect(await textOf(media.owner, recording.id)).toEqual([
      'O mestre Tiuaco disse assim.',
    ]);
    const mine = await media.owner('POST', url, {
      ...byMaria,
      expected: ['Tiuaco'],
      text: 'Tiuacu',
    });
    expect(mine.statusCode).toBe(201);
    const history = await historyOf(maria.call, recording.id);
    expect(history.total).toBe(3);
    const mariaRow = history.entries.at(-1)?.items[0];
    const undo = await maria.call('POST', `${url}/${mariaRow?.id}/undo`);
    expect(undo.statusCode).toBe(409);
    expect(undo.json()).toMatchObject({
      error: { details: { reason: 'changed-since', current: ['Tiuacu'] } },
    });
  });

  it('AC-15, AC-19, FR-8, BR-9, NFR-3: a new version refuses a stale correction and carries the others by time and text', async () => {
    const world = await startWorld();
    const { owner } = world.media;
    const recording = await transcribed(world, [
      { at: 10, text: 'O mestre Tiuako disse' },
      { at: 100, text: 'o vegetal Mariri falou' },
    ]);
    expect(
      (await fix(owner, recording.id, { from: 'Tiuako', to: 'Tiuaco' }))
        .statusCode,
    ).toBe(201);
    expect(
      (await fix(owner, recording.id, { from: 'Mariri', to: 'Mariri,' }))
        .statusCode,
    ).toBe(201);
    const disse = await wordOf(owner, recording.id, 'disse');

    const asked = await owner(
      'POST',
      `/api/v1/media/${recording.id}/transcription`,
      {},
    );
    expect(asked.statusCode, asked.body).toBeLessThan(300);
    await say(world, [
      { at: 10, text: 'O mestre tiuako disse' },
      { at: 100, text: 'o vegetal Mareri falou' },
    ]);

    const late = await owner('POST', correctionsUrl(recording.id), {
      version: 1,
      position: disse.position,
      count: 1,
      expected: ['disse'],
      text: 'falou',
    });
    expect(late.statusCode).toBe(412);
    expect(late.json()).toMatchObject({
      error: { code: 'TRANSCRIPT_CHANGED' },
    });
    const transcript = await transcriptOf(owner, recording.id);
    expect(transcript).toMatchObject({ version: 2, revision: 1 });
    expect(transcript.segments.map((one) => one.text)).toEqual([
      'O mestre Tiuaco disse',
      'o vegetal Mareri falou',
    ]);
    const history = await historyOf(owner, recording.id);
    expect(history.carry).toEqual({ version: 2, carried: 1, notCarried: 1 });
    const states = history.entries.flatMap((entry) => entry.items);
    expect(
      states.filter((row) => row.state === 'active' && row.kind === 'correct'),
    ).toEqual([]);
    expect(states.find((row) => row.state === 'not-carried')).toMatchObject({
      before: ['Mariri'],
      after: 'Mariri,',
      found: 'Mareri',
    });
    expect(states.find((row) => row.kind === 'carried')).toMatchObject({
      version: 2,
      state: 'active',
      before: ['tiuako'],
      after: 'Tiuaco',
    });
  });

  it('NFR-3, ADR 0034 §6: a correction that no longer fits its segment is kept not carried, and the new version is saved', async () => {
    const world = await startWorld();
    const { owner } = world.media;
    const speech = [
      { at: 10, text: 'O mestre Tiuako disse' },
      { at: 100, text: 'o vegetal Mariri falou' },
    ];
    const recording = await transcribed(world, speech);
    expect(
      (await fix(owner, recording.id, { from: 'Tiuako', to: 'Tiuaco' }))
        .statusCode,
    ).toBe(201);
    expect(
      (await fix(owner, recording.id, { from: 'Mariri', to: 'Mariri,' }))
        .statusCode,
    ).toBe(201);
    // The new version's first segment says something its words do not: it cannot be rewritten.
    dbExec(
      world.media,
      `CREATE TRIGGER misalign AFTER INSERT ON segments
       WHEN NEW.text LIKE '%Tiuako%'
       BEGIN UPDATE segments SET text = 'outra coisa' WHERE rowid = NEW.rowid; END`,
    );

    await owner('POST', `/api/v1/media/${recording.id}/transcription`, {});
    await say(world, speech);

    const transcript = await transcriptOf(owner, recording.id);
    expect(transcript).toMatchObject({ version: 2, revision: 1 });
    expect(transcript.segments.map((one) => one.text)).toEqual([
      'outra coisa',
      'o vegetal Mariri, falou',
    ]);
    const history = await historyOf(owner, recording.id);
    expect(history.carry).toEqual({ version: 2, carried: 1, notCarried: 1 });
    const items = history.entries.flatMap((entry) => entry.items);
    expect(items.find((row) => row.state === 'not-carried')).toMatchObject({
      before: ['Tiuako'],
      after: 'Tiuaco',
      found: 'Tiuako',
    });
  });

  it('AC-16, AC-17, AC-18, BR-5, PD-06, PD-07: who may correct, read the log and undo', async () => {
    const world = await startWorld();
    const { media } = world;
    const { recording, tracks } = await publishedRecording(world);
    const url = correctionsUrl(recording.id);
    const listener = await member(media, {
      email: 'ouvinte@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-tracks', 'media-edit'],
    });
    const outsider = await member(media, {
      email: 'fora@example.com',
      topics: [],
      features: CORRECTOR,
    });
    const maria = await member(media, {
      email: 'maria@example.com',
      topics: ['hermetismo'],
      features: CORRECTOR,
    });
    const tiuako = await wordOf(media.owner, recording.id, 'Tiuako');
    const body = {
      version: 1,
      position: tiuako.position,
      count: 1,
      expected: ['Tiuako'],
      text: 'Tiuaco',
    };
    const anonymous = await media.started.app.inject({
      method: 'POST',
      url,
      payload: body,
      headers: LOCAL,
    });
    expect(anonymous.statusCode).toBe(401);
    expect((await listener.call('POST', url, body)).statusCode).toBe(403);
    expect((await listener.call('GET', url)).statusCode).toBe(403);
    expect(
      (
        await listener.call(
          'GET',
          `${transcriptUrl(recording.id)}/occurrences?text=x`,
        )
      ).statusCode,
    ).toBe(403);
    const hidden = await outsider.call('POST', url, body);
    const unknown = await outsider.call(
      'POST',
      correctionsUrl('00000000-0000-4000-8000-000000000000'),
      body,
    );
    expect([hidden.statusCode, unknown.statusCode]).toEqual([404, 404]);
    expect(hidden.json().error.code).toBe(unknown.json().error.code);
    const track = tracks[0];
    const onTrack = await media.owner(
      'POST',
      correctionsUrl(track?.id ?? ''),
      body,
    );
    expect(onTrack.statusCode).toBe(409);
    expect(onTrack.json()).toMatchObject({
      error: { details: { reason: 'track-derived' } },
    });

    const byOwner = await media.owner('POST', url, body);
    const ownerRow = byOwner.json<TranscriptCorrectionResult>().correction;
    const assim = await wordOf(media.owner, recording.id, 'assim');
    const byMaria = await maria.call('POST', url, {
      ...body,
      position: assim.position,
      expected: ['assim'],
      text: 'assim.',
    });
    const mariaRow = byMaria.json<TranscriptCorrectionResult>().correction;
    const seenByMaria = await historyOf(maria.call, recording.id);
    expect(
      seenByMaria.entries.map(({ items }) => [
        items[0]?.after,
        items[0]?.canUndo,
      ]),
    ).toEqual([
      ['assim.', true],
      ['Tiuaco', false],
    ]);
    expect(
      (await maria.call('POST', `${url}/${ownerRow?.id}/undo`)).statusCode,
    ).toBe(403);
    expect(
      (await media.owner('POST', `${url}/${mariaRow?.id}/undo`)).statusCode,
    ).toBe(201);
    expect(
      (
        await media.owner(
          'POST',
          `${url}/00000000-0000-4000-8000-000000000000/undo`,
        )
      ).statusCode,
    ).toBe(404);
  });

  it('AC-20, BR-4: the version, the voices and the edit stay as they were', async () => {
    const world = await startWorld();
    const { media } = world;
    const { token } = await pairDiarizer(media);
    const recordingId = await transcribedItem(media, token);
    expect((await requestVoices(media, recordingId)).statusCode).toBe(202);
    const diarize = await leaseDiarization(media, token);
    expect((await sendTurns(media, { token, job: diarize })).statusCode).toBe(
      204,
    );
    const before = await transcriptOf(media.owner, recordingId);
    const edit = await media.owner('GET', `/api/v1/media/${recordingId}/edit`);
    const editBefore = edit.json<{
      version: number;
      transcriptChanged: boolean;
    }>();
    const { words } = await wordsOf(media.owner, recordingId);
    const target = words.find((word) => word.text === 'lembrado');
    if (target?.position === undefined) throw new Error('no word');

    const saved = await media.owner('POST', correctionsUrl(recordingId), {
      version: before.version,
      position: target.position,
      count: 1,
      expected: ['lembrado'],
      text: 'lembrando',
    });
    expect(saved.statusCode, saved.body).toBe(201);

    const after = await transcriptOf(media.owner, recordingId);
    expect(after.version).toBe(before.version);
    expect(after.speakers).toEqual(before.speakers);
    expect(after.segments.map((one) => one.voice)).toEqual(
      before.segments.map((one) => one.voice),
    );
    const editAfter = (
      await media.owner('GET', `/api/v1/media/${recordingId}/edit`)
    ).json<{ version: number; transcriptChanged: boolean }>();
    expect(editAfter.version).toBe(editBefore.version);
    expect(editAfter.transcriptChanged).toBe(false);
  });

  it('AC-26, NFR-2: a failure in the middle changes nothing (text, index, revision, tracks, log, documents)', async () => {
    const docs = await documentsWorld();
    const { world } = docs;
    const { owner } = world.media;
    const { recording } = await publishedRecording(world);
    await runMac(docs);
    const before = snapshot(world.media, recording.id);
    dbExec(
      world.media,
      `CREATE TRIGGER fail_correction BEFORE INSERT ON transcript_corrections
       BEGIN SELECT RAISE(ABORT, 'injected'); END`,
    );

    const failed = await fix(owner, recording.id, {
      from: 'Tiuako',
      to: 'Tiuaco',
    });

    expect(failed.statusCode).toBe(500);
    expect(snapshot(world.media, recording.id)).toEqual(before);
    expect(await spokenHits(owner, 'tiuaco')).toEqual([]);
  });

  it('FR-7: the words say their position and the revision, page by page', async () => {
    const world = await startWorld();
    const { owner } = world.media;
    const recording = await transcribed(world, [
      { at: 10, text: 'um dois' },
      { at: 20, text: 'três' },
    ]);
    const read = await owner(
      'GET',
      `${transcriptUrl(recording.id)}/words?from=1&count=1`,
    );
    expect(read.json<MediaTranscriptWords>()).toMatchObject({
      revision: 0,
      words: [{ position: 2, segment: 1, text: 'três' }],
    });
  });
});
