import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  MediaItem,
  MediaPreparation,
  PreparationPlanRequest,
  RawTranscript,
} from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp, connectHouse } from '../test/ai-app-harness.js';
import {
  conversationRaw,
  leaseDiarization,
  pairDiarizer,
  sendTurns,
} from '../test/diarization-harness.js';
import {
  AUDIO,
  aRequest,
  leaseJob,
  startMedia,
  upload,
  type Media,
} from '../test/media-harness.js';
import {
  finishCuts,
  libraryEntry,
  versionOf,
  withVersion,
} from '../test/track-items-harness.js';
import { windowIds } from '../test/track-proposal-fixtures.js';
import {
  convertWithFlac,
  leaseTranscription,
  sendTranscript,
} from '../test/transcription-harness.js';
import {
  FAKE_FREE_MODELS,
  type FakeChatBody,
} from './testing/fake-openrouter.js';

afterEach(closeApp);

const MODEL = {
  id: 'deepseek/deepseek-v4-flash',
  pricing: { prompt: '0.000000091', completion: '0.000000182' },
};
const PLAN: PreparationPlanRequest = {
  transcribe: true,
  speakers: true,
  tracks: 'ai',
  subjects: false,
  acceptedUsd: 0.05,
};
const SPEAKERS = '/api/v1/topics/hermetismo/speakers';
const url = (id: string) => `/api/v1/media/${id}`;

const proposal = (body: FakeChatBody) => {
  const { first, last } = windowIds(
    String(body.messages?.at(-1)?.content ?? ''),
  );
  return {
    content: JSON.stringify({
      faixas: [
        {
          primeiro_id: first,
          ultimo_id: last,
          tipo: 'pergunta_resposta',
          quem_pergunta: null,
          quem_responde: 'Voz 1',
          titulo: 'Provisório',
          continua_faixa_anterior: false,
        },
      ],
      vozes: [
        {
          voz: 'Voz 1',
          nome: 'Mestre Laércio',
          plateia: false,
          motivo: 'é o autor',
        },
      ],
    }),
    cost: 0.0012,
  };
};

async function read(media: Media, id: string): Promise<MediaPreparation> {
  const answer = await media.owner('GET', `${url(id)}/preparation`);
  expect(answer.statusCode, answer.body).toBe(200);
  return answer.json<MediaPreparation>();
}

function sql(media: Media, statement: string, ...values: string[]) {
  const db = new DatabaseSync(join(media.mediaDir, 'media.db'));
  db.prepare(statement).run(...values);
  db.close();
}

/** A finished proposal whose suggestion and title say `suggested`. */
async function proposed(input: {
  readonly suggested: string;
  readonly title: string;
}) {
  const media = await startMedia();
  const { token } = await pairDiarizer(media);
  media.started.fake.models = [...FAKE_FREE_MODELS, MODEL];
  await connectHouse(media.started, media.owner);
  media.started.fake.scripted.push(proposal);
  const created = await media.owner(
    'POST',
    '/api/v1/topics/hermetismo/media',
    aRequest({ author: null, plan: PLAN }),
  );
  const item = created.json<MediaItem>();
  await upload(media, { id: item.id, body: AUDIO });
  await convertWithFlac(media, await leaseJob(media));
  const raw: RawTranscript = conversationRaw();
  const job = await leaseTranscription(media, token);
  await sendTranscript(media, { token, job, raw });
  await read(media, item.id);
  const separation = await leaseDiarization(media, token);
  await sendTurns(media, { token, job: separation });
  let now = await read(media, item.id);
  for (let tick = 0; tick < 200 && now.tracks.length === 0; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    now = await read(media, item.id);
  }
  for (let tick = 0; tick < 200; tick++) {
    if (now.stages.at(-1)?.state === 'done') break;
    await new Promise((resolve) => setTimeout(resolve, 5));
    now = await read(media, item.id);
  }
  sql(media, 'UPDATE media_voice_suggestions SET name = ?', input.suggested);
  sql(media, 'UPDATE media_draft_tracks SET title = ?', input.title);
  return { media, id: item.id, version: now.separation ?? 0 };
}

type Case = Awaited<ReturnType<typeof proposed>>;

async function speakerNamed(media: Media, name: string): Promise<string> {
  const speaker = await media.owner('POST', SPEAKERS, { name });
  expect(speaker.statusCode, speaker.body).toBeLessThan(300);
  return speaker.json<{ id: string }>().id;
}

async function name({ media, id, version }: Case, speaker: string | null) {
  const speakerId = speaker ? await speakerNamed(media, speaker) : null;
  const answer = await media.owner('PUT', `${url(id)}/voices/1`, {
    version,
    speakerId,
    audience: false,
  });
  expect(answer.statusCode, answer.body).toBe(200);
}

const titleOf = async ({ media, id }: Case) =>
  (await read(media, id)).tracks[0]?.title;

async function approve({ media, id }: Case) {
  await media.owner('POST', `${url(id)}/preparation/advance`, {});
  const approved = await withVersion(media, id, {
    method: 'POST',
    url: `${url(id)}/edit/approve`,
  });
  expect(approved.statusCode, approved.body).toBe(200);
  await finishCuts(media);
}

describe("a corrected name in the AI's words (KBC-090)", () => {
  it('replaces the whole name, and who answers follows', async () => {
    const one = await proposed({
      suggested: 'Márcio da Roça',
      title: 'Conversa com Márcio da Roça',
    });
    await name(one, 'Márcio da Rós');
    const after = await read(one.media, one.id);
    expect(after.tracks[0]).toMatchObject({
      title: 'Conversa com Márcio da Rós',
      answerer: { name: 'Márcio da Rós', voice: 1 },
    });
    expect(after.suggestions).toEqual([]);
  });

  it('stays as it is on a rerun when the new name holds the old one', async () => {
    const one = await proposed({
      suggested: 'Márcio da Roça',
      title: 'Conversa com Márcio da Roça',
    });
    await name(one, 'Márcio da Roça Filho');
    await name(one, 'Márcio da Roça Filho');
    await name(one, 'Márcio da Roça Filho');
    expect(await titleOf(one)).toBe('Conversa com Márcio da Roça Filho');
  });

  it('takes the name it wrote on a second correction, and on an undo', async () => {
    const one = await proposed({
      suggested: 'Márcio da Roça',
      title: 'Conversa com Márcio da Roça',
    });
    await name(one, 'Márcio da Rós');
    await name(one, 'Márcio da Rocha');
    expect(await titleOf(one)).toBe('Conversa com Márcio da Rocha');
    await name(one, null);
    expect(await titleOf(one)).toBe('Conversa com Márcio da Roça');
  });

  it('finds the name however its accents are stored, and nothing around it', async () => {
    const decomposed = 'Márcio da Roça'.normalize('NFD');
    const one = await proposed({
      suggested: 'Márcio da Roça',
      title: `${decomposed} e Márcio da Rocinha, de Marcio da Roca`,
    });
    await name(one, 'Márcio da Rós');
    expect(await titleOf(one)).toBe(
      'Márcio da Rós e Márcio da Rocinha, de Marcio da Roca',
    );
  });

  it('leaves the text of a one-word name, and shows which tracks to review', async () => {
    const one = await proposed({
      suggested: 'Pedro',
      title: 'São Pedro e Pedro Álvares',
    });
    await name(one, 'Marcos');
    const after = await read(one.media, one.id);
    expect(after.tracks[0]).toMatchObject({
      title: 'São Pedro e Pedro Álvares',
      answerer: { name: 'Marcos' },
    });
    expect(after.nameReviews).toEqual([
      {
        voice: 1,
        name: 'Pedro',
        tracks: [
          { id: after.tracks[0]?.id, title: 'São Pedro e Pedro Álvares' },
        ],
      },
    ]);
  });

  it('leaves what a person wrote, and asks to review it', async () => {
    const one = await proposed({
      suggested: 'Márcio da Roça',
      title: 'Conversa com Márcio da Roça',
    });
    const { media, id } = one;
    await media.owner('POST', `${url(id)}/preparation/advance`, {});
    const edit = await media.owner('GET', `${url(id)}/edit`);
    const body = edit.json<{ tracks: Record<string, unknown>[] }>();
    const tracks = body.tracks.map((track) => ({
      id: track['id'],
      source: track['source'],
      startMs: track['startMs'],
      endMs: track['endMs'],
      kind: track['kind'],
      askerVoice: track['askerVoice'],
      answererVoice: track['answererVoice'],
      askerSpeakerId: track['askerSpeakerId'],
      answererSpeakerId: track['answererSpeakerId'],
      title: 'Escrevi: Márcio da Roça, o pai',
    }));
    const saved = await withVersion(media, id, {
      method: 'PUT',
      url: `${url(id)}/edit`,
      payload: { step: 3, tracks },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    await name(one, 'Márcio da Rós');
    const after = await read(media, id);
    expect(after.tracks[0]?.title).toBe('Escrevi: Márcio da Roça, o pai');
    expect(after.nameReviews[0]?.name).toBe('Márcio da Roça');
  });

  it("never touches a person's track", async () => {
    const one = await proposed({
      suggested: 'Márcio da Roça',
      title: 'Conversa com Márcio da Roça',
    });
    sql(one.media, `UPDATE media_draft_tracks SET source = 'manual'`);
    await name(one, 'Márcio da Rós');
    expect(await titleOf(one)).toBe('Conversa com Márcio da Roça');
  });

  it('leaves the text of a refused name and warns on it', async () => {
    const one = await proposed({
      suggested: 'Márcio da Roça',
      title: 'Conversa com Márcio da Roça',
    });
    const refused = await one.media.owner(
      'POST',
      `${url(one.id)}/voices/1/refuse-name`,
      { version: one.version },
    );
    expect(refused.statusCode, refused.body).toBe(200);
    const after = await read(one.media, one.id);
    expect(after.suggestions).toEqual([]);
    expect(after.tracks[0]?.answerer).toMatchObject({ name: null, voice: 1 });
    expect(after.nameReviews[0]?.tracks).toHaveLength(1);
  });

  it('refusing after accepting takes the name off the voice and the tracks', async () => {
    const one = await proposed({
      suggested: 'Márcio da Roça',
      title: 'Conversa com Márcio da Roça',
    });
    await name(one, 'Márcio da Roça');
    await one.media.owner('POST', `${url(one.id)}/voices/1/refuse-name`, {
      version: one.version,
    });
    const after = await read(one.media, one.id);
    expect(after.voices.find(({ voice }) => voice === 1)?.name).toBeNull();
    expect(after.tracks[0]?.answerer).toMatchObject({ name: null, voice: 1 });
    expect(after.refusedVoices).toEqual([1]);
  });

  it("a track that holds the speaker follows the correction, through the screen's write", async () => {
    const one = await proposed({
      suggested: 'Márcio da Roça',
      title: 'Conversa com Márcio da Roça',
    });
    const { media, id } = one;
    await name(one, 'Márcio da Roça');
    await media.owner('POST', `${url(id)}/preparation/advance`, {});
    const edit = await media.owner('GET', `${url(id)}/edit`);
    const [track] = edit.json<{ tracks: Record<string, unknown>[] }>().tracks;
    const speakers = await media.owner('GET', SPEAKERS);
    const held = speakers
      .json<{ items: { id: string; name: string }[] }>()
      .items.find((speaker) => speaker.name === 'Márcio da Roça');
    const saved = await withVersion(media, id, {
      method: 'PUT',
      url: `${url(id)}/edit`,
      payload: {
        step: 3,
        tracks: [
          {
            id: track?.['id'],
            source: track?.['source'],
            startMs: track?.['startMs'],
            endMs: track?.['endMs'],
            kind: track?.['kind'],
            title: track?.['title'],
            askerVoice: track?.['askerVoice'],
            answererVoice: track?.['answererVoice'],
            askerSpeakerId: null,
            answererSpeakerId: held?.id,
          },
        ],
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    await name(one, 'Márcio da Rós');
    expect((await read(media, id)).tracks[0]?.answerer).toMatchObject({
      name: 'Márcio da Rós',
    });
  });
});

describe('a corrected name on published tracks (KBC-090, KBC-073 BR-8, BR-10)', () => {
  it('changes through the revision path: history and version', async () => {
    const one = await proposed({
      suggested: 'Márcio da Roça',
      title: 'Conversa com Márcio da Roça',
    });
    const { media, id } = one;
    await approve(one);
    const [before] = (await libraryEntry(media.owner, id))?.tracks ?? [];
    const edit = await media.owner(
      'GET',
      `${url(before?.id ?? '')}/track-edit`,
    );
    const version = edit.json<{ version: number }>().version;

    await name(one, 'Márcio da Rós');

    const [track] = (await libraryEntry(media.owner, id))?.tracks ?? [];
    expect(track?.title).toBe('Conversa com Márcio da Rós');
    const after = await media.owner(
      'GET',
      `${url(track?.id ?? '')}/track-edit`,
    );
    expect(after.json<{ version: number }>().version).toBeGreaterThan(version);
    const history = await media.owner('GET', `${url(track?.id ?? '')}/history`);
    const { changes } = history.json<{
      changes: { field: string; after: string }[];
    }>();
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'title',
          after: 'Conversa com Márcio da Rós',
        }),
      ]),
    );
    expect(await versionOf(media, id)).toBeGreaterThan(0);
  });

  it("a person's title on a published track stays", async () => {
    const one = await proposed({
      suggested: 'Márcio da Roça',
      title: 'Conversa com Márcio da Roça',
    });
    const { media, id } = one;
    await approve(one);
    const [track] = (await libraryEntry(media.owner, id))?.tracks ?? [];
    const trackUrl = url(track?.id ?? '');
    const edit = await media.owner('GET', `${trackUrl}/track-edit`);
    const version = edit.json<{ version: number }>().version;
    const patched = await media.started.app.inject({
      method: 'PATCH',
      url: trackUrl,
      headers: { ...media.ownerHeaders, 'if-match': `"${version}"` },
      payload: { title: 'Márcio da Roça, por mim' },
    });
    expect(patched.statusCode, patched.body).toBeLessThan(300);
    await name(one, 'Márcio da Rós');
    const [after] = (await libraryEntry(media.owner, id))?.tracks ?? [];
    expect(after?.title).toBe('Márcio da Roça, por mim');
  });

  it('the author of a published track that holds the speaker follows too', async () => {
    const one = await proposed({
      suggested: 'Márcio da Roça',
      title: 'Conversa',
    });
    const { media, id, version } = one;
    await name(one, 'Márcio da Roça');
    await approve(one);
    const speaker = await media.owner('POST', SPEAKERS, {
      name: 'Mestre Rafael',
      authorSlug: 'mestre-laercio',
    });
    const speakerId = speaker.json<{ id: string }>().id;
    await media.owner('PUT', `${url(id)}/voices/1`, {
      version,
      speakerId,
      audience: false,
    });
    const [track] = (await libraryEntry(media.owner, id))?.tracks ?? [];
    expect(track?.author?.slug).toBe('mestre-laercio');
  });
});
