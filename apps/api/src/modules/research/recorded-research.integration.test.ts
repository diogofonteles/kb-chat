import { randomUUID } from 'node:crypto';
import {
  conversationListSchema,
  conversationSchema,
  researchEventSchema,
  type Conversation,
  type ResearchEvent,
  type SavedResearchTurn,
} from '@kb-chat/contracts';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestAuth, signInAs } from '../../../test/auth-factories.js';
import { FIXTURE_VAULT } from '../../../test/fixture-paths.js';
import { FsVaultAdapter } from '../../adapters/fs-vault-adapter.js';
import { MemoryConversationStore } from '../../adapters/memory-conversation-store.js';
import {
  STUB_FAIL_MARKER,
  STUB_SLOW_MARKER,
  StubLlmAdapter,
} from '../../adapters/stub-llm-adapter.js';
import { OWNER, buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { createSearchIndex } from '../../search-index-factory.js';

/**
 * KBC-029 over a listening server: a recorded research turn is saved as it starts, runs on
 * when its page goes away, can be followed again and stopped, and lands in the history.
 */
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface Client {
  readonly base: string;
  readonly headers: Record<string, string>;
}

async function start() {
  const config = loadConfig({
    KB_VAULT: FIXTURE_VAULT,
    KB_CHAT_SEARCH: 'fixture',
    LOG_LEVEL: 'silent',
    ALLOWED_HOSTS: '127.0.0.1',
  });
  const vault = new FsVaultAdapter(config.KB_VAULT);
  const log = createLogger('silent');
  const index = await createSearchIndex({ config, vault, log });
  const auth = createTestAuth();
  const store = new MemoryConversationStore();
  const server = await buildApp({
    config,
    vault,
    index,
    auth,
    llm: new StubLlmAdapter(),
    conversations: store,
    logger: log,
  });
  app = server;
  const base = await server.listen({ host: '127.0.0.1', port: 0 });
  const ana: Client = { base, headers: (await signInAs(auth)).headers };
  return { ana, auth, store, base };
}

/** A second person with every feature (a master), to prove the isolation. */
async function another(auth: ReturnType<typeof createTestAuth>, base: string) {
  const { headers } = await signInAs(auth, 'bia@example.com');
  const bia = (await auth.people.list()).find(
    (p) => p.email === 'bia@example.com',
  );
  if (!bia) throw new Error('bia was not invited');
  await auth.people.update(bia.id, { role: 'master' }, 'owner@example.com');
  return { base, headers } satisfies Client;
}

const call = (client: Client, path: string, init: RequestInit = {}) =>
  fetch(`${client.base}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...client.headers,
      ...(init.headers as Record<string, string> | undefined),
    },
  });

const ask = (
  client: Client,
  body: Record<string, unknown>,
  signal?: AbortSignal,
) =>
  call(client, '/api/v1/topics/hermetismo/research', {
    method: 'POST',
    body: JSON.stringify(body),
    signal: signal ?? null,
  });

const eventsOf = (text: string): ResearchEvent[] =>
  text
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => researchEventSchema.parse(JSON.parse(block.slice(6))));

async function saved(client: Client, id: string): Promise<Conversation> {
  const response = await call(client, `/api/v1/conversations/${id}`);
  return conversationSchema.parse(await response.json());
}

const lastTurn = async (client: Client, id: string) => {
  const conversation = await saved(client, id);
  return conversation.kind === 'research'
    ? conversation.turns.at(-1)
    : undefined;
};

/** Waits for the turn to leave "pending" (the agent runs on its own). */
async function settled(client: Client, id: string): Promise<SavedResearchTurn> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const turn = await lastTurn(client, id);
    if (turn && turn.status !== 'pending') return turn;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the turn never settled');
}

/** The history's list, as summaries. */
async function listed(client: Client) {
  const response = await call(client, '/api/v1/conversations');
  return conversationListSchema.parse(await response.json()).items;
}

const ids = () => ({ conversationId: randomUUID(), turnId: randomUUID() });

// A slow stub turn takes a few seconds (four calls of STUB_SLOW_CALL_MS).
describe('recorded research turns (KBC-029)', { timeout: 20_000 }, () => {
  it('saves the conversation as the question is sent, then the answer when it ends', async () => {
    const { ana } = await start();
    const { conversationId, turnId } = ids();
    const question = `natureza sétupla ${STUB_SLOW_MARKER}`;
    const response = await ask(ana, { question, conversationId, turnId });
    const reader = response.body?.getReader();
    await reader?.read();
    expect(await listed(ana)).toEqual([
      expect.objectContaining({
        id: conversationId,
        title: question,
        count: 1,
        status: 'pending',
      }),
    ]);
    while (!(await reader?.read())?.done);
    const turn = await settled(ana, conversationId);
    expect(turn).toMatchObject({ id: turnId, question, interrupted: false });
    expect(turn.answer).toMatch(/Segundo o acervo/);
    expect(turn.status).toBeUndefined();
  });

  it('runs on when the page goes away, and a page that comes back follows it to the end', async () => {
    const { ana } = await start();
    const { conversationId, turnId } = ids();
    const page = new AbortController();
    const response = await ask(
      ana,
      { question: `ritmo ${STUB_SLOW_MARKER}`, conversationId, turnId },
      page.signal,
    );
    await response.body?.getReader().read();
    page.abort();
    const followed = await call(ana, `/api/v1/research/turns/${turnId}/events`);
    expect(followed.status).toBe(200);
    const events = eventsOf(await followed.text());
    expect(events[0]?.type).toBe('start');
    expect(events.at(-1)).toMatchObject({ type: 'done', interrupted: false });
    expect((await settled(ana, conversationId)).answer).toMatch(/Segundo/);
    const gone = await call(ana, `/api/v1/research/turns/${turnId}/events`);
    expect(gone.status).toBe(404);
  });

  it('"Parar" stops the turn, which is saved as interrupted', async () => {
    const { ana } = await start();
    const { conversationId, turnId } = ids();
    const response = await ask(ana, {
      question: `ritmo ${STUB_SLOW_MARKER}`,
      conversationId,
      turnId,
    });
    await response.body?.getReader().read();
    const stop = await call(ana, `/api/v1/research/turns/${turnId}/stop`, {
      method: 'POST',
      body: '{}',
    });
    expect(stop.status).toBe(204);
    expect(await settled(ana, conversationId)).toMatchObject({
      interrupted: true,
    });
    const again = await call(ana, `/api/v1/research/turns/${turnId}/stop`, {
      method: 'POST',
      body: '{}',
    });
    expect(again.status).toBe(204);
  });

  it('saves a failed turn as failed, and a follow-up next to the first turn', async () => {
    const { ana } = await start();
    const { conversationId, turnId } = ids();
    await (
      await ask(ana, { question: 'ritmo', conversationId, turnId })
    ).text();
    const second = randomUUID();
    const failed = await ask(ana, {
      question: `polaridade ${STUB_FAIL_MARKER}`,
      conversationId,
      turnId: second,
    });
    expect(eventsOf(await failed.text()).at(-1)).toEqual({
      type: 'error',
      code: 'INTERNAL',
    });
    const conversation = await saved(ana, conversationId);
    expect(conversation).toMatchObject({ title: 'ritmo' });
    const turns = conversation.kind === 'research' ? conversation.turns : [];
    expect(turns.map((t) => [t.id, t.status, t.error])).toEqual([
      [turnId, undefined, undefined],
      [second, 'failed', 'INTERNAL'],
    ]);
  });

  it('keeps each person to their own turns and conversations', async () => {
    const { ana, auth, base } = await start();
    const bia = await another(auth, base);
    const { conversationId, turnId } = ids();
    const response = await ask(ana, {
      question: `ritmo ${STUB_SLOW_MARKER}`,
      conversationId,
      turnId,
    });
    await response.body?.getReader().read();
    const follow = await call(bia, `/api/v1/research/turns/${turnId}/events`);
    expect(follow.status).toBe(404);
    await call(bia, `/api/v1/research/turns/${turnId}/stop`, {
      method: 'POST',
      body: '{}',
    });
    const hijack = await ask(bia, {
      question: 'ritmo',
      conversationId,
      turnId: randomUUID(),
    });
    expect(hijack.status).toBe(404);
    expect(await listed(bia)).toEqual([]);
    expect(await settled(ana, conversationId)).toMatchObject({
      interrupted: false,
    });
  });

  it('does not record a request without ids, and refuses half a pair', async () => {
    const { ana } = await start();
    await (await ask(ana, { question: 'ritmo' })).text();
    expect(await listed(ana)).toEqual([]);
    const half = await ask(ana, { question: 'ritmo', turnId: randomUUID() });
    expect(half.status).toBe(400);
  });

  it('a pending turn left by a restart reads as interrupted', async () => {
    const { ana, store } = await start();
    const { conversationId, turnId } = ids();
    await store.put(OWNER, {
      kind: 'research',
      id: conversationId,
      topic: 'hermetismo',
      title: 'ritmo',
      createdAt: '2026-10-01T10:00:00.000Z',
      updatedAt: '2026-10-01T10:00:00.000Z',
      turns: [
        {
          id: turnId,
          question: 'ritmo',
          answer: '',
          sources: [],
          steps: 0,
          usd: 0,
          billing: 'per-token',
          model: '',
          interrupted: false,
          status: 'pending',
          at: '2026-10-01T10:00:00.000Z',
        },
      ],
    });
    const items = await listed(ana);
    expect(items.find((item) => item.id === conversationId)?.status).toBe(
      'interrupted',
    );
  });
});
