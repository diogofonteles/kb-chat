import { describe, expect, it, vi } from 'vitest';
import type { LevelAuditPort } from './ports/level-audit.js';
import { openMediaDatabase } from './adapters/sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from './adapters/sqlite/media-migrations.js';
import { SqliteMediaStore } from './adapters/sqlite/sqlite-media-store.js';
import { MediaEditService } from './modules/media/media-edit-service.js';
import type { MediaActor } from './modules/media/media-service.js';

const MASTER: MediaActor = {
  principal: 'owner',
  isMaster: true,
  canUpload: true,
  canSee: () => true,
  levelsIn: () => null,
};

const QS_CI = [
  { id: 'qs', code: 'QS' },
  { id: 'ci', code: 'CI' },
];

function world(audit?: LevelAuditPort) {
  const store = new SqliteMediaStore(
    openMediaDatabase(':memory:', MEDIA_MIGRATIONS),
  );
  const media = store.createMedia({
    id: 'm1',
    topic: 'hermetismo',
    title: 'Palestra',
    author: null,
    legacyAuthorship: 'outros-autores',
    ownerPrincipal: 'owner',
    fileName: 'a.mp3',
    uploadBytes: 1,
    level: 'ci',
    now: new Date('2026-11-10T12:00:00.000Z'),
  });
  const log = { error: vi.fn() };
  const service = new MediaEditService({
    store,
    speakers: {
      labelled: () => [],
      rehome: ({ alongside }) => alongside(),
    },
    hasTopic: () => true,
    rootOf: (topic) => topic,
    authorOf: () => null,
    levels: { scaleOf: () => QS_CI },
    ...(audit && { audit }),
    log,
  });
  return { store, service, log, id: media.id };
}

describe('MediaEditService: a level change and its audit (KBC-105, ADR 0036 §11)', () => {
  it('says in the log what changed when the audit cannot record it, and fails the request', async () => {
    const failing: LevelAuditPort = {
      append: () => Promise.reject(new Error('disk full')),
      appendMany: () => Promise.reject(new Error('disk full')),
      read: () => Promise.resolve({ entries: [], next: null }),
      scaleLines: () => Promise.resolve([]),
    };
    const { service, log, id } = world(failing);

    await expect(
      service.edit({ actor: MASTER, mediaId: id }, { level: 'qs' }),
    ).rejects.toThrow('disk full');

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaId: id,
        before: 'ci',
        after: 'qs',
        tracks: 0,
      }),
      'media level changed but not audited',
    );
  });

  it('changes nothing when no audit could record a level change', async () => {
    const { service, store, id } = world();

    await expect(
      service.edit({ actor: MASTER, mediaId: id }, { level: 'qs' }),
    ).rejects.toThrow('no audit');

    expect(store.getMedia(id)?.level).toBe('ci');
  });

  it('needs no audit for an edit that keeps the level', async () => {
    const { service, store, id } = world();

    await service.edit({ actor: MASTER, mediaId: id }, { title: 'Outro' });

    expect(store.getMedia(id)).toMatchObject({ title: 'Outro', level: 'ci' });
  });
});
