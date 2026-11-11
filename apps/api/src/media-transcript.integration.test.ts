import type {
  MediaItem,
  MediaTranscript,
  MediaTranscriptWords,
} from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp } from '../test/ai-app-harness.js';
import { member, startMedia, type Media } from '../test/media-harness.js';
import {
  leaseTranscription,
  pair,
  readyForTranscription,
  sendTranscript,
} from '../test/transcription-harness.js';
import { pilotRaw, type PilotFixture } from '../test/transcript-fixtures.js';

afterEach(closeApp);

/** A ready item transcribed by a paired Mac with a pilot fixture. */
async function transcribed(
  media: Media,
  fixture: PilotFixture = 'clean-cd01-01',
): Promise<MediaItem> {
  const { token } = await pair(media);
  const item = await readyForTranscription(media);
  const job = await leaseTranscription(media, token);
  const sent = await sendTranscript(media, {
    token,
    job,
    raw: pilotRaw(fixture),
  });
  expect(sent.statusCode).toBe(204);
  return item;
}

const transcriptUrl = (id: string) => `/api/v1/media/${id}/transcript`;
const subtitlesUrl = (id: string) => `/api/v1/media/${id}/subtitles.vtt`;
const wordsUrl = (id: string, from = 0, count = 10) =>
  `/api/v1/media/${id}/transcript/words?from=${from}&count=${count}`;

describe('GET /api/v1/media/:id/transcript (KBC-038 FR-2)', () => {
  it('returns the current version with its segments in ms and the confidence', async () => {
    const media = await startMedia();
    const item = await transcribed(media);
    const answer = await media.owner('GET', transcriptUrl(item.id));
    expect(answer.statusCode).toBe(200);
    const transcript = answer.json<MediaTranscript>();
    expect(transcript).toMatchObject({
      mediaId: item.id,
      version: 1,
      confidence: 'normal',
    });
    expect(transcript.segments[0]).toEqual({
      startMs: 100,
      endMs: 4_640,
      text: 'Existia um rei denominado Inca.',
    });
    // Only what the contract shows: no whisper scores.
    expect(Object.keys(transcript.segments[0] ?? {})).toEqual([
      'startMs',
      'endMs',
      'text',
    ]);
  });

  it('says a noisy transcript is of low confidence (BR-2)', async () => {
    const media = await startMedia();
    const item = await transcribed(media, 'noisy-cd03-06');
    const answer = await media.owner('GET', transcriptUrl(item.id));
    expect(answer.json<MediaTranscript>().confidence).toBe('low');
  });

  it('answers 409 while the media has no transcript yet', async () => {
    const media = await startMedia();
    const item = await readyForTranscription(media);
    const answer = await media.owner('GET', transcriptUrl(item.id));
    expect(answer.statusCode).toBe(409);
    expect(answer.json().error.code).toBe('MEDIA_NOT_READY');
    const vtt = await media.owner('GET', subtitlesUrl(item.id));
    expect(vtt.statusCode).toBe(409);
  });

  it('answers 404 for a media id that does not exist', async () => {
    const media = await startMedia();
    const missing = '00000000-0000-4000-8000-000000000000';
    const answer = await media.owner('GET', transcriptUrl(missing));
    expect(answer.statusCode).toBe(404);
    expect(answer.json().error.code).toBe('MEDIA_NOT_FOUND');
  });

  it('answers 400 for an id that is not a media id', async () => {
    const media = await startMedia();
    const answer = await media.owner('GET', transcriptUrl('not-a-uuid'));
    expect(answer.statusCode).toBe(400);
  });
});

describe('GET /api/v1/media/:id/subtitles.vtt (KBC-038 FR-1)', () => {
  it('returns WebVTT whose cues keep within 84 characters and 6 s (AC-1)', async () => {
    const media = await startMedia();
    const item = await transcribed(media);
    const answer = await media.owner('GET', subtitlesUrl(item.id));
    expect(answer.statusCode).toBe(200);
    expect(answer.headers['content-type']).toBe('text/vtt; charset=utf-8');
    expect(answer.headers['cache-control']).toBe('private, no-cache');
    const body = answer.body;
    expect(body.startsWith('WEBVTT\n\n1\n00:00:00.100 --> ')).toBe(true);
    const blocks = body.trim().split('\n\n').slice(1);
    expect(blocks.length).toBeGreaterThan(5);
    for (const block of blocks) {
      const [, timing = '', ...lines] = block.split('\n');
      const [start = '', end = ''] = timing.split(' --> ');
      expect(lines.join(' ').length).toBeLessThanOrEqual(84);
      expect(seconds(end) - seconds(start)).toBeLessThanOrEqual(6);
    }
  });

  it('answers 304 when the browser already has this version', async () => {
    const media = await startMedia();
    const item = await transcribed(media);
    const first = await media.owner('GET', subtitlesUrl(item.id));
    const etag = String(first.headers['etag']);
    expect(etag).toMatch(/^".+\.f1\.s3"$/);
    const again = await media.started.app.inject({
      method: 'GET',
      url: subtitlesUrl(item.id),
      headers: { ...media.ownerHeaders, 'if-none-match': `W/${etag}` },
    });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    const cached = await media.owner('GET', subtitlesUrl(item.id));
    expect(cached.body).toBe(first.body);
  });

  it('gives a new version its own subtitles (a new tag)', async () => {
    const media = await startMedia();
    const { token } = await pair(media);
    const item = await readyForTranscription(media);
    const first = await sendTranscript(media, {
      token,
      job: await leaseTranscription(media, token),
    });
    expect(first.statusCode).toBe(204);
    const before = await media.owner('GET', subtitlesUrl(item.id));
    const again = await media.owner(
      'POST',
      `/api/v1/media/${item.id}/transcription`,
    );
    expect(again.statusCode).toBe(200);
    const job = await leaseTranscription(media, token);
    // The FLAC went after the first transcript: the job's audio is the rendition now.
    const second = await sendTranscript(media, {
      token,
      job,
      raw: pilotRaw('clean-cd02-01'),
    });
    expect(second.statusCode).toBe(204);
    const after = await media.owner('GET', subtitlesUrl(item.id));
    expect(after.headers['etag']).not.toBe(before.headers['etag']);
    expect(after.body).not.toBe(before.body);
    const transcript = await media.owner('GET', transcriptUrl(item.id));
    expect(transcript.json<MediaTranscript>().version).toBe(2);
  });
});

describe('GET /api/v1/media/:id/transcript/words (KBC-045 FR-1)', () => {
  it('returns the kept words of the asked segments, each with its times in ms', async () => {
    const media = await startMedia();
    const item = await transcribed(media);
    const transcript = (
      await media.owner('GET', transcriptUrl(item.id))
    ).json<MediaTranscript>();
    const answer = await media.owner('GET', wordsUrl(item.id, 1, 2));
    expect(answer.statusCode).toBe(200);
    const { mediaId, version, words } = answer.json<MediaTranscriptWords>();
    expect({ mediaId, version }).toEqual({ mediaId: item.id, version: 1 });
    expect(new Set(words.map((word) => word.segment))).toEqual(new Set([1, 2]));
    const second = transcript.segments[1];
    const spoken = words.filter((word) => word.segment === 1);
    expect(spoken.map((word) => word.text).join(' ')).toBe(second?.text);
    for (const word of spoken) {
      expect(Number.isInteger(word.startMs)).toBe(true);
      expect(word.endMs).toBeGreaterThanOrEqual(word.startMs);
    }
  });

  it('gives no words past the end of the transcript', async () => {
    const media = await startMedia();
    const item = await transcribed(media);
    const answer = await media.owner('GET', wordsUrl(item.id, 90_000, 10));
    expect(answer.statusCode).toBe(200);
    expect(answer.json<MediaTranscriptWords>().words).toEqual([]);
  });

  it.each([
    ['a negative start', -1, 10],
    ['no segments', 0, 0],
    ['more segments than a page may ask', 0, 201],
  ])('refuses %s (400)', async (_name, from, count) => {
    const media = await startMedia();
    const item = await transcribed(media);
    const answer = await media.owner('GET', wordsUrl(item.id, from, count));
    expect(answer.statusCode).toBe(400);
  });

  it('keeps the words out of the transcript itself (no scan of every word)', async () => {
    const media = await startMedia();
    const item = await transcribed(media);
    const answer = await media.owner('GET', transcriptUrl(item.id));
    expect(answer.body).not.toContain('"words"');
  });

  it('answers as the transcript to who may not read it (404, 403, 401)', async () => {
    const media = await startMedia();
    const item = await transcribed(media);
    const stranger = await member(media, {
      email: 'outro@example.com',
      topics: ['alquimia'],
      features: ['media'],
    });
    expect((await stranger.call('GET', wordsUrl(item.id))).statusCode).toBe(
      404,
    );
    const noMedia = await member(media, {
      email: 'sem-midia@example.com',
      topics: ['hermetismo'],
      features: ['search'],
    });
    expect((await noMedia.call('GET', wordsUrl(item.id))).statusCode).toBe(403);
    const anonymous = await media.started.app.inject({
      method: 'GET',
      url: wordsUrl(item.id),
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('Transcript access: the same as the stream (KBC-038 FR-1, AC-5)', () => {
  it('answers 404 to a member who does not see the media collection', async () => {
    const media = await startMedia();
    const item = await transcribed(media);
    const { call } = await member(media, {
      email: 'outro@example.com',
      topics: ['alquimia'],
      features: ['media'],
    });
    for (const url of [transcriptUrl(item.id), subtitlesUrl(item.id)]) {
      const answer = await call('GET', url);
      expect(answer.statusCode).toBe(404);
      expect(answer.json().error.code).toBe('MEDIA_NOT_FOUND');
    }
  });

  it('refuses a member without "Ouvir mídia" (403), and lets one with it read', async () => {
    const media = await startMedia();
    const item = await transcribed(media);
    const noMedia = await member(media, {
      email: 'sem-midia@example.com',
      topics: ['hermetismo'],
      features: ['search'],
    });
    expect((await noMedia.call('GET', subtitlesUrl(item.id))).statusCode).toBe(
      403,
    );
    expect((await noMedia.call('GET', transcriptUrl(item.id))).statusCode).toBe(
      403,
    );
    const listener = await member(media, {
      email: 'ouvinte@example.com',
      topics: ['hermetismo'],
      features: ['media'],
    });
    expect((await listener.call('GET', subtitlesUrl(item.id))).statusCode).toBe(
      200,
    );
  });

  it('refuses a request without a session (401)', async () => {
    const media = await startMedia();
    const item = await transcribed(media);
    const answer = await media.started.app.inject({
      method: 'GET',
      url: subtitlesUrl(item.id),
    });
    expect(answer.statusCode).toBe(401);
  });
});

/** `hh:mm:ss.mmm` in seconds. */
function seconds(time: string): number {
  const [hours = '0', minutes = '0', rest = '0'] = time.split(':');
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(rest);
}
