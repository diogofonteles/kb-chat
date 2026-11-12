/**
 * Tracks with their own level (KBC-106, ADR 0036 §3): a track may sit above its recording;
 * whoever hears the recording and not the track gets neither its sound, its text, its
 * subtitles, its words nor its passages in "Na fala".
 */
import type { SearchResponse } from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp } from '../test/ai-app-harness.js';
import { levelAudit } from '../test/levels-world.js';
import {
  approve,
  finishCuts,
  libraryEntry,
} from '../test/track-items-harness.js';
import {
  mediaOf,
  packetAt,
  realRendition,
  scene,
  setTrackLevel,
} from '../test/track-levels-world.js';

afterEach(closeApp);

describe('Tracks with their own level (KBC-106)', () => {
  it('AC-1: the editor puts track 2 in CDC and only it moves; below the recording is refused', async () => {
    const { world, tracks } = await scene();
    const [first, second, third] = tracks.map((track) => track.id);
    expect(tracks.map((track) => track.level?.id)).toEqual(['ci', 'ci', 'ci']);

    const raised = await setTrackLevel(world, String(second), 'cdc');
    expect(raised.statusCode, raised.body).toBe(200);
    expect(raised.json().level).toEqual({ id: 'cdc', code: 'CDC' });
    const entry = await libraryEntry(
      world.owner,
      String(tracks[0]?.parent?.id),
    );
    expect(entry?.tracks.map((track) => [track.id, track.level?.id])).toEqual([
      [first, 'ci'],
      [second, 'cdc'],
      [third, 'ci'],
    ]);

    const below = await setTrackLevel(world, String(first), 'qs');
    expect(below.statusCode).toBe(400);
    expect(below.json().error.code).toBe('LEVEL_BELOW_RECORDING');
  }, 60_000);

  it('AC-2, AC-6: Ana hears the recording without track 2; its text, words, subtitles and passages are gone; the master hears all', async () => {
    const { world, ana, recording, tracks } = await scene();
    const second = String(tracks[1]?.id);
    expect((await setTrackLevel(world, second, 'cdc')).statusCode).toBe(200);
    const id = recording.id;

    const item = await ana.call('GET', `/api/v1/media/${id}`);
    expect(item.statusCode, item.body).toBe(200);
    expect(item.json().hidden).toEqual([{ startMs: 60_000, endMs: 120_000 }]);
    expect((await ana.call('GET', `/api/v1/media/${second}`)).statusCode).toBe(
      404,
    );
    const listed = await ana.call('GET', `/api/v1/media/${id}/tracks`);
    expect(listed.body).not.toContain('Pergunta Sensivel');
    expect(listed.json().tracks).toHaveLength(2);

    const transcript = await ana.call('GET', `/api/v1/media/${id}/transcript`);
    expect(transcript.statusCode, transcript.body).toBe(200);
    expect(transcript.body).not.toContain('segredo');
    expect(transcript.body).toContain('lua');
    const restricted = transcript
      .json<{ segments: { restricted?: boolean; text: string }[] }>()
      .segments.filter((one) => one.restricted);
    expect(restricted).toEqual([
      expect.objectContaining({ text: '', restricted: true }),
    ]);
    const words = await ana.call(
      'GET',
      `/api/v1/media/${id}/transcript/words?from=0&count=10`,
    );
    expect(words.statusCode, words.body).toBe(200);
    expect(words.body).not.toContain('segredo');
    expect(words.body).toContain('sol');
    const vtt = await ana.call('GET', `/api/v1/media/${id}/subtitles.vtt`);
    expect(vtt.statusCode).toBe(200);
    expect(vtt.body).not.toContain('segredo');
    expect(vtt.body).toContain('lua');

    const search = await ana.call(
      'POST',
      '/api/v1/topics/hermetismo/searches',
      { q: 'segredo velado', kinds: ['audio'] },
    );
    expect(search.statusCode, search.body).toBe(200);
    expect(search.body).not.toContain('segredo');
    expect(search.json<SearchResponse>().kinds.audio ?? 0).toBe(0);
    const open = await ana.call('POST', '/api/v1/topics/hermetismo/searches', {
      q: 'lua aberta',
      kinds: ['audio'],
    });
    expect(open.json<SearchResponse>().kinds.audio).toBeGreaterThan(0);

    // AC-6: the master hears everything and sees the CDC badge on track 2.
    const master = await world.owner('GET', `/api/v1/media/${id}`);
    expect(master.json().hidden).toBeUndefined();
    const masterTracks = await world.owner('GET', `/api/v1/media/${id}/tracks`);
    expect(
      masterTracks
        .json<{ tracks: { title: string; level?: { code: string } }[] }>()
        .tracks.map((one) => [one.title, one.level?.code]),
    ).toEqual([
      ['Primeira', 'CI'],
      ['Pergunta Sensivel', 'CDC'],
      ['Terceira', 'CI'],
    ]);
    const masterText = await world.owner(
      'GET',
      `/api/v1/media/${id}/transcript`,
    );
    expect(masterText.body).toContain('segredo');
  }, 60_000);

  it('AC-3: a byte inside track 2 is 416 for Ana; a range across it comes masked', async () => {
    const { world, ana, recording, tracks } = await scene();
    expect(
      (await setTrackLevel(world, String(tracks[1]?.id), 'cdc')).statusCode,
    ).toBe(200);
    const path = realRendition(world, recording.id);
    const inside = packetAt(path, 90);
    const url = `/api/v1/media/${recording.id}/stream`;

    const ranged = (headers: Record<string, string>, range: string) =>
      world.started.app.inject({
        method: 'GET',
        url,
        headers: { ...headers, range },
      });
    const byte = await ranged(ana.headers, `bytes=${inside}-${inside}`);
    expect(byte.statusCode).toBe(416);

    const before = packetAt(path, 50);
    const after = packetAt(path, 130);
    const across = await ranged(ana.headers, `bytes=${before}-${after}`);
    expect(across.statusCode).toBe(206);
    const master = await ranged(world.ownerHeaders, `bytes=${before}-${after}`);
    const offset = inside - before;
    expect(across.rawPayload.length).toBe(master.rawPayload.length);
    expect(
      across.rawPayload
        .subarray(offset, offset + 64)
        .equals(master.rawPayload.subarray(offset, offset + 64)),
    ).toBe(false);
    // Before the hidden part, the same bytes.
    expect(
      across.rawPayload
        .subarray(0, 64)
        .equals(master.rawPayload.subarray(0, 64)),
    ).toBe(true);
    // The master gets a byte inside.
    const own = await ranged(world.ownerHeaders, `bytes=${inside}-${inside}`);
    expect(own.statusCode).toBe(206);
  }, 60_000);

  it('AC-5, BR-4: back to the recording level, Ana hears it again and the audit holds both changes', async () => {
    const { world, ana, recording, tracks } = await scene();
    const second = String(tracks[1]?.id);
    expect((await setTrackLevel(world, second, 'cdc')).statusCode).toBe(200);
    expect((await ana.call('GET', `/api/v1/media/${second}`)).statusCode).toBe(
      404,
    );

    const back = await setTrackLevel(world, second, null);
    expect(back.statusCode, back.body).toBe(200);
    expect((await ana.call('GET', `/api/v1/media/${second}`)).statusCode).toBe(
      200,
    );
    const item = await ana.call('GET', `/api/v1/media/${recording.id}`);
    expect(item.json().hidden).toBeUndefined();
    const audit = await levelAudit(world.started.state);
    expect(
      audit
        .filter((one) => one.target === second)
        .map(({ kind, before, after }) => [kind, before, after]),
    ).toEqual([
      ['item.level', 'ci', 'cdc'],
      ['item.level', 'cdc', 'ci'],
    ]);
  }, 60_000);

  it('BR-1: raising the recording above a track of its own raises the track, which keeps its own level', async () => {
    const { world, recording, tracks } = await scene();
    const [first, second] = tracks.map((track) => String(track.id));
    expect((await setTrackLevel(world, String(second), 'cdc')).statusCode).toBe(
      200,
    );
    const ownBefore = await world.owner('GET', `/api/v1/media/${recording.id}`);
    expect(ownBefore.json().ownTrackLevels).toEqual(['cdc']);

    const raised = await world.owner('PATCH', `/api/v1/media/${recording.id}`, {
      level: 'cdc',
    });
    expect(raised.statusCode, raised.body).toBe(200);
    const lowered = await world.owner(
      'PATCH',
      `/api/v1/media/${recording.id}`,
      {
        level: 'qs',
      },
    );
    expect(lowered.statusCode, lowered.body).toBe(200);
    const entry = await libraryEntry(world.owner, recording.id);
    // The followers came down with it; track 2 stays where someone put it.
    expect(entry?.tracks.map((track) => [track.id, track.level?.id])).toEqual([
      [first, 'qs'],
      [second, 'cdc'],
      [String(tracks[2]?.id), 'qs'],
    ]);
  }, 60_000);

  it('FR-1: the draft carries a level per track, refused below the recording, applied on approval', async () => {
    const { world, recording } = await scene();
    const media = mediaOf(world);
    const edit = await world.owner('GET', `/api/v1/media/${recording.id}/edit`);
    expect(edit.statusCode, edit.body).toBe(200);
    expect(edit.json().levels).toEqual({
      recording: { id: 'ci', code: 'CI' },
      choices: [{ id: 'cdc', code: 'CDC' }],
    });
    await expect(
      approve(media, recording.id, [
        { startMs: 0, endMs: 60_000, title: 'Uma', level: 'qs' },
      ]),
    ).rejects.toThrow();
    await approve(media, recording.id, [
      { startMs: 0, endMs: 60_000, title: 'Uma' },
      { startMs: 60_000, endMs: 120_000, title: 'Duas', level: 'cdc' },
    ]);
    await finishCuts(media);
    const entry = await libraryEntry(world.owner, recording.id);
    expect(
      entry?.tracks.map((track) => [track.title, track.level?.id]),
    ).toEqual([
      ['Uma', 'ci'],
      ['Duas', 'cdc'],
    ]);
  }, 60_000);
});
