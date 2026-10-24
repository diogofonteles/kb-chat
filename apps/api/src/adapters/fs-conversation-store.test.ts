import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  aResearchConversation,
  aSearchConversation,
} from '../../test/conversation-factories.js';
import { FsConversationStore } from './fs-conversation-store.js';
import { MemoryConversationStore } from './memory-conversation-store.js';

function createStore() {
  const root = mkdtempSync(join(tmpdir(), 'kbchat-conversations-'));
  const dir = join(root, 'conversations');
  const log = { warn: vi.fn() };
  return { dir, log, store: new FsConversationStore({ dir, log }) };
}

describe('FsConversationStore', () => {
  it('creates the folder on demand and writes one 0600 file per conversation', async () => {
    const { dir, store } = createStore();
    const conversation = aSearchConversation();
    expect(await store.list('owner')).toEqual([]);
    await store.put('owner', conversation);
    const file = join(dir, `${conversation.id}.json`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o077).toBe(0);
    expect(await store.get('owner', conversation.id)).toEqual(conversation);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      v: 1,
      principal: 'owner',
    });
  });

  it.each([
    ['on disk', () => createStore().store],
    ['in memory', () => new MemoryConversationStore()],
  ])(
    "refuses to save over another person's conversation (%s)",
    async (_where, make) => {
      const store = make();
      const conversation = aSearchConversation();
      expect(await store.put('owner', conversation)).toBe(true);

      expect(
        await store.put('guest', { ...conversation, title: 'tomada' }),
      ).toBe(false);
      expect(await store.get('owner', conversation.id)).toEqual(conversation);
    },
  );

  it('replaces a conversation atomically, leaving no temp file behind', async () => {
    const { dir, store } = createStore();
    const conversation = aSearchConversation();
    await store.put('owner', conversation);
    const updated = { ...conversation, title: 'polaridade' };
    await store.put('owner', updated);
    expect(await readdir(dir)).toEqual([`${conversation.id}.json`]);
    expect(await store.get('owner', conversation.id)).toEqual(updated);
  });

  it('keeps every conversation, both kinds, with no cap', async () => {
    const { store } = createStore();
    const saved = [
      ...Array.from({ length: 60 }, () => aSearchConversation()),
      aResearchConversation(),
    ];
    await Promise.all(saved.map((c) => store.put('owner', c)));
    const listed = await store.list('owner');
    expect(listed).toHaveLength(61);
    expect(listed.filter((c) => c.kind === 'research')).toHaveLength(1);
  });

  it('skips and logs a corrupt, foreign or renamed file instead of failing', async () => {
    const { dir, log, store } = createStore();
    const good = aSearchConversation();
    await store.put('owner', good);
    const corrupt = aSearchConversation().id;
    await writeFile(join(dir, `${corrupt}.json`), '{not json');
    const renamed = aSearchConversation().id;
    const original = await readFile(join(dir, `${good.id}.json`), 'utf8');
    await writeFile(join(dir, `${renamed}.json`), original);
    await mkdir(join(dir, `${aSearchConversation().id}.json`));
    await writeFile(join(dir, 'notes.txt'), 'ignored');
    expect(await store.list('owner')).toEqual([good]);
    expect(await store.get('owner', corrupt)).toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });

  it('refuses ids that are not uuids, so no path leaves the folder', async () => {
    const { store } = createStore();
    await expect(store.get('owner', '../../etc/passwd')).rejects.toThrow(
      /Invalid conversation id/,
    );
    await expect(store.remove('owner', '..')).rejects.toThrow();
    await expect(
      store.put('owner', { ...aSearchConversation(), id: '../x' }),
    ).rejects.toThrow();
  });

  it('only shows and removes the conversations of their principal', async () => {
    const { store } = createStore();
    const conversation = aSearchConversation();
    await store.put('owner', conversation);
    expect(await store.list('guest')).toEqual([]);
    expect(await store.get('guest', conversation.id)).toBeNull();
    expect(await store.remove('guest', conversation.id)).toBe(false);
    expect(await store.remove('owner', conversation.id)).toBe(true);
    expect(await store.remove('owner', conversation.id)).toBe(false);
    expect(await store.list('owner')).toEqual([]);
  });
});

describe('MemoryConversationStore', () => {
  it('keeps conversations per principal', async () => {
    const store = new MemoryConversationStore();
    const conversation = aResearchConversation();
    await store.put('owner', conversation);
    expect(await store.list('owner')).toEqual([conversation]);
    expect(await store.get('guest', conversation.id)).toBeNull();
    expect(await store.remove('guest', conversation.id)).toBe(false);
    expect(await store.remove('owner', conversation.id)).toBe(true);
    expect(await store.get('owner', conversation.id)).toBeNull();
  });
});
