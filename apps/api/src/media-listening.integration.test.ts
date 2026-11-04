import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_LIBRARY_PREFERENCES } from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp } from '../test/ai-app-harness.js';
import {
  member,
  queuedItem,
  readyItem,
  startMedia,
} from '../test/media-harness.js';

afterEach(closeApp);

/** The fake worker converts every upload to 180 s (media-harness `convert`). */
const DURATION_MS = 180_000;

describe('Media listening: preferences (KBC-041 FR-1)', () => {
  it('starts at 1× with the remaining time, and keeps what the person chooses (AC-1)', async () => {
    const media = await startMedia();
    const first = await media.owner('GET', '/api/v1/media/preferences');
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      ...DEFAULT_LIBRARY_PREFERENCES,
      speed: 1,
      showRemaining: true,
      skipBackSec: 15,
      skipForwardSec: 30,
      skipSilences: false,
      wordHighlight: true,
    });
    const saved = await media.owner('PUT', '/api/v1/media/preferences', {
      speed: 1.5,
      showRemaining: false,
      skipBackSec: 10,
      skipForwardSec: 45,
      skipSilences: false,
      wordHighlight: true,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({
      ...DEFAULT_LIBRARY_PREFERENCES,
      speed: 1.5,
      showRemaining: false,
      skipBackSec: 10,
      skipForwardSec: 45,
      skipSilences: false,
      wordHighlight: true,
    });
    expect(
      (await media.owner('GET', '/api/v1/media/preferences')).json(),
    ).toEqual({
      ...DEFAULT_LIBRARY_PREFERENCES,
      speed: 1.5,
      showRemaining: false,
      skipBackSec: 10,
      skipForwardSec: 45,
      skipSilences: false,
      wordHighlight: true,
    });
  });

  it('refuses a speed outside the menu and changes nothing (AC-2)', async () => {
    const media = await startMedia();
    const refused = await media.owner('PUT', '/api/v1/media/preferences', {
      speed: 3,
      showRemaining: true,
      skipBackSec: 15,
      skipForwardSec: 30,
      skipSilences: false,
      wordHighlight: true,
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('VALIDATION_FAILED');
    expect(
      (await media.owner('GET', '/api/v1/media/preferences')).json(),
    ).toEqual({
      ...DEFAULT_LIBRARY_PREFERENCES,
      speed: 1,
      showRemaining: true,
      skipBackSec: 15,
      skipForwardSec: 30,
      skipSilences: false,
      wordHighlight: true,
    });
  });

  it('keeps each person’s choices apart', async () => {
    const media = await startMedia();
    const listener = await member(media, {
      email: 'ouvinte@example.com',
      topics: ['hermetismo'],
      features: ['search', 'media'],
    });
    await media.owner('PUT', '/api/v1/media/preferences', {
      speed: 2,
      showRemaining: true,
      skipBackSec: 15,
      skipForwardSec: 30,
      skipSilences: false,
      wordHighlight: true,
    });
    expect(
      (await listener.call('GET', '/api/v1/media/preferences')).json(),
    ).toEqual({
      ...DEFAULT_LIBRARY_PREFERENCES,
      speed: 1,
      showRemaining: true,
      skipBackSec: 15,
      skipForwardSec: 30,
      skipSilences: false,
      wordHighlight: true,
    });
  });

  it('needs "Ouvir mídia", for the position too', async () => {
    const media = await startMedia();
    const reader = await member(media, {
      email: 'leitor@example.com',
      topics: ['hermetismo'],
      features: ['search'],
    });
    expect(
      (await reader.call('GET', '/api/v1/media/preferences')).statusCode,
    ).toBe(403);
    expect(
      (
        await reader.call('PUT', '/api/v1/media/preferences', {
          speed: 1,
          showRemaining: true,
          skipBackSec: 15,
          skipForwardSec: 30,
          skipSilences: false,
          wordHighlight: true,
        })
      ).statusCode,
    ).toBe(403);
    const item = await readyItem(media);
    expect(
      (
        await reader.call('PUT', `/api/v1/media/${item.id}/progress`, {
          positionMs: 1,
          basedOn: null,
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('Media listening: skip lengths (KBC-043)', () => {
  it('refuses a skip off the "Pulos" menu and changes nothing (AC-4)', async () => {
    const media = await startMedia();
    const refused = await media.owner('PUT', '/api/v1/media/preferences', {
      speed: 1,
      showRemaining: true,
      skipBackSec: 7,
      skipForwardSec: 30,
      skipSilences: false,
      wordHighlight: true,
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('VALIDATION_FAILED');
    expect(
      (await media.owner('GET', '/api/v1/media/preferences')).json(),
    ).toMatchObject({ skipBackSec: 15, skipForwardSec: 30 });
  });
});

describe('Media listening: position (KBC-041 FR-2, BR-2)', () => {
  it('saves where the person stopped and returns it in the list and the item (AC-3)', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    expect(item.positionMs).toBe(0);
    const saved = await media.owner(
      'PUT',
      `/api/v1/media/${item.id}/progress`,
      {
        positionMs: 23_000,
        basedOn: null,
      },
    );
    expect(saved.statusCode).toBe(200);
    const kept = saved.json();
    expect(kept).toMatchObject({ positionMs: 23_000, completedAt: null });
    expect(Date.parse(kept.positionUpdatedAt)).not.toBeNaN();
    const listed = (
      await media.owner('GET', '/api/v1/topics/hermetismo/media')
    ).json().items[0];
    expect(listed).toMatchObject({
      positionMs: 23_000,
      completedAt: null,
      positionUpdatedAt: kept.positionUpdatedAt,
    });
    expect(
      (await media.owner('GET', `/api/v1/media/${item.id}`)).json(),
    ).toMatchObject({ positionMs: 23_000, completedAt: null });
  });

  it('zeroes the position and marks the media heard from 95% (AC-4)', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    await media.owner('PUT', `/api/v1/media/${item.id}/progress`, {
      positionMs: DURATION_MS * 0.95,
      basedOn: null,
    });
    const heard = (await media.owner('GET', `/api/v1/media/${item.id}`)).json();
    expect(heard.positionMs).toBe(0);
    expect(Date.parse(heard.completedAt)).not.toBeNaN();
    // Listening again from the start keeps it heard, with the new position.
    await media.owner('PUT', `/api/v1/media/${item.id}/progress`, {
      positionMs: 10_000,
      basedOn: heard.positionUpdatedAt,
    });
    expect(
      (await media.owner('GET', `/api/v1/media/${item.id}`)).json(),
    ).toMatchObject({ positionMs: 10_000, completedAt: heard.completedAt });
  });

  it('refuses a save based on an older one: another device saved since (FR-3)', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    const url = `/api/v1/media/${item.id}/progress`;
    const laptop = (
      await media.owner('PUT', url, {
        positionMs: 30_000,
        basedOn: null,
      })
    ).json();
    const phone = await media.owner('PUT', url, {
      positionMs: 90_000,
      basedOn: laptop.positionUpdatedAt,
    });
    expect(phone.statusCode).toBe(200);
    // The laptop, still on its first save, comes back with an older position.
    const stale = await media.owner('PUT', url, {
      positionMs: 31_000,
      basedOn: laptop.positionUpdatedAt,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('MEDIA_CONFLICT');
    expect(
      (await media.owner('GET', `/api/v1/media/${item.id}`)).json().positionMs,
    ).toBe(90_000);
    // Never seen a save, while there is one: also refused.
    expect(
      (await media.owner('PUT', url, { positionMs: 1_000, basedOn: null }))
        .statusCode,
    ).toBe(409);
  });

  it('keeps each person’s position apart', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    const listener = await member(media, {
      email: 'ouvinte@example.com',
      topics: ['hermetismo'],
      features: ['search', 'media'],
    });
    await listener.call('PUT', `/api/v1/media/${item.id}/progress`, {
      positionMs: 60_000,
      basedOn: null,
    });
    expect(
      (await media.owner('GET', `/api/v1/media/${item.id}`)).json().positionMs,
    ).toBe(0);
    expect(
      (await listener.call('GET', `/api/v1/media/${item.id}`)).json()
        .positionMs,
    ).toBe(60_000);
  });

  it('answers 404 without access and 400 outside the media (AC-5)', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    const outsider = await member(media, {
      email: 'outro@example.com',
      topics: ['alquimia'],
      features: ['search', 'media'],
    });
    expect(
      (
        await outsider.call('PUT', `/api/v1/media/${item.id}/progress`, {
          positionMs: 1_000,
          basedOn: null,
        })
      ).statusCode,
    ).toBe(404);
    for (const positionMs of [-1, DURATION_MS + 1])
      expect(
        (
          await media.owner('PUT', `/api/v1/media/${item.id}/progress`, {
            positionMs,
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await media.owner(
          'PUT',
          '/api/v1/media/22222222-2222-4222-8222-222222222222/progress',
          { positionMs: 1, basedOn: null },
        )
      ).statusCode,
    ).toBe(404);
  });

  it('has no position for a media that is not ready yet', async () => {
    const media = await startMedia();
    const item = await queuedItem(media);
    const refused = await media.owner(
      'PUT',
      `/api/v1/media/${item.id}/progress`,
      { positionMs: 0, basedOn: null },
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('MEDIA_NOT_READY');
  });

  it('forgets the positions of a removed media', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    await media.owner('PUT', `/api/v1/media/${item.id}/progress`, {
      positionMs: 5_000,
      basedOn: null,
    });
    const rows = () => {
      const db = new DatabaseSync(join(media.mediaDir, 'media.db'), {
        readOnly: true,
      });
      const count = db
        .prepare('SELECT COUNT(*) AS n FROM media_progress WHERE media_id = ?')
        .get(item.id)?.['n'];
      db.close();
      return Number(count);
    };
    expect(rows()).toBe(1);
    expect(
      (await media.owner('DELETE', `/api/v1/media/${item.id}`)).statusCode,
    ).toBe(204);
    expect(rows()).toBe(0);
    expect(
      (
        await media.owner('PUT', `/api/v1/media/${item.id}/progress`, {
          positionMs: 5_000,
          basedOn: null,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('keeps "Destacar palavra a palavra" off through a save of other choices (KBC-045)', async () => {
    const media = await startMedia();
    const off = await media.owner('PUT', '/api/v1/media/preferences', {
      wordHighlight: false,
    });
    expect(off.statusCode).toBe(200);
    const other = await media.owner('PUT', '/api/v1/media/preferences', {
      libraryView: 'grid',
    });
    expect(other.json()).toMatchObject({ wordHighlight: false });
    const read = await media.owner('GET', '/api/v1/media/preferences');
    expect(read.json()).toMatchObject({
      wordHighlight: false,
      libraryView: 'grid',
    });
  });
});
