import { describe, expect, it } from 'vitest';
import { MemoryDocumentStore } from '../../adapters/memory-document-store.js';
import { LevelDirectory } from './level-directory.js';

const level = (id: string) => ({
  id,
  code: 'X',
  description: '',
  createdBy: 'owner@example.com',
  createdAt: '2026-11-09T00:00:00.000Z',
});

describe('LevelDirectory (KBC-103 QA-3)', () => {
  it('loads a scale whose ids an older version wrote too long, instead of failing the start', async () => {
    const scales = new MemoryDocumentStore();
    const long = 'plus-'.repeat(11) + 'plus';
    await scales.write({
      version: 1,
      scales: { hermetismo: [level('qs'), level(long)] },
    });
    const directory = new LevelDirectory({
      scales,
      documents: new MemoryDocumentStore(),
      presence: new MemoryDocumentStore(),
    });
    await directory.load();
    expect(directory.scaleOf('hermetismo').map((one) => one.id)).toEqual([
      'qs',
      long,
    ]);
    await directory.changeScale('hermetismo', (current) => ({
      next: [...current, level('ci')],
      result: undefined,
    }));
    expect(directory.scaleOf('hermetismo')).toHaveLength(3);
  });

  it('refuses to write a level id outside the schema, leaving the file as it was', async () => {
    const scales = new MemoryDocumentStore();
    const directory = new LevelDirectory({
      scales,
      documents: new MemoryDocumentStore(),
      presence: new MemoryDocumentStore(),
    });
    await directory.load();
    await expect(
      directory.changeScale('hermetismo', () => ({
        next: [level('x'.repeat(41))],
        result: undefined,
      })),
    ).rejects.toThrow();
    expect(directory.scaleOf('hermetismo')).toEqual([]);
    expect(await scales.read()).toBeNull();
  });
});
