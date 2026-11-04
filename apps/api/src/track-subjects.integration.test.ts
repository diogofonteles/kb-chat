import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EditSubjects, TrackSubjects } from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  caller,
  closeApp,
  connectHouse,
  signIn,
  start,
} from '../test/ai-app-harness.js';
import { FIXTURE_VAULT } from '../test/fixture-paths.js';
import { member, type Media } from '../test/media-harness.js';
import {
  approve,
  finishCuts,
  startWorld,
  transcribed,
  type World,
} from '../test/track-items-harness.js';
import { FAKE_FREE_MODELS } from './testing/fake-openrouter.js';

afterEach(closeApp);

const TOPIC = 'hermetismo';
const SUBJECTS = `/api/v1/topics/${TOPIC}/subjects`;
const TRACKS = [
  { startMs: 0, endMs: 60_000, title: 'Primeira pergunta' },
  { startMs: 60_000, endMs: 240_000, title: 'Segunda pergunta' },
];
const SPEECH = [
  { at: 10, text: 'abertura da palestra' },
  { at: 100, text: 'a cabala na segunda faixa' },
];
const EDITOR = ['media', 'media-edit'];
const MEDIA_MODEL = {
  id: 'deepseek/deepseek-v4-flash',
  pricing: { prompt: '0.000000091', completion: '0.000000182' },
};

function vaultCopy(): string {
  const root = mkdtempSync(join(tmpdir(), 'kbchat-subjects-'));
  cpSync(FIXTURE_VAULT, root, { recursive: true });
  mkdirSync(join(root, 'udv', 'raw'), { recursive: true });
  writeFileSync(join(root, 'udv', 'topic.yaml'), 'title: UDV\n');
  return root;
}

/** Every file of a vault with its content's hash, in a stable order. */
function fingerprint(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
    .map(
      (path) =>
        `${path} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`,
    );
}

async function approved(world: World) {
  const { media } = world;
  const recording = await transcribed(world, SPEECH);
  await approve(media, recording.id, TRACKS);
  return recording;
}

const stepOf = async (media: Media, id: string) =>
  (
    await media.owner('GET', `/api/v1/media/${id}/edit/subjects`)
  ).json<EditSubjects>();

const put = (
  media: Media,
  track: Pick<TrackSubjects, 'mediaId' | 'version'>,
  payload: object,
) =>
  media.started.app.inject({
    method: 'PUT',
    url: `/api/v1/media/${track.mediaId}/subjects`,
    headers: { ...media.ownerHeaders, 'if-match': `"${track.version}"` },
    payload,
  });

const proposalsOf = (id: string) =>
  `/api/v1/media/${id}/edit/subject-proposals`;

/** Asks the fake model through the routes, as the screen does, until the run ends. */
async function suggest(media: Media, id: string, answer: string) {
  media.started.fake.models = [...FAKE_FREE_MODELS, MEDIA_MODEL];
  await connectHouse(media.started, media.owner);
  media.started.fake.scripted.push(() => ({ content: answer, cost: 0.0012 }));
  const estimate = await media.owner('POST', proposalsOf(id), { dryRun: true });
  expect(estimate.statusCode, estimate.body).toBe(200);
  const run = await media.owner('POST', proposalsOf(id), { dryRun: false });
  expect(run.statusCode, run.body).toBe(202);
  for (let tick = 0; tick < 200; tick++) {
    const step = await stepOf(media, id);
    if (step.run?.status !== 'running') return step;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('the suggestion never finished');
}

const ONE_CHIP_AND_ONE_NEW = JSON.stringify({
  faixas: [
    {
      faixa: 1,
      assuntos: ['Cabala'],
      novos: ['Sete Raios'],
      resumo: 'Abertura da palestra.',
    },
  ],
});

const acceptAll = (
  media: Media,
  track: Pick<TrackSubjects, 'mediaId' | 'version' | 'suggestions'>,
) =>
  media.started.app.inject({
    method: 'POST',
    url: `/api/v1/media/${track.mediaId}/subjects/decisions`,
    headers: { ...media.ownerHeaders, 'if-match': `"${track.version}"` },
    payload: {
      accept: track.suggestions.map((one) => one.id),
      refuse: [],
      summary: 'accept',
    },
  });

describe('Subjects of a collection (KBC-069 FR-1)', () => {
  it('lists the fixture concepts, creates a free subject and refuses it again (AC-4)', async () => {
    const { media } = await startWorld();
    const created = await media.owner('POST', SUBJECTS, {
      name: 'Burracheira',
    });
    expect(created.statusCode, created.body).toBe(201);
    const list = await media.owner('GET', SUBJECTS);
    expect(list.json()).toEqual({
      concepts: ['Cabala', 'Ritmo'],
      free: [{ id: created.json<{ id: string }>().id, name: 'Burracheira' }],
    });
    const repeat = await media.owner('POST', SUBJECTS, { name: 'burracheira' });
    expect(repeat.statusCode).toBe(409);
    expect(repeat.json()).toMatchObject({
      error: { details: { reason: 'duplicate-subject' } },
    });
  });

  it('refuses an empty name, one past 80 characters and an unknown collection', async () => {
    const { media } = await startWorld();
    for (const name of ['   ', 'x'.repeat(81)])
      expect((await media.owner('POST', SUBJECTS, { name })).statusCode).toBe(
        400,
      );
    const unknown = await media.owner('GET', '/api/v1/topics/nada/subjects');
    expect(unknown.statusCode).toBe(404);
  });
});

describe('The subjects of a track through the routes (FR-2)', () => {
  it('classifies a track still being cut, and it stays when the cut lands', async () => {
    const world = await startWorld();
    const { media } = world;
    const recording = await approved(world);
    const { tracks, canSuggest } = await stepOf(media, recording.id);
    expect(tracks.map((one) => one.title)).toEqual([
      'Primeira pergunta',
      'Segunda pergunta',
    ]);
    expect(canSuggest).toBe(true);
    const [first] = tracks;
    if (!first) throw new Error('no track');
    const saved = await put(media, first, {
      subjects: [{ kind: 'concept', name: 'Cabala' }],
      summary: 'Sobre a Cabala.',
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({
      ordinal: 1,
      title: 'Primeira pergunta',
    });
    await finishCuts(media);
    const read = await media.owner(
      'GET',
      `/api/v1/media/${first.mediaId}/subjects`,
    );
    expect(read.json()).toMatchObject({
      version: 1,
      summary: 'Sobre a Cabala.',
      subjects: [{ kind: 'concept', name: 'Cabala', missing: false }],
    });
  });

  it('needs If-Match, refuses an old version and a sixth subject (AC-3)', async () => {
    const world = await startWorld();
    const { media } = world;
    const recording = await approved(world);
    const [first] = (await stepOf(media, recording.id)).tracks;
    if (!first) throw new Error('no track');
    const bare = await media.owner(
      'PUT',
      `/api/v1/media/${first.mediaId}/subjects`,
      {
        subjects: [],
        summary: null,
      },
    );
    expect(bare.statusCode).toBe(428);
    const six = await put(media, first, {
      subjects: Array.from({ length: 6 }, (_, index) => ({
        kind: 'concept',
        name: `C${index}`,
      })),
      summary: null,
    });
    expect(six.statusCode).toBe(400);
    expect(
      (await put(media, first, { subjects: [], summary: null })).statusCode,
    ).toBe(200);
    expect(
      (await put(media, first, { subjects: [], summary: null })).statusCode,
    ).toBe(412);
  });

  it('keeps the links of a track re-approved with the same id', async () => {
    const world = await startWorld();
    const { media } = world;
    const recording = await approved(world);
    await finishCuts(media);
    const [first] = (await stepOf(media, recording.id)).tracks;
    if (!first) throw new Error('no track');
    await put(media, first, {
      subjects: [{ kind: 'concept', name: 'Ritmo' }],
      summary: null,
    });
    await approve(media, recording.id, [
      { title: 'Primeira, renomeada', startMs: 0, endMs: 58_000 },
      TRACKS[1] as (typeof TRACKS)[number],
    ]);
    const [renamed] = (await stepOf(media, recording.id)).tracks;
    const answered = await media.owner(
      'GET',
      `/api/v1/media/${first.mediaId}/subjects`,
    );
    expect(answered.json<TrackSubjects>().title).toBe(renamed?.title);
    await finishCuts(media);
    const [kept] = (await stepOf(media, recording.id)).tracks;
    expect(kept?.mediaId).toBe(first.mediaId);
    expect(kept?.subjects.map((one) => one.name)).toEqual(['Ritmo']);
  });
});

describe('Who classifies (AC-6)', () => {
  it('refuses media-edit without media-classify, on reads, writes and the suggestion', async () => {
    const world = await startWorld();
    const { media } = world;
    const recording = await approved(world);
    const [first] = (await stepOf(media, recording.id)).tracks;
    if (!first) throw new Error('no track');
    const { call } = await member(media, {
      email: 'editor@example.com',
      topics: [TOPIC],
      features: [...EDITOR, 'media-edit-ai'],
    });
    const body = { subjects: [], summary: null };
    expect(
      (await call('PUT', `/api/v1/media/${first.mediaId}/subjects`, body))
        .statusCode,
    ).toBe(403);
    expect(
      (await call('GET', `/api/v1/media/${first.mediaId}/subjects`)).statusCode,
    ).toBe(403);
    expect(
      (await call('GET', `/api/v1/media/${recording.id}/edit/subjects`))
        .statusCode,
    ).toBe(403);
    expect((await call('GET', SUBJECTS)).statusCode).toBe(403);
    expect((await call('POST', SUBJECTS, { name: 'X' })).statusCode).toBe(403);
    expect(
      (
        await call(
          'POST',
          `/api/v1/media/${recording.id}/edit/subject-proposals`,
          { dryRun: true },
        )
      ).statusCode,
    ).toBe(403);
  });

  it('refuses the suggestion to media-classify without media-edit-ai, and lets the rest through', async () => {
    const world = await startWorld();
    const { media } = world;
    const recording = await approved(world);
    const { call } = await member(media, {
      email: 'classifier@example.com',
      topics: [TOPIC],
      features: ['media', 'media-classify'],
    });
    expect(
      (await call('GET', `/api/v1/media/${recording.id}/edit/subjects`))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await call(
          'POST',
          `/api/v1/media/${recording.id}/edit/subject-proposals`,
          { dryRun: true },
        )
      ).statusCode,
    ).toBe(403);
  });

  it('hides another collection: its subjects and its tracks', async () => {
    const world = await startWorld();
    const { media } = world;
    const recording = await approved(world);
    const [first] = (await stepOf(media, recording.id)).tracks;
    if (!first) throw new Error('no track');
    const { call } = await member(media, {
      email: 'outsider@example.com',
      topics: ['udv'],
      features: ['media', 'media-classify'],
    });
    expect((await call('GET', SUBJECTS)).statusCode).toBe(404);
    expect(
      (await call('GET', `/api/v1/media/${first.mediaId}/subjects`)).statusCode,
    ).toBe(404);
  });

  it('reaches the model only through the app AI: without it the run is refused', async () => {
    const world = await startWorld();
    const { media } = world;
    const recording = await approved(world);
    const asked = await media.owner(
      'POST',
      `/api/v1/media/${recording.id}/edit/subject-proposals`,
      { dryRun: true },
    );
    expect(asked.statusCode).toBe(409);
    expect(asked.json()).toMatchObject({
      error: { code: 'LLM_NOT_CONFIGURED' },
    });
  });
});

describe('The suggestion over HTTP (KBC-069 FR-3, TE-13)', () => {
  it('prices it, makes one call, leaves chips, and an accepted new subject joins the collection', async () => {
    const world = await startWorld();
    const { media } = world;
    const recording = await approved(world);
    await finishCuts(media);

    const step = await suggest(media, recording.id, ONE_CHIP_AND_ONE_NEW);

    expect(step).toMatchObject({
      run: { status: 'done', failure: null },
      canSuggest: false,
    });
    expect(media.started.fake.chats).toHaveLength(1);
    const [first, second] = step.tracks;
    if (!first) throw new Error('no track');
    expect(first.subjects).toEqual([]);
    expect(first.suggestions.map(({ kind, name }) => [kind, name])).toEqual([
      ['concept', 'Cabala'],
      ['new', 'Sete Raios'],
    ]);
    expect(first.suggestedSummary).toBe('Abertura da palestra.');
    expect(second?.suggestions).toEqual([]);
    const before = await media.owner('GET', SUBJECTS);
    expect(before.json()).toMatchObject({ free: [] });

    const accepted = await acceptAll(media, first);

    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toMatchObject({
      subjects: [{ name: 'Cabala' }, { name: 'Sete Raios', kind: 'free' }],
      suggestions: [],
      summary: 'Abertura da palestra.',
    });
    const after = await media.owner('GET', SUBJECTS);
    expect(after.json()).toMatchObject({ free: [{ name: 'Sete Raios' }] });
  });

  it('reads an answer wrapped in reasoning and fences', async () => {
    const world = await startWorld();
    const { media } = world;
    const recording = await approved(world);
    await finishCuts(media);
    const step = await suggest(
      media,
      recording.id,
      `<think>{"faixas": []}</think>Aqui está:\n\`\`\`json\n${ONE_CHIP_AND_ONE_NEW}\n\`\`\``,
    );
    expect(step.run).toMatchObject({ status: 'done', failure: null });
  });

  it('offers to try again, by a press, when the answer brought nothing', async () => {
    const world = await startWorld();
    const { media } = world;
    const recording = await approved(world);
    await finishCuts(media);
    const step = await suggest(media, recording.id, '{"faixas":[]}');
    expect(step).toMatchObject({
      run: { status: 'failed', failure: 'invalid-output' },
      canSuggest: true,
    });
  });

  it('refuses a run the body did not ask for', async () => {
    const world = await startWorld();
    const { media } = world;
    const recording = await approved(world);
    const asked = await media.owner('POST', proposalsOf(recording.id), {});
    expect(asked.statusCode).toBe(400);
  });
});

describe('The vault stays as it is (Q7, BR-4)', () => {
  it('AC-5: a concept removed from the vault is flagged after the catalog is read again, and the track still plays', async () => {
    const vault = vaultCopy();
    const world = await startWorld({ vault });
    const { media } = world;
    const recording = await approved(world);
    await finishCuts(media);
    const [first] = (await stepOf(media, recording.id)).tracks;
    if (!first) throw new Error('no track');
    await put(media, first, {
      subjects: [{ kind: 'concept', name: 'Cabala' }],
      summary: null,
    });

    await closeApp();
    rmSync(join(vault, TOPIC, 'wiki', 'concepts', 'Cabala.md'));
    const started = await start({
      media: true,
      vault,
      state: media.started.state,
    });
    const headers = await signIn(started, 'owner@example.com');
    const owner = caller(started.app, headers);

    const read = await owner('GET', `/api/v1/media/${first.mediaId}/subjects`);
    expect(read.json()).toMatchObject({
      subjects: [{ name: 'Cabala', missing: true }],
    });
    const item = await owner('GET', `/api/v1/media/${first.mediaId}`);
    expect(item.statusCode).toBe(200);
    expect(item.json()).toMatchObject({ status: 'ready' });
  });

  it('AC-8: nothing here changes a file of the vault', async () => {
    const vault = vaultCopy();
    const before = fingerprint(vault);
    const world = await startWorld({ vault });
    const { media } = world;
    const recording = await approved(world);
    await finishCuts(media);
    await media.owner('POST', SUBJECTS, { name: 'Burracheira' });
    const { tracks } = await suggest(media, recording.id, ONE_CHIP_AND_ONE_NEW);
    const [first, second] = tracks;
    if (!first || !second) throw new Error('no track');
    const accepted = await acceptAll(media, first);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toMatchObject({
      subjects: [{ name: 'Cabala' }, { name: 'Sete Raios' }],
    });
    await put(media, second, {
      subjects: [{ kind: 'concept', name: 'Cabala' }],
      summary: 'Resumo.',
    });
    await closeApp();
    expect(fingerprint(vault)).toEqual(before);
  });
});
