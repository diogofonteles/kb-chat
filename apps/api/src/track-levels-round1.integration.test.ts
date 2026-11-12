/**
 * KBC-106 round 1 (QA and review): an editor below a track's level cannot use the recording's
 * edit routes (decision of 2026-11-12, fail closed); a save without `level` keeps the stored
 * level; the stream closes when its sample table cannot vouch for the mask, and what it masks
 * decodes as silence; the hidden part stays hidden from the approval on.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp } from '../test/ai-app-harness.js';
import { levelAudit, memberOf, setPersonLevel } from '../test/levels-world.js';
import { ffmpegBins } from '../test/media-tools.js';
import { finishCuts, withVersion } from '../test/track-items-harness.js';
import {
  mediaOf,
  realRendition,
  scene,
  setTrackLevel,
} from '../test/track-levels-world.js';

afterEach(closeApp);

const EDITOR = [
  'search',
  'media',
  'media-edit',
  'media-edit-ai',
  'media-tracks',
  'media-speakers',
];

/** The mean volume (dB) of `seconds` from `from` of an MP4 held in `bytes`. */
function meanVolume(bytes: Buffer, from: number, seconds: number): number {
  const dir = mkdtempSync(join(tmpdir(), 'kbchat-r1-'));
  const path = join(dir, 'answer.m4a');
  writeFileSync(path, bytes);
  const run = spawnSync(ffmpegBins().ffmpeg, [
    '-hide_banner',
    '-xerror',
    '-ss',
    String(from),
    '-t',
    String(seconds),
    '-i',
    path,
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-',
  ]);
  if (run.status !== 0) throw new Error(run.stderr.toString());
  const found = /mean_volume: (-?[\d.]+) dB/.exec(run.stderr.toString());
  return Number(found?.[1] ?? Number.NaN);
}

const codeOf = (answer: LightMyRequestResponse) =>
  answer.json<{ error?: { code: string } }>().error?.code;

describe('an editor below a track of the recording (KBC-106 decision, QA BUG-1, BUG-2)', () => {
  it('gets 403 EDIT_ABOVE_YOUR_LEVEL on every edit route of the recording; the track stays CDC', async () => {
    const { world, recording, tracks } = await scene();
    const edu = await memberOf(world, 'edu@example.com', {
      topics: ['hermetismo'],
      features: EDITOR,
    });
    await setPersonLevel(world, edu.id, { hermetismo: 'ci' });
    const second = String(tracks[1]?.id);
    const first = String(tracks[0]?.id);
    expect((await setTrackLevel(world, second, 'cdc')).statusCode).toBe(200);
    const id = recording.id;
    const asEdu = (
      method: 'GET' | 'PUT' | 'POST',
      url: string,
      payload?: object,
    ) =>
      world.started.app.inject({
        method,
        url,
        headers: { ...edu.headers, 'if-match': '"1"' },
        ...(payload && { payload }),
      });

    for (const [method, url, payload] of [
      ['GET', `/api/v1/media/${id}/edit`],
      ['GET', `/api/v1/media/${id}/edit/words`],
      ['GET', `/api/v1/media/${id}/edit/draft-tracks`],
      ['GET', `/api/v1/media/${id}/preparation`],
      ['GET', `/api/v1/media/${id}/speakers`],
      ['GET', `/api/v1/media/${first}/track-edit`],
      ['GET', `/api/v1/media/${id}/archived-tracks`],
      ['PUT', `/api/v1/media/${id}/edit`, { step: 3, tracks: [] }],
      ['POST', `/api/v1/media/${id}/edit/approve`, {}],
      ['POST', `/api/v1/media/${id}/edit/reopen`, {}],
      ['POST', `/api/v1/media/${id}/edit/proposals`, { dryRun: true }],
      ['POST', `/api/v1/media/${first}/restore`, {}],
    ] as const) {
      const answer = await asEdu(method, url, payload);
      expect(answer.statusCode, `${method} ${url} ${answer.body}`).toBe(403);
      expect(codeOf(answer), url).toBe('EDIT_ABOVE_YOUR_LEVEL');
      expect(answer.body).not.toContain('Pergunta Sensivel');
    }
    // Reading along is listening: the transcript, with no voices of the editor's kind.
    const transcript = await edu.call('GET', `/api/v1/media/${id}/transcript`);
    expect(transcript.statusCode).toBe(200);
    expect(transcript.json().speakers).toBeUndefined();
    expect(transcript.body).not.toContain('segredo');

    const library = await world.owner('GET', `/api/v1/media/${second}`);
    expect(library.json().level).toEqual({ id: 'cdc', code: 'CDC' });

    // Once the track is back at the recording's level, Edu edits as before.
    expect((await setTrackLevel(world, second, null)).statusCode).toBe(200);
    expect((await edu.call('GET', `/api/v1/media/${id}/edit`)).statusCode).toBe(
      200,
    );
  }, 60_000);

  it('a save without `level` keeps the level the draft holds; the approval keeps the track CDC', async () => {
    const { world, recording, tracks } = await scene();
    const second = String(tracks[1]?.id);
    expect((await setTrackLevel(world, second, 'cdc')).statusCode).toBe(200);
    const media = mediaOf(world);
    const url = `/api/v1/media/${recording.id}/edit`;
    const reopened = await withVersion(media, recording.id, {
      method: 'POST',
      url: `${url}/reopen`,
    });
    expect(reopened.statusCode, reopened.body).toBe(200);
    const read = await world.owner('GET', url);
    const drafted = read.json<{ tracks: Record<string, unknown>[] }>().tracks;
    expect(drafted.map((one) => one['level'])).toEqual([null, 'cdc', null]);
    const saved = await withVersion(media, recording.id, {
      method: 'PUT',
      url,
      payload: {
        step: 3,
        tracks: drafted.map((one) => ({
          id: one['id'],
          source: one['source'],
          startMs: one['startMs'],
          endMs: one['endMs'],
          kind: one['kind'],
          title: one['title'],
          askerVoice: one['askerVoice'],
          answererVoice: one['answererVoice'],
          askerSpeakerId: one['askerSpeakerId'],
          answererSpeakerId: one['answererSpeakerId'],
        })),
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const after = await world.owner('GET', url);
    expect(
      after
        .json<{ tracks: { level: string | null }[] }>()
        .tracks.map((one) => one.level),
    ).toEqual([null, 'cdc', null]);
    const approved = await withVersion(media, recording.id, {
      method: 'POST',
      url: `${url}/approve`,
    });
    expect(approved.statusCode, approved.body).toBe(200);
    await finishCuts(media);
    const track = await world.owner('GET', `/api/v1/media/${second}`);
    expect(track.json().level).toEqual({ id: 'cdc', code: 'CDC' });
  }, 60_000);
});

describe('the stream of a recording with a hidden part (KBC-106 review B2, M2)', () => {
  it('closes (409 MEDIA_NOT_READY) for Ana when its file cannot be read as an MP4; the master hears it', async () => {
    const { world, ana, recording, tracks } = await scene();
    expect(
      (await setTrackLevel(world, String(tracks[1]?.id), 'cdc')).statusCode,
    ).toBe(200);
    // The harness's stand-in file: no sample table to mask by.
    const url = `/api/v1/media/${recording.id}/stream`;
    const closed = await ana.call('GET', url);
    expect(closed.statusCode).toBe(409);
    expect(codeOf(closed)).toBe('MEDIA_NOT_READY');
    expect((await world.owner('GET', url)).statusCode).toBe(200);
  }, 60_000);

  it('closes for Ana when the file holds a video track too (QA-5)', async () => {
    const { world, ana, recording, tracks } = await scene();
    expect(
      (await setTrackLevel(world, String(tracks[1]?.id), 'cdc')).statusCode,
    ).toBe(200);
    realRendition(world, recording.id, { video: true });
    const url = `/api/v1/media/${recording.id}/stream`;
    expect((await ana.call('GET', url)).statusCode).toBe(409);
  }, 60_000);

  it('AC-3: what Ana gets decodes as silence over track 2, whole or by ranges', async () => {
    const { world, ana, recording, tracks } = await scene();
    expect(
      (await setTrackLevel(world, String(tracks[1]?.id), 'cdc')).statusCode,
    ).toBe(200);
    realRendition(world, recording.id);
    const url = `/api/v1/media/${recording.id}/stream`;
    const whole = await ana.call('GET', url);
    expect(whole.statusCode).toBe(200);
    expect(meanVolume(whole.rawPayload, 75, 30)).toBeLessThan(-80);
    expect(meanVolume(whole.rawPayload, 20, 30)).toBeGreaterThan(-40);
    expect(meanVolume(whole.rawPayload, 130, 30)).toBeGreaterThan(-40);

    const size = whole.rawPayload.length;
    const half = Math.floor(size / 2);
    const part = async (range: string) =>
      (
        await world.started.app.inject({
          method: 'GET',
          url,
          headers: { ...ana.headers, range },
        })
      ).rawPayload;
    const joined = Buffer.concat([
      await part(`bytes=0-${half - 1}`),
      await part(`bytes=${half}-`),
    ]);
    expect(joined.length).toBe(size);
    expect(meanVolume(joined, 75, 30)).toBeLessThan(-80);
    expect(meanVolume(joined, 20, 30)).toBeGreaterThan(-40);
  }, 60_000);
});

describe('the hidden part from the approval on (KBC-106 review m3, m4)', () => {
  it('hides a new track of its own before its cut is done, and audits its level', async () => {
    const { world, ana, recording } = await scene();
    const media = mediaOf(world);
    const url = `/api/v1/media/${recording.id}/edit`;
    expect(
      (
        await withVersion(media, recording.id, {
          method: 'POST',
          url: `${url}/reopen`,
        })
      ).statusCode,
    ).toBe(200);
    const saved = await withVersion(media, recording.id, {
      method: 'PUT',
      url,
      payload: {
        step: 3,
        tracks: [
          {
            id: randomUUID(),
            source: 'manual',
            kind: 'qa',
            title: 'Nova restrita',
            startMs: 200_000,
            endMs: 260_000,
            askerVoice: null,
            answererVoice: null,
            askerSpeakerId: null,
            answererSpeakerId: null,
            level: 'cdc',
          },
        ],
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const approved = await withVersion(media, recording.id, {
      method: 'POST',
      url: `${url}/approve`,
    });
    expect(approved.statusCode, approved.body).toBe(200);
    // The cut has not run: the part is hidden already.
    const item = await ana.call('GET', `/api/v1/media/${recording.id}`);
    expect(item.json().hidden).toContainEqual({
      startMs: 200_000,
      endMs: 260_000,
    });
    const audit = await levelAudit(world.started.state);
    expect(
      audit.filter((one) => one.kind === 'item.level' && one.after === 'cdc'),
    ).toHaveLength(1);
  }, 60_000);

  it("restricted segments take the hidden part's bounds: nothing tells where each one starts", async () => {
    const { world, ana, recording, tracks } = await scene();
    expect(
      (await setTrackLevel(world, String(tracks[1]?.id), 'cdc')).statusCode,
    ).toBe(200);
    const transcript = await ana.call(
      'GET',
      `/api/v1/media/${recording.id}/transcript`,
    );
    const restricted = transcript
      .json<{
        segments: { startMs: number; endMs: number; restricted?: boolean }[];
      }>()
      .segments.filter((one) => one.restricted);
    expect(restricted).toEqual([
      expect.objectContaining({ startMs: 60_000, endMs: 120_000 }),
    ]);
  }, 60_000);
});
