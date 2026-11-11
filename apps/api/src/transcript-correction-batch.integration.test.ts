/**
 * "Corrigir todas" (KBC-093 BR-11 to BR-16, ADR 0034 amendment 8): the preview, the group in
 * one transaction, its history and undo, and what a new version does with it.
 */
import { randomUUID } from 'node:crypto';
import type {
  CorrectionGroupUndoResult,
  Occurrences,
  TranscriptCorrectionBatchResult,
} from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp } from '../test/ai-app-harness.js';
import {
  correctionsUrl,
  dbExec,
  dbRows,
  historyOf,
  publishedRecording,
  snapshot,
  spokenHits,
  textOf,
  transcriptUrl,
} from '../test/correction-harness.js';
import {
  documentPath,
  documentsWorld,
  runMac,
} from '../test/documents-world.js';
import { writesOf } from '../test/kb-publish-harness.js';
import { member } from '../test/media-harness.js';
import {
  say,
  startWorld,
  transcribed,
  type Spoken,
  type World,
} from '../test/track-items-harness.js';
import type { Call } from '../test/ai-app-harness.js';

afterEach(closeApp);

const CORRECTOR = ['media', 'media-tracks', 'search', 'media-correct'];

/** "Tiuako" said 12 times: 3 in the second track (60 to 240 s), 9 elsewhere. */
const TWELVE: readonly Spoken[] = [
  { at: 10, text: 'Tiuako, abre a sessão' },
  { at: 20, text: 'e tiuako. responde' },
  { at: 30, text: 'depois Tiuako fala' },
  { at: 100, text: 'o Tiuako chegou' },
  { at: 150, text: 'com Tiuako na mesa' },
  { at: 200, text: 'disse Tiuako' },
  { at: 250, text: 'Tiuako no intervalo' },
  { at: 270, text: 'ainda Tiuako aqui' },
  { at: 310, text: 'Tiuako na terceira' },
  { at: 320, text: 'outra vez Tiuako' },
  { at: 330, text: 'mais Tiuako' },
  { at: 340, text: 'fim do Tiuako' },
];

const SECOND_TRACK = { fromMs: 60_000, toMs: 240_000 };

async function previewOf(
  call: Call,
  id: string,
  query: Record<string, string | number>,
): Promise<Occurrences> {
  const params = new URLSearchParams(
    Object.entries(query).map(([key, value]): [string, string] => [
      key,
      String(value),
    ]),
  );
  const read = await call('GET', `${transcriptUrl(id)}/occurrences?${params}`);
  expect(read.statusCode, read.body).toBe(200);
  return read.json<Occurrences>();
}

const itemsOf = (preview: Occurrences) =>
  preview.occurrences.map(({ position, count, expected }) => ({
    position,
    count,
    expected,
  }));

const batch = (
  call: Call,
  id: string,
  body: { items: object[]; text?: string; key?: string; version?: number },
) =>
  call('POST', `${correctionsUrl(id)}/batch`, {
    version: body.version ?? 1,
    key: body.key ?? randomUUID(),
    text: body.text ?? 'Tiuaco',
    items: body.items,
  });

async function twelve(world: World) {
  return publishedRecording(world, TWELVE);
}

describe('Corrigir todas (KBC-093)', () => {
  it('AC-28, AC-37, BR-15, KBC-100: the twelve change in one revision, keep their punctuation, search finds them and each touched track is cut and written once', async () => {
    const docs = await documentsWorld();
    const { world } = docs;
    const { owner } = world.media;
    const { recording, tracks } = await twelve(world);
    await runMac(docs);
    const cutsBefore = dbRows(
      world.media,
      'SELECT count(*) AS n FROM transcripts',
    );
    const preview = await previewOf(owner, recording.id, {
      text: 'tiuako',
      ...SECOND_TRACK,
    });
    expect(preview).toMatchObject({ total: 12, inWindow: 3, revision: 0 });
    expect(preview.occurrences[0]).toMatchObject({
      text: 'Tiuako,',
      contextBefore: '',
      contextAfter: 'abre a sessão',
      startMs: 10_000,
      inWindow: false,
    });

    const saved = await batch(owner, recording.id, { items: itemsOf(preview) });

    expect(saved.statusCode, saved.body).toBe(201);
    expect(saved.json<TranscriptCorrectionBatchResult>()).toMatchObject({
      count: 12,
      revision: 1,
    });
    const text = await textOf(owner, recording.id);
    expect(text.slice(0, 2)).toEqual([
      'Tiuaco, abre a sessão',
      'e Tiuaco. responde',
    ]);
    expect(text.join(' ')).not.toMatch(/tiuako/i);
    expect(await spokenHits(owner, 'tiuako')).toEqual([]);
    expect(
      (await spokenHits(owner, 'tiuaco')).map((hit) => hit.mediaId),
    ).toEqual(expect.arrayContaining(tracks.map((track) => track.id)));
    // Each track holding one is cut once: one new transcript per track, none more.
    expect(
      dbRows(world.media, 'SELECT count(*) AS n FROM transcripts'),
    ).toEqual(cutsBefore);
    const jobs = await runMac(docs);
    expect(
      jobs
        .flatMap(writesOf)
        .map((write) => write.path)
        .sort(),
    ).toEqual(
      tracks.map((track) => documentPath(recording.id, track.id)).sort(),
    );
  });

  it('AC-29, AC-30, BR-11, BR-12: only this track, or only the chosen ones', async () => {
    const world = await startWorld();
    const { owner } = world.media;
    const { recording } = await twelve(world);
    const inTrack = await previewOf(owner, recording.id, {
      text: 'Tiuako',
      scope: 'window',
      ...SECOND_TRACK,
    });
    expect(inTrack.occurrences.map((one) => one.startMs)).toEqual([
      100_400, 150_400, 200_400,
    ]);

    expect(
      (await batch(owner, recording.id, { items: itemsOf(inTrack) }))
        .statusCode,
    ).toBe(201);
    const text = await textOf(owner, recording.id);
    expect(text.filter((line) => line.includes('Tiuaco'))).toHaveLength(3);
    expect(text.filter((line) => /tiuako/i.test(line))).toHaveLength(9);

    const rest = await previewOf(owner, recording.id, { text: 'tiuako' });
    const chosen = itemsOf(rest).slice(2);
    expect(
      (await batch(owner, recording.id, { items: chosen, version: 1 }))
        .statusCode,
    ).toBe(201);
    expect(
      (await textOf(owner, recording.id)).filter((line) =>
        /tiuako/i.test(line),
      ),
    ).toEqual(['Tiuako, abre a sessão', 'e tiuako. responde']);
    const none = await batch(owner, recording.id, { items: [] });
    expect(none.statusCode).toBe(422);
  });

  it('AC-31: two words in four places keep their times, and a run across two segments is not offered', async () => {
    const world = await startWorld();
    const { owner } = world.media;
    const recording = await transcribed(world, [
      { at: 10, text: 'foi con certeza' },
      { at: 20, text: 'con certeza. sim' },
      { at: 30, text: 'Con certeza, não' },
      { at: 40, text: 'e con certeza' },
      { at: 50, text: 'acabou con' },
      { at: 60, text: 'certeza depois' },
    ]);
    const preview = await previewOf(owner, recording.id, {
      text: 'con certeza',
    });
    expect(preview.total).toBe(4);
    expect(preview.occurrences.every((one) => one.count === 2)).toBe(true);

    const saved = await batch(owner, recording.id, {
      items: itemsOf(preview),
      text: 'com certeza',
    });
    expect(saved.statusCode, saved.body).toBe(201);
    expect(await textOf(owner, recording.id)).toEqual([
      'foi com certeza',
      'com certeza. sim',
      'com certeza, não',
      'e com certeza',
      'acabou con',
      'certeza depois',
    ]);
    const words = dbRows(
      world.media,
      `SELECT w.text, w.start_ms FROM words w JOIN transcripts t ON t.id = w.transcript_id
       WHERE t.media_id = ? AND w.segment_position = 1 ORDER BY w.position`,
      recording.id,
    );
    expect(words).toEqual([
      { text: 'com certeza.', start_ms: 20_000 },
      { text: '', start_ms: 20_400 },
      { text: 'sim', start_ms: 20_800 },
    ]);
  });

  it('AC-32, BR-12: the preview lists the first 200 of 340 by time, and 201 items are refused', async () => {
    const world = await startWorld();
    const { owner } = world.media;
    const passages = Array.from({ length: 34 }, (_, index) => ({
      at: index * 15,
      text: Array.from(
        { length: 10 },
        (_, word) => `Tiuako p${index}w${word}`,
      ).join(' '),
    }));
    const recording = await transcribed(world, passages);
    const preview = await previewOf(owner, recording.id, { text: 'tiuako' });
    expect(preview.total).toBe(340);
    expect(preview.occurrences).toHaveLength(200);
    const starts = preview.occurrences.map((one) => one.startMs);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    const tooMany = Array.from({ length: 201 }, (_, index) => ({
      position: index * 2,
      count: 1,
      expected: ['Tiuako'],
    }));
    const refused = await batch(owner, recording.id, { items: tooMany });
    expect(refused.statusCode).toBe(422);
  });

  it('AC-33, AC-34, BR-13: a changed occurrence, a new version and a retry write nothing more', async () => {
    const world = await startWorld();
    const { media } = world;
    const { recording } = await twelve(world);
    const preview = await previewOf(media.owner, recording.id, {
      text: 'tiuako',
    });
    const [first, ...others] = itemsOf(preview);
    if (!first) throw new Error('no occurrence');
    const maria = await member(media, {
      email: 'maria@example.com',
      topics: ['hermetismo'],
      features: CORRECTOR,
    });
    await maria.call('POST', correctionsUrl(recording.id), {
      version: 1,
      ...first,
      text: 'Tiuacu,',
    });

    const refused = await batch(media.owner, recording.id, {
      items: [first, ...others],
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      error: {
        details: {
          reason: 'word-changed',
          changed: [{ position: first.position, current: 'Tiuacu,' }],
        },
      },
    });
    expect(
      (await textOf(media.owner, recording.id)).filter((line) =>
        line.includes('Tiuaco'),
      ),
    ).toEqual([]);

    const key = randomUUID();
    const once = await batch(media.owner, recording.id, { items: others, key });
    const again = await batch(media.owner, recording.id, {
      items: others,
      key,
    });
    expect([once.statusCode, again.statusCode]).toEqual([201, 200]);
    // The lost answer, sent again, says what the first one did (AC-34).
    const answered = once.json<TranscriptCorrectionBatchResult>();
    expect(answered.count).toBe(11);
    expect(again.json<TranscriptCorrectionBatchResult>()).toEqual(answered);
    const history = await historyOf(media.owner, recording.id);
    expect(
      history.entries.filter((entry) => entry.groupId === key),
    ).toHaveLength(1);
    expect(
      history.entries.find((entry) => entry.groupId === key)?.items,
    ).toHaveLength(11);

    await media.owner(
      'POST',
      `/api/v1/media/${recording.id}/transcription`,
      {},
    );
    await say(world, TWELVE);
    const stale = await batch(media.owner, recording.id, { items: others });
    expect(stale.statusCode).toBe(412);
  });

  it('AC-35, AC-36, BR-14: the group is one line, undone at once except what changed after; only its author or a master undoes it', async () => {
    const world = await startWorld();
    const { media } = world;
    const { recording } = await twelve(world);
    const maria = await member(media, {
      email: 'maria@example.com',
      topics: ['hermetismo'],
      features: CORRECTOR,
    });
    const joao = await member(media, {
      email: 'joao@example.com',
      topics: ['hermetismo'],
      features: CORRECTOR,
    });
    const preview = await previewOf(maria.call, recording.id, {
      text: 'tiuako',
    });
    const saved = await batch(maria.call, recording.id, {
      items: itemsOf(preview),
    });
    const { groupId } = saved.json<TranscriptCorrectionBatchResult>();
    const history = await historyOf(maria.call, recording.id);
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]).toMatchObject({ groupId, canUndoGroup: true });
    expect(history.entries[0]?.items).toHaveLength(12);
    expect(
      (await historyOf(joao.call, recording.id)).entries[0]?.canUndoGroup,
    ).toBe(false);

    // Two of them changed afterwards by the owner.
    for (const row of history.entries[0]?.items.slice(0, 2) ?? [])
      await media.owner('POST', correctionsUrl(recording.id), {
        version: 1,
        position: row.position,
        count: row.count,
        expected: [row.after],
        text: 'Tiuacu',
      });
    const undoUrl = `${correctionsUrl(recording.id)}/groups/${groupId}/undo`;
    expect((await joao.call('POST', undoUrl)).statusCode).toBe(403);
    const undone = await maria.call('POST', undoUrl);
    expect(undone.statusCode, undone.body).toBe(200);
    expect(undone.json<CorrectionGroupUndoResult>()).toMatchObject({
      undone: 10,
      changed: 2,
    });
    const text = (await textOf(media.owner, recording.id)).join(' ');
    expect(text.match(/Tiuacu/g)).toHaveLength(2);
    expect(text.match(/tiuako/gi)).toHaveLength(10);
    expect(
      (
        await media.owner(
          'POST',
          `${correctionsUrl(recording.id)}/groups/${randomUUID()}/undo`,
        )
      ).statusCode,
    ).toBe(404);
    const unauthorized = await member(media, {
      email: 'ouvinte@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-tracks'],
    });
    expect((await unauthorized.call('POST', undoUrl)).statusCode).toBe(403);
    expect(
      (
        await batch(unauthorized.call, recording.id, {
          items: itemsOf(preview),
        })
      ).statusCode,
    ).toBe(403);
  });

  it('AC-37, PD-08: a failure at the seventh occurrence leaves nothing changed', async () => {
    const docs = await documentsWorld();
    const { world } = docs;
    const { owner } = world.media;
    const { recording } = await twelve(world);
    await runMac(docs);
    const preview = await previewOf(owner, recording.id, { text: 'tiuako' });
    const seventh = preview.occurrences[6]?.position ?? -1;
    const before = snapshot(world.media, recording.id);
    dbExec(
      world.media,
      `CREATE TRIGGER fail_seventh BEFORE INSERT ON transcript_corrections
       WHEN NEW.first_position = ${seventh}
       BEGIN SELECT RAISE(ABORT, 'injected'); END`,
    );

    const failed = await batch(owner, recording.id, {
      items: itemsOf(preview),
    });

    expect(failed.statusCode).toBe(500);
    expect(snapshot(world.media, recording.id)).toEqual(before);
  });

  it('AC-38, BR-9: after a new version, ten of the group are carried and two are not', async () => {
    const world = await startWorld();
    const { owner } = world.media;
    const { recording } = await twelve(world);
    const preview = await previewOf(owner, recording.id, { text: 'tiuako' });
    expect(
      (await batch(owner, recording.id, { items: itemsOf(preview) }))
        .statusCode,
    ).toBe(201);

    await owner('POST', `/api/v1/media/${recording.id}/transcription`, {});
    await say(
      world,
      TWELVE.map((line, index) =>
        index < 2
          ? { ...line, text: line.text.replace(/tiuako/i, 'Tiuacô') }
          : line,
      ),
    );

    const history = await historyOf(owner, recording.id);
    expect(history.carry).toEqual({ version: 2, carried: 10, notCarried: 2 });
    const text = (await textOf(owner, recording.id)).join(' ');
    expect(text.match(/Tiuaco/g)).toHaveLength(10);
    expect(text.match(/Tiuacô/g)).toHaveLength(2);
    // Each version's group is its own line: 12 on the first, the 10 carried on the new one.
    const groups = history.entries.filter((entry) => entry.groupId !== null);
    expect(
      groups.map((entry) => ({
        version: [...new Set(entry.items.map((item) => item.version))],
        items: entry.items.length,
      })),
    ).toEqual([
      { version: [2], items: 10 },
      { version: [1], items: 12 },
    ]);
    const [carried] = groups;
    expect(carried?.items.every((item) => item.kind === 'carried')).toBe(true);
    expect(carried?.canUndoGroup).toBe(true);
    const undone = await owner(
      'POST',
      `${correctionsUrl(recording.id)}/groups/${carried?.groupId}/undo`,
    );
    expect(undone.json<CorrectionGroupUndoResult>()).toMatchObject({
      undone: 10,
      changed: 0,
    });
  });

  it('F-4: an empty text is refused, as the screen does, and writes nothing', async () => {
    const world = await startWorld();
    const { owner } = world.media;
    const { recording } = await twelve(world);
    const preview = await previewOf(owner, recording.id, { text: 'tiuako' });
    const before = snapshot(world.media, recording.id);

    for (const text of ['', '   ']) {
      const refused = await batch(owner, recording.id, {
        items: itemsOf(preview),
        text,
      });
      expect(refused.statusCode, text).toBe(422);
    }
    expect(snapshot(world.media, recording.id)).toEqual(before);
  });

  it('AC-39, BR-16: a correction never changes the term list, and the log keeps what a suggestion needs', async () => {
    const world = await startWorld();
    const { owner } = world.media;
    const { recording } = await twelve(world);
    const terms = (await owner('GET', '/api/v1/media/terms')).json();
    const preview = await previewOf(owner, recording.id, { text: 'tiuako' });
    await batch(owner, recording.id, { items: itemsOf(preview) });

    expect((await owner('GET', '/api/v1/media/terms')).json()).toEqual(terms);
    const row = (await historyOf(owner, recording.id)).entries[0]?.items[0];
    expect(row).toMatchObject({
      after: expect.stringMatching(/^Tiuaco/),
      authorName: expect.any(String),
      state: 'active',
      createdAt: expect.any(String),
    });
  });
});
