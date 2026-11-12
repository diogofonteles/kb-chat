import { afterEach, describe, expect, it } from 'vitest';
import { closeApp } from '../test/ai-app-harness.js';
import { fix } from '../test/correction-harness.js';
import { leakageWorld } from '../test/leakage-world.js';

/*
 * KBC-111 (review, headers): a correction inside a track above Ana's level changes nothing she
 * receives from the recording she hears, its subtitles' entity tag included, which is now made
 * of what she gets rather than of the transcript's revision.
 */

afterEach(closeApp);

describe('a correction inside a hidden part (KBC-111)', () => {
  it('leaves what Ana reads of the recording, and its ETag, as they were', async () => {
    const { world, ana, recording } = await leakageWorld({ sentinels: true });
    const subtitles = `/api/v1/media/${recording.id}/subtitles.vtt`;
    const transcript = `/api/v1/media/${recording.id}/transcript`;
    const before = await ana.call('GET', subtitles);
    const read = await ana.call('GET', transcript);

    const fixed = await fix(world.owner, recording.id, {
      from: 'velada',
      to: 'escondida',
    });
    const after = await ana.call('GET', subtitles);
    const reread = await ana.call('GET', transcript);

    expect(fixed.statusCode, fixed.body).toBe(201);
    expect(before.statusCode, before.body).toBe(200);
    expect(after.headers['etag']).toBe(before.headers['etag']);
    expect(after.body).toBe(before.body);
    expect(reread.json()).toEqual(read.json());
    const master = await world.owner('GET', subtitles);
    expect(master.body).toContain('escondida');
  });
});
