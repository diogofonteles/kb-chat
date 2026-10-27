import {
  EMPTY_FILTERS,
  type Conversation,
  type ResearchConversation,
  type SavedResearchTurn,
} from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import { MemoryConversationStore } from '../../adapters/memory-conversation-store.js';
import { ConversationsService } from './conversations-service.js';

const BOOT = Date.parse('2026-10-27T12:00:00.000Z');
const CONVERSATION = '6f1c2b9b-8a11-4d0a-9d55-0b6f1f0e6a3e';
const T1 = '0b9d7c1e-3f2a-4c5b-8d6e-7f8091a2b3c4';
const T2 = '1c8e6d2f-4a3b-4d6c-9e7f-8091a2b3c4d5';
const iso = (ms: number) => new Date(ms).toISOString();

const turn = (
  overrides: Partial<SavedResearchTurn> = {},
): SavedResearchTurn => ({
  id: T1,
  question: 'lei do ritmo',
  answer: 'Tudo flui [1].',
  sources: [],
  steps: 2,
  usd: 0.001,
  billing: 'per-token',
  model: 'stub/model',
  interrupted: false,
  at: iso(BOOT + 1000),
  ...overrides,
});

const pending = (overrides: Partial<SavedResearchTurn> = {}) =>
  turn({ answer: '', status: 'pending', ...overrides });

const conversation = (
  turns: SavedResearchTurn[],
  overrides: Partial<ResearchConversation> = {},
): ResearchConversation => ({
  kind: 'research',
  id: CONVERSATION,
  topic: 'hermetismo',
  title: 'lei do ritmo',
  createdAt: iso(BOOT),
  updatedAt: iso(BOOT),
  turns,
  ...overrides,
});

function setup(options: { live?: string[]; now?: number } = {}) {
  const store = new MemoryConversationStore();
  const live = new Set(options.live ?? []);
  const clock = { now: options.now ?? BOOT + 5000 };
  const service = new ConversationsService({
    store,
    isLive: (principal, turnId) => principal === 'ana' && live.has(turnId),
    bootAt: BOOT,
    now: () => clock.now,
  });
  return { store, service, live, clock };
}

const turnsOf = (saved: Conversation | null) =>
  saved?.kind === 'research' ? saved.turns : [];

describe('ConversationsService.beginTurn (KBC-029)', () => {
  it('creates the conversation with the question as title and the pending turn', async () => {
    const { service } = setup({ live: [T1] });
    await service.beginTurn('ana', {
      conversationId: CONVERSATION,
      topic: 'hermetismo',
      turn: pending({ question: 'quais são os 5 princípios' }),
    });
    const saved = await service.get('ana', CONVERSATION);
    expect(saved).toMatchObject({
      kind: 'research',
      title: 'quais são os 5 princípios',
      topic: 'hermetismo',
    });
    expect(turnsOf(saved)).toEqual([
      pending({ question: 'quais são os 5 princípios' }),
    ]);
    expect((await service.list('ana'))[0]?.status).toBe('pending');
  });

  it('adds a follow-up as a pending turn and keeps the title; a retry replaces its turn', async () => {
    const { service, store } = setup({ live: [T2] });
    await store.put('ana', conversation([turn()]));
    const begin = (t: SavedResearchTurn) =>
      service.beginTurn('ana', {
        conversationId: CONVERSATION,
        topic: 'hermetismo',
        turn: t,
      });
    await begin(pending({ id: T2, question: 'e a polaridade?' }));
    await service.finishTurn(
      'ana',
      CONVERSATION,
      turn({ id: T2, status: 'failed', error: 'INTERNAL', answer: '' }),
    );
    await begin(pending({ id: T2, question: 'e a polaridade?' }));
    const saved = await service.get('ana', CONVERSATION);
    expect(saved?.title).toBe('lei do ritmo');
    expect(turnsOf(saved).map((t) => [t.id, t.status])).toEqual([
      [T1, undefined],
      [T2, 'pending'],
    ]);
  });

  it('refuses another person’s conversation, a search one or one of another collection', async () => {
    const { service, store } = setup();
    await store.put('bia', conversation([turn()]));
    const begin = (principal: string, topic = 'hermetismo') =>
      service.beginTurn(principal, {
        conversationId: CONVERSATION,
        topic,
        turn: pending({ id: T2 }),
      });
    await expect(begin('ana')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(begin('bia', 'alquimia')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await store.put('bia', {
      kind: 'search',
      id: CONVERSATION,
      topic: 'hermetismo',
      title: 'x',
      createdAt: iso(BOOT),
      updatedAt: iso(BOOT),
      asks: [{ question: 'x', mode: 'all', filters: EMPTY_FILTERS, total: 1 }],
    });
    await expect(begin('bia')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('ConversationsService.finishTurn (KBC-029)', () => {
  it('replaces the pending turn with the outcome and moves the conversation up', async () => {
    const { service, store, clock } = setup();
    await store.put('ana', conversation([pending()]));
    clock.now = BOOT + 60_000;
    await service.finishTurn('ana', CONVERSATION, turn());
    const saved = await service.get('ana', CONVERSATION);
    expect(turnsOf(saved)).toEqual([turn()]);
    expect(saved?.updatedAt).toBe(iso(BOOT + 60_000));
  });

  it('ignores the outcome of an earlier attempt of a turn that was asked again (QA BUG-2)', async () => {
    const { service, store } = setup();
    const retried = pending({ at: iso(BOOT + 9000) });
    await store.put('ana', conversation([retried]));
    await service.finishTurn(
      'ana',
      CONVERSATION,
      turn({ interrupted: true, at: iso(BOOT + 1000) }),
    );
    expect(turnsOf(await store.get('ana', CONVERSATION))).toEqual([retried]);
  });

  it('does not bring back a conversation the person removed meanwhile', async () => {
    const { service } = setup();
    await service.finishTurn('ana', CONVERSATION, turn());
    expect(await service.get('ana', CONVERSATION)).toBeNull();
  });
});

describe('reading pending turns (KBC-029)', () => {
  it('keeps a turn that runs as pending, and reads one from before the restart as interrupted', async () => {
    const { service, store } = setup({ live: [T2] });
    await store.put(
      'ana',
      conversation([
        pending({ at: iso(BOOT - 1000), answer: '' }),
        pending({ id: T2 }),
      ]),
    );
    const [restarted, running] = turnsOf(
      await service.get('ana', CONVERSATION),
    );
    expect(restarted).toMatchObject({ interrupted: true });
    expect(restarted).not.toHaveProperty('status');
    expect(running?.status).toBe('pending');
    expect((await service.list('ana'))[0]?.status).toBe('pending');
  });

  it('reads a pending turn that is not running as pending only for a short grace', async () => {
    const { service, store, clock } = setup();
    await store.put('ana', conversation([pending({ at: iso(BOOT + 1000) })]));
    clock.now = BOOT + 1000 + 30_000;
    expect((await service.list('ana'))[0]?.status).toBe('pending');
    clock.now = BOOT + 1000 + 3 * 60_000;
    expect((await service.list('ana'))[0]?.status).toBe('interrupted');
  });

  it('reads a turn older than the ceiling as interrupted even if it still shows as live', async () => {
    const { service, store, clock } = setup({ live: [T1] });
    await store.put('ana', conversation([pending()]));
    clock.now = BOOT + 1000 + 61 * 60_000;
    expect((await service.list('ana'))[0]?.status).toBe('interrupted');
  });

  it('never writes on read', async () => {
    const { service, store } = setup();
    await store.put('ana', conversation([pending({ at: iso(BOOT - 1) })]));
    await service.get('ana', CONVERSATION);
    expect(turnsOf(await store.get('ana', CONVERSATION))[0]?.status).toBe(
      'pending',
    );
  });
});

describe('ConversationsService.save merges research turns by id (KBC-029)', () => {
  it('never lets a pending snapshot overwrite a finished turn', async () => {
    const { service, store } = setup();
    await store.put('ana', conversation([turn()]));
    await service.save('ana', conversation([pending()]));
    expect(turnsOf(await store.get('ana', CONVERSATION))).toEqual([turn()]);
  });

  it('keeps turns the server recorded that a snapshot does not have yet', async () => {
    const { service, store } = setup();
    const recorded = turn({
      id: T2,
      question: 'e a polaridade?',
      at: iso(BOOT + 2000),
    });
    await store.put('ana', conversation([turn(), recorded]));
    await service.save('ana', conversation([turn({ usd: 0.002 })]));
    expect(turnsOf(await store.get('ana', CONVERSATION))).toEqual([
      turn({ usd: 0.002 }),
      recorded,
    ]);
  });

  it('takes the snapshot of a finished turn (a stop priced afterwards)', async () => {
    const { service, store } = setup();
    await store.put('ana', conversation([turn({ interrupted: true, usd: 0 })]));
    await service.save(
      'ana',
      conversation([turn({ interrupted: true, usd: 0.003 })]),
    );
    expect(turnsOf(await store.get('ana', CONVERSATION))[0]?.usd).toBe(0.003);
  });

  it('keeps older turns without ids as the snapshot sends them', async () => {
    const { service, store } = setup();
    const legacy = turn();
    delete legacy.id;
    await store.put('ana', conversation([legacy]));
    await service.save('ana', conversation([legacy, turn({ id: T2 })]));
    expect(turnsOf(await store.get('ana', CONVERSATION))).toHaveLength(2);
  });
});
