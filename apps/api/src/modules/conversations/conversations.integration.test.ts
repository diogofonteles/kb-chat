import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Conversation } from '@kb-chat/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  aResearchConversation,
  aSearchConversation,
} from '../../../test/conversation-factories.js';
import { FIXTURE_VAULT } from '../../../test/fixture-paths.js';
import { FsConversationStore } from '../../adapters/fs-conversation-store.js';
import { FsVaultAdapter } from '../../adapters/fs-vault-adapter.js';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { createSearchIndex } from '../../search-index-factory.js';

const HOST = { host: 'localhost:3000' };
const URL = '/api/v1/conversations';
let app: FastifyInstance;

beforeAll(async () => {
  const config = loadConfig({
    KB_VAULT: FIXTURE_VAULT,
    KB_CHAT_SEARCH: 'fixture',
    LOG_LEVEL: 'silent',
  });
  const vault = new FsVaultAdapter(config.KB_VAULT);
  const log = createLogger('silent');
  const index = await createSearchIndex({ config, vault, log });
  const dir = join(mkdtempSync(join(tmpdir(), 'kbchat-api-')), 'conversations');
  const conversations = new FsConversationStore({ dir, log });
  app = await buildApp({ config, vault, index, conversations });
});

afterAll(async () => {
  await app.close();
});

const put = (
  conversation:
    Conversation | (Pick<Conversation, 'id'> & Record<string, unknown>),
  id = conversation.id,
) =>
  app.inject({
    method: 'PUT',
    url: `${URL}/${id}`,
    headers: HOST,
    payload: conversation,
  });
const get = (url: string) => app.inject({ method: 'GET', url, headers: HOST });
const listIds = async (query = '') =>
  get(`${URL}${query}`)
    .then((response) => response.json<{ items: { id: string }[] }>())
    .then(({ items }) => items.map((item) => item.id));

describe('PUT /api/v1/conversations/:id', () => {
  it('saves a conversation and answers with its summary', async () => {
    const conversation = aResearchConversation();
    const response = await put(conversation);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: conversation.id,
      kind: 'research',
      topic: 'hermetismo',
      title: conversation.title,
      updatedAt: conversation.updatedAt,
      count: 1,
    });
    const saved = await get(`${URL}/${conversation.id}`);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual(conversation);
  });

  it('refuses a body whose id differs from the path, or an invalid body', async () => {
    const conversation = aSearchConversation();
    const mismatch = await put(conversation, aSearchConversation().id);
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error.code).toBe('VALIDATION_FAILED');
    const invalid = await put({ ...conversation, asks: [] });
    expect(invalid.statusCode).toBe(400);
  });
});

describe('GET /api/v1/conversations', () => {
  it('lists every conversation newest first, filtered by kind and topic', async () => {
    const older = aSearchConversation({
      updatedAt: '2026-10-20T10:00:00.000Z',
    });
    const newer = aSearchConversation({
      topic: 'alquimia',
      updatedAt: '2026-10-25T10:00:00.000Z',
    });
    const research = aResearchConversation({
      updatedAt: '2026-10-22T10:00:00.000Z',
    });
    for (const conversation of [older, newer, research])
      await put(conversation);
    const ids = await listIds();
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(research.id));
    expect(ids.indexOf(research.id)).toBeLessThan(ids.indexOf(older.id));
    expect(await listIds('?kind=search&topic=alquimia')).toEqual([newer.id]);
    expect(await listIds('?kind=research')).toContain(research.id);
    expect((await get(`${URL}?kind=chat`)).statusCode).toBe(400);
  });

  it('keeps more than 50 conversations (no cap)', async () => {
    const saved = Array.from({ length: 60 }, () => aSearchConversation());
    for (const conversation of saved) await put(conversation);
    expect(await listIds()).toEqual(
      expect.arrayContaining(saved.map((c) => c.id)),
    );
  });
});

describe('GET and DELETE /api/v1/conversations/:id', () => {
  it('answers 404 for an unknown conversation and 400 for an id that is not a uuid', async () => {
    const missing = await get(`${URL}/${aSearchConversation().id}`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('NOT_FOUND');
    const traversal = await get(`${URL}/..%2F..%2Fetc%2Fpasswd`);
    expect(traversal.statusCode).toBe(400);
  });

  it('removes a conversation, and removing it again is still 204', async () => {
    const conversation = aSearchConversation();
    await put(conversation);
    const remove = () =>
      app.inject({
        method: 'DELETE',
        url: `${URL}/${conversation.id}`,
        headers: HOST,
      });
    expect((await remove()).statusCode).toBe(204);
    expect((await remove()).statusCode).toBe(204);
    expect((await get(`${URL}/${conversation.id}`)).statusCode).toBe(404);
    expect(await listIds()).not.toContain(conversation.id);
  });
});
