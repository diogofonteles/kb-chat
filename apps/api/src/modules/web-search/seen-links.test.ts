import { describe, expect, it } from 'vitest';
import { MemoryDocumentStore } from '../../adapters/memory-document-store.js';
import { SeenLinks } from './seen-links.js';

const ana = { principal: 'ana', topic: 'hermetismo' };

describe('SeenLinks (KBC-185)', () => {
  it('remembers each person, each collection, and after a restart', async () => {
    const store = new MemoryDocumentStore();
    const seen = new SeenLinks(store);
    await seen.load();
    await Promise.all([seen.add(ana, ['a', 'b']), seen.add(ana, ['c'])]);
    const again = new SeenLinks(store);
    await again.load();
    expect(['a', 'b', 'c', 'd'].map((key) => again.has(ana, key))).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(again.has({ ...ana, topic: 'udv' }, 'a')).toBe(false);
    expect(again.has({ ...ana, principal: 'beto' }, 'a')).toBe(false);
  });

  it('keeps no address, and nothing new writes nothing', async () => {
    const store = new MemoryDocumentStore();
    const seen = new SeenLinks(store);
    await seen.add(ana, []);
    expect(await store.read()).toBeNull();
    await seen.add(ana, ['a.org:/segredo?']);
    expect(JSON.stringify(await store.read())).not.toContain('segredo');
  });

  it('starts over from a file it cannot read', async () => {
    const store = new MemoryDocumentStore();
    await store.write({ version: 9 });
    const seen = new SeenLinks(store);
    await seen.load();
    expect(seen.has(ana, 'a')).toBe(false);
  });
});
