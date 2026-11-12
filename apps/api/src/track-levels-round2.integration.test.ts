/**
 * KBC-106 review round 2: the word corrections and "Editar informações" are edits of the
 * recording too (403 below any of its track levels); a move that would drop a track's own level
 * is a master's; the hidden part of a transcript is one item whatever it held.
 */
import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp } from '../test/ai-app-harness.js';
import {
  createScale,
  memberOf,
  setPersonLevel,
  startLevels,
  SIX,
} from '../test/levels-world.js';
import {
  approve,
  finishCuts,
  libraryEntry,
} from '../test/track-items-harness.js';
import {
  mediaOf,
  scene,
  setTrackLevel,
  transcribedRecording,
} from '../test/track-levels-world.js';

afterEach(closeApp);

const EDITOR = [
  'search',
  'media',
  'media-upload',
  'media-edit',
  'media-edit-ai',
  'media-tracks',
  'media-correct',
];

const codeOf = (answer: LightMyRequestResponse) =>
  answer.json<{ error?: { code: string } }>().error?.code;

describe('the word corrections of a recording with a track above the editor (review B3)', () => {
  it('answer 403 EDIT_ABOVE_YOUR_LEVEL on every route, naming nothing of the hidden part', async () => {
    const { world, recording, tracks } = await scene();
    const edu = await memberOf(world, 'edu@example.com', {
      topics: ['hermetismo'],
      features: EDITOR,
    });
    await setPersonLevel(world, edu.id, { hermetismo: 'ci' });
    const second = String(tracks[1]?.id);
    expect((await setTrackLevel(world, second, 'cdc')).statusCode).toBe(200);
    const id = recording.id;
    const base = `/api/v1/media/${id}/transcript`;
    for (const [method, url, payload] of [
      ['GET', `${base}/occurrences?text=segredo`],
      ['GET', `${base}/corrections`],
      [
        'POST',
        `${base}/corrections`,
        {
          version: 1,
          position: 0,
          count: 1,
          expected: ['lua'],
          text: 'sol',
        },
      ],
      [
        'POST',
        `${base}/corrections/batch`,
        { version: 1, key: randomUUID(), text: 'nada', items: [] },
      ],
      ['POST', `${base}/corrections/${randomUUID()}/undo`, {}],
      ['POST', `${base}/corrections/groups/${randomUUID()}/undo`, {}],
      [
        'POST',
        `/api/v1/media/${String(tracks[0]?.id)}/suggestions`,
        { dryRun: true },
      ],
    ] as const) {
      const answer = await world.started.app.inject({
        method,
        url,
        headers: edu.headers,
        ...(payload && { payload }),
      });
      expect(answer.statusCode, `${method} ${url} ${answer.body}`).toBe(403);
      expect(codeOf(answer), url).toBe('EDIT_ABOVE_YOUR_LEVEL');
      expect(answer.body).not.toContain('segredo');
    }
  }, 60_000);
});

describe('"Editar informações" of a recording with tracks of their own (review B4)', () => {
  async function owned() {
    const world = await startLevels(SIX, { media: true });
    const edu = await memberOf(world, 'edu@example.com', {
      topics: ['hermetismo', 'alquimia'],
      features: EDITOR,
    });
    await createScale(world, ['QS', 'CI', 'CDC']);
    await setPersonLevel(world, edu.id, { hermetismo: 'ci' });
    const recording = await transcribedRecording(world, { by: edu });
    const media = mediaOf(world);
    await approve(media, recording.id, [
      { startMs: 0, endMs: 60_000, title: 'Primeira' },
      { startMs: 60_000, endMs: 120_000, title: 'Segunda' },
    ]);
    await finishCuts(media);
    const entry = await libraryEntry(world.owner, recording.id);
    return { world, edu, recording, tracks: entry?.tracks ?? [] };
  }

  it('refuses the sender below a track to move it or change its level (403); a title still changes', async () => {
    const { world, edu, recording, tracks } = await owned();
    const second = String(tracks[1]?.id);
    expect((await setTrackLevel(world, second, 'cdc')).statusCode).toBe(200);
    const url = `/api/v1/media/${recording.id}`;
    for (const body of [{ topic: 'alquimia' }, { level: 'qs' }]) {
      const answer = await edu.call('PATCH', url, body);
      expect(answer.statusCode, answer.body).toBe(403);
      expect(codeOf(answer)).toBe('EDIT_ABOVE_YOUR_LEVEL');
    }
    expect(
      (await edu.call('PATCH', url, { title: 'Outro título' })).statusCode,
    ).toBe(200);
    const track = await world.owner('GET', `/api/v1/media/${second}`);
    expect(track.json().level).toEqual({ id: 'cdc', code: 'CDC' });
    expect(track.json().topic).toBe('hermetismo');
  }, 60_000);

  it('refuses anyone but a master a move that would drop a track of its own (409); the master moves it', async () => {
    const { world, edu, recording, tracks } = await owned();
    await setPersonLevel(world, edu.id, { hermetismo: 'cdc' });
    const second = String(tracks[1]?.id);
    expect((await setTrackLevel(world, second, 'cdc')).statusCode).toBe(200);
    const url = `/api/v1/media/${recording.id}`;
    const moved = await edu.call('PATCH', url, { topic: 'alquimia' });
    expect(moved.statusCode, moved.body).toBe(409);
    expect(
      moved.json<{ error: { details?: { reason?: string } } }>().error.details
        ?.reason,
    ).toBe('tracks-of-their-own');
    // Within the same scale nothing drops: the move goes.
    expect(
      (await edu.call('PATCH', url, { topic: 'hermetismo/aulas' })).statusCode,
    ).toBe(200);
    const master = await world.owner('PATCH', url, { topic: 'alquimia' });
    expect(master.statusCode, master.body).toBe(200);
  }, 60_000);
});

describe('the hidden part of a transcript is one item (review n7)', () => {
  it('folds the hidden segments into one restricted item and numbers the words after it', async () => {
    const { world, ana, recording, tracks } = await scene({
      passages: [
        { at: 10, text: 'lua aberta do comeco' },
        { at: 70, text: 'segredo velado do cume' },
        { at: 90, text: 'outro segredo guardado' },
        { at: 130, text: 'sol final da palestra' },
      ],
    });
    expect(
      (await setTrackLevel(world, String(tracks[1]?.id), 'cdc')).statusCode,
    ).toBe(200);
    const id = recording.id;
    const transcript = await ana.call('GET', `/api/v1/media/${id}/transcript`);
    const segments = transcript.json<{
      segments: { restricted?: boolean; startMs: number; endMs: number }[];
    }>().segments;
    expect(segments).toHaveLength(3);
    expect(segments[1]).toMatchObject({
      restricted: true,
      startMs: 60_000,
      endMs: 120_000,
    });
    const words = await ana.call(
      'GET',
      `/api/v1/media/${id}/transcript/words?from=2&count=1`,
    );
    expect(words.statusCode, words.body).toBe(200);
    const page = words.json<{ words: { segment: number; text: string }[] }>()
      .words;
    expect(page.map((one) => one.text.trim())).toEqual([
      'sol',
      'final',
      'da',
      'palestra',
    ]);
    expect(page.every((one) => one.segment === 2)).toBe(true);
    // The master reads the four as they are.
    const all = await world.owner('GET', `/api/v1/media/${id}/transcript`);
    expect(all.json<{ segments: unknown[] }>().segments).toHaveLength(4);
  }, 60_000);
});
