import type { LevelAuditEntry } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import { MemoryDocumentStore } from '../../adapters/memory-document-store.js';
import { MemoryLevelAudit } from '../../adapters/memory-level-audit.js';
import { CatalogRegistry } from '../catalog/index.js';
import { ContentGate } from './content-gate.js';
import { LevelDirectory } from './level-directory.js';
import { LevelHistoryService } from './level-history-service.js';

/*
 * KBC-108 review R2-1: an undone operation is left out of the history whole, the lines of
 * its sub-collections' documents and audios included.
 */

const AT = '2026-11-11T12:00:00.000Z';
const line = (over: Partial<LevelAuditEntry>): LevelAuditEntry => ({
  at: AT,
  by: 'owner@example.com',
  kind: 'item.level',
  collection: 'hermetismo',
  ...over,
});

async function history(entries: readonly LevelAuditEntry[]) {
  const catalog = new CatalogRegistry({
    listTopics: async () => [
      { slug: 'hermetismo', title: 'Hermetismo' },
      { slug: 'hermetismo/aulas', title: 'Aulas', parent: 'hermetismo' },
    ],
    listDocuments: async () => ['raw/a.md'],
    readDocument: async (_topic, id) => `---\ntitle: Doc ${id}\n---\n`,
  });
  await catalog.load();
  const directory = new LevelDirectory({
    scales: new MemoryDocumentStore(),
    documents: new MemoryDocumentStore(),
    presence: new MemoryDocumentStore(),
  });
  await directory.load();
  const audit = new MemoryLevelAudit();
  await audit.appendMany(entries);
  return new LevelHistoryService({
    audit,
    catalog,
    gate: new ContentGate({ directory, catalog }),
    directory,
    people: { list: async () => [] },
  });
}

describe('LevelHistoryService: undone operations (R2-1)', () => {
  it('R3-5: a line of a sub-collection gone from the catalog is left out too', async () => {
    const service = await history([
      line({
        collection: 'hermetismo/antigas',
        target: 'raw/a.md',
        before: 'ci',
        after: 'cdc',
      }),
      line({ kind: 'scale.delete', target: 'ci' }),
      line({ kind: 'scale.undone', target: 'ci' }),
    ]);
    const page = await service.page({});
    expect(page.items).toEqual([]);
  });

  it.each([
    ['a delete', 'scale.delete' as const],
    ['every level taken away', 'scale.clear' as const],
  ])(
    'leaves out %s whole, its sub-collection lines included',
    async (_case, kind) => {
      const service = await history([
        line({ at: '2026-11-10T10:00:00.000Z', target: 'raw/old.md' }),
        line({ target: 'raw/a.md', before: 'ci', after: 'cdc' }),
        line({
          collection: 'hermetismo/aulas',
          target: 'raw/a.md',
          before: 'ci',
          after: 'cdc',
        }),
        line({
          collection: 'hermetismo/aulas',
          target: 'media-1',
          before: 'ci',
          after: 'cdc',
          count: { media: 1 },
        }),
        line({ kind, target: 'ci' }),
        line({ kind: 'scale.undone', target: 'ci' }),
      ]);
      const page = await service.page({ topic: 'hermetismo' });
      expect(page.items.map((one) => one.target)).toEqual(['raw/old.md']);
    },
  );
});
