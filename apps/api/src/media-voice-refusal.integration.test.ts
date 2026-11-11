import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RawSpeakerTurn } from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL, closeApp } from '../test/ai-app-harness.js';
import {
  CONVERSATION_TURNS,
  leaseDiarization,
  pairDiarizer,
  requestVoices,
  sendTurns,
  transcribedItem,
  turnsOf,
} from '../test/diarization-harness.js';
import { member, startMedia, type Media } from '../test/media-harness.js';

afterEach(closeApp);

const refuseUrl = (mediaId: string, voice: number | string) =>
  `/api/v1/media/${mediaId}/voices/${voice}/refuse-name`;

async function separate(media: Media, token: string, mediaId: string) {
  expect((await requestVoices(media, mediaId)).statusCode).toBe(202);
  const job = await leaseDiarization(media, token);
  const turns: readonly RawSpeakerTurn[] = CONVERSATION_TURNS;
  const sent = await sendTurns(media, {
    token,
    job,
    body: turnsOf(job, turns),
  });
  expect(sent.statusCode).toBe(204);
}

/** An item with its voices separated once (version 1). */
async function separated(media: Media) {
  const { token } = await pairDiarizer(media);
  const mediaId = await transcribedItem(media, token);
  await separate(media, token, mediaId);
  return { token, mediaId };
}

function refusals(media: Media): number {
  const db = new DatabaseSync(join(media.mediaDir, 'media.db'));
  const row = db
    .prepare('SELECT count(*) AS n FROM media_voice_refusals')
    .get() as { n: number };
  db.close();
  return row.n;
}

describe('Refusing a suggested name: who may, and on what (KBC-090)', () => {
  it('without a session, 401; nothing is written', async () => {
    const media = await startMedia();
    const { mediaId } = await separated(media);
    const answer = await media.started.app.inject({
      method: 'POST',
      url: refuseUrl(mediaId, 1),
      headers: LOCAL,
      payload: { version: 1 },
    });
    expect(answer.statusCode).toBe(401);
    expect(refusals(media)).toBe(0);
  });

  it('a member without `media-edit` gets 403; nothing is written', async () => {
    const media = await startMedia();
    const { mediaId } = await separated(media);
    const { call } = await member(media, {
      email: 'ouve@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-speakers'],
    });
    const answer = await call('POST', refuseUrl(mediaId, 1), { version: 1 });
    expect(answer.statusCode).toBe(403);
    expect(refusals(media)).toBe(0);
  });

  it('an editor who does not see the collection gets 404; nothing is written', async () => {
    const media = await startMedia();
    const { mediaId } = await separated(media);
    const { call } = await member(media, {
      email: 'fora@example.com',
      topics: [],
      features: ['media', 'media-speakers', 'media-edit'],
    });
    const answer = await call('POST', refuseUrl(mediaId, 1), { version: 1 });
    expect(answer.statusCode).toBe(404);
    expect(refusals(media)).toBe(0);
  });

  it('a voice the separation does not have, or an unknown item, is 404', async () => {
    const media = await startMedia();
    const { mediaId } = await separated(media);
    const voice = await media.owner('POST', refuseUrl(mediaId, 9), {
      version: 1,
    });
    expect(voice.statusCode).toBe(404);
    const item = await media.owner(
      'POST',
      refuseUrl('00000000-0000-4000-8000-000000000000', 1),
      { version: 1 },
    );
    expect(item.statusCode).toBe(404);
    expect(refusals(media)).toBe(0);
  });

  it('an older separation is 409 MEDIA_CONFLICT; the current one is refused', async () => {
    const media = await startMedia();
    const { token, mediaId } = await separated(media);
    await separate(media, token, mediaId);
    const old = await media.owner('POST', refuseUrl(mediaId, 1), {
      version: 1,
    });
    expect(old.statusCode).toBe(409);
    expect(old.json<{ error: { code: string } }>().error.code).toBe(
      'MEDIA_CONFLICT',
    );
    expect(refusals(media)).toBe(0);
    const fresh = await media.owner('POST', refuseUrl(mediaId, 1), {
      version: 2,
    });
    expect(fresh.statusCode, fresh.body).toBe(200);
    expect(refusals(media)).toBe(1);
  });

  it('an invalid body or voice is 400; nothing is written', async () => {
    const media = await startMedia();
    const { mediaId } = await separated(media);
    for (const [voice, body] of [
      [1, { version: 1, x: 1 }],
      [1, {}],
      [1, { version: 'um' }],
      ['zero', { version: 1 }],
    ] as const) {
      const answer = await media.owner('POST', refuseUrl(mediaId, voice), body);
      expect(answer.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(refusals(media)).toBe(0);
  });
});
