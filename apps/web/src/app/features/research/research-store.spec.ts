import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ResearchEvent } from '@kb-chat/contracts';
import { AnswersApi } from '@core/api/answers-api.js';
import { SpendStore } from '@core/spend/spend-store.js';
import { UsageLog } from '@core/usage/usage-log.js';
import { ChatStore } from '@features/chat/chat-store.js';
import { ViewStore } from '@features/chat/view-store.js';
import { Subject, of, throwError } from 'rxjs';
import {
  SAVE_RESEARCH,
  type ResearchConversation,
} from './research-history.js';
import { ResearchStore, STOP_SETTLE_MS } from './research-store.js';

const SOURCE = { n: 1, id: 'raw/a.md', title: 'Os Princípios' };

function setup() {
  localStorage.clear();
  const streams: Subject<ResearchEvent>[] = [];
  const spendNow = { usd: 0.1 };
  const api = {
    research: vi.fn(() => {
      const stream = new Subject<ResearchEvent>();
      streams.push(stream);
      return stream;
    }),
    spendToday: vi.fn(() =>
      of({ usd: spendNow.usd, capUsd: 1, configured: true }),
    ),
  };
  const topicSlug = signal<string | null>('hermetismo');
  const chat = {
    topicSlug,
    selectTopic: vi.fn((slug: string) => topicSlug.set(slug)),
  };
  const spend = {
    configured: signal(true),
    usd: signal<number | null>(0.1),
    refresh: vi.fn(),
  };
  const usage = { track: vi.fn() };
  const save = vi.fn<(conversation: ResearchConversation) => void>();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      ResearchStore,
      ViewStore,
      { provide: AnswersApi, useValue: api },
      { provide: ChatStore, useValue: chat },
      { provide: SpendStore, useValue: spend },
      { provide: UsageLog, useValue: usage },
      { provide: SAVE_RESEARCH, useValue: save },
    ],
  });
  const store = TestBed.inject(ResearchStore);
  return { store, api, streams, chat, spend, usage, save, spendNow };
}

function answer(stream: Subject<ResearchEvent>, text: string, usd = 0.002) {
  stream.next({ type: 'step', step: { kind: 'search', text: 'Buscando' } });
  stream.next({ type: 'sources', sources: [SOURCE] });
  stream.next({ type: 'token', text });
  stream.next({
    type: 'done',
    usd,
    billing: 'per-token',
    model: 'm',
    interrupted: false,
    steps: 1,
  });
  stream.complete();
}

describe('ResearchStore', () => {
  it('sends the previous question and answer as history on a follow-up (AC-2)', () => {
    const { store, api, streams } = setup();
    store.ask('quais são os princípios?');
    expect(api.research).toHaveBeenLastCalledWith('hermetismo', {
      question: 'quais são os princípios?',
      history: [],
    });
    answer(streams[0] as Subject<ResearchEvent>, 'São sete [1].');
    store.ask('  e o terceiro?  ');
    expect(api.research).toHaveBeenLastCalledWith('hermetismo', {
      question: 'e o terceiro?',
      history: [
        { question: 'quais são os princípios?', answer: 'São sete [1].' },
      ],
    });
    expect(store.turns().map((turn) => turn.question)).toEqual([
      'quais são os princípios?',
      'e o terceiro?',
    ]);
  });

  it('finishes a turn: logs its cost, refreshes the spend and saves the conversation', () => {
    const { store, streams, usage, spend, save } = setup();
    store.ask('quais são?');
    answer(streams[0] as Subject<ResearchEvent>, 'São sete [1].');
    const turn = store.turns()[0];
    expect(turn?.phase).toBe('done');
    expect(turn?.stepCount).toBe(1);
    expect(usage.track).toHaveBeenCalledWith({ type: 'ai_answer', usd: 0.002 });
    expect(spend.refresh).toHaveBeenCalledExactlyOnceWith(0);
    const saved = save.mock.lastCall?.[0];
    expect(saved).toMatchObject({
      kind: 'research',
      id: store.conversationId(),
      topic: 'hermetismo',
      title: 'quais são?',
      turns: [
        {
          question: 'quais são?',
          answer: 'São sete [1].',
          sources: [SOURCE],
          steps: 1,
          usd: 0.002,
          model: 'm',
          interrupted: false,
        },
      ],
    });
  });

  it('stops the turn in flight on "Parar", keeping the partial text', () => {
    const { store, streams, usage, spend, save } = setup();
    store.ask('quais são?');
    const stream = streams[0] as Subject<ResearchEvent>;
    stream.next({ type: 'token', text: 'Começo' });
    expect(store.streaming()).toBe(true);
    store.stop();
    expect(stream.observed).toBe(false);
    expect(store.turns()[0]).toMatchObject({
      phase: 'done',
      interrupted: true,
      text: 'Começo',
    });
    expect(usage.track).toHaveBeenCalledWith({ type: 'ai_cancel' });
    expect(spend.refresh).toHaveBeenCalledExactlyOnceWith(STOP_SETTLE_MS);
    expect(save).toHaveBeenCalledOnce();
  });

  it('keeps one turn in flight: a new question stops the previous one', () => {
    const { store, streams } = setup();
    store.ask('primeira');
    store.ask('segunda');
    expect(streams[0]?.observed).toBe(false);
    expect(store.turns().map((turn) => turn.phase)).toEqual([
      'done',
      'streaming',
    ]);
  });

  it.each([
    ['DAILY_CAP_REACHED', 'DAILY_CAP_REACHED'],
    ['LLM_INSUFFICIENT_CREDIT', 'LLM_INSUFFICIENT_CREDIT'],
    ['CLI_LOGIN_REQUIRED', 'CLI_LOGIN_REQUIRED'],
    ['PROVIDER_UNAVAILABLE', 'PROVIDER_UNAVAILABLE'],
    ['LLM_KEY_REJECTED', 'LLM_KEY_REJECTED'],
    ['SOMETHING_NEW', 'INTERNAL'],
  ])('maps the stream error %s to %s', (code, expected) => {
    const { store, streams } = setup();
    store.ask('quais são?');
    streams[0]?.next({ type: 'error', code });
    expect(store.turns()[0]).toMatchObject({ phase: 'error', error: expected });
  });

  it('maps a refusal before streaming (409 not configured) and retries in place', () => {
    const { store, api } = setup();
    api.research.mockReturnValueOnce(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 409,
            error: { error: { code: 'LLM_NOT_CONFIGURED', message: 'x' } },
          }),
      ) as never,
    );
    store.ask('quais são?');
    expect(store.turns()[0]?.error).toBe('LLM_NOT_CONFIGURED');
    store.retry();
    expect(store.turns()).toHaveLength(1);
    expect(store.turns()[0]?.phase).toBe('streaming');
  });

  it('treats a finished answer without text, or a stream cut short, as a failure', () => {
    const { store, streams } = setup();
    store.ask('a');
    streams[0]?.next({
      type: 'done',
      usd: 0,
      billing: 'per-token',
      model: 'm',
      interrupted: false,
      steps: 0,
    });
    store.ask('b');
    streams[1]?.complete();
    expect(store.turns().map((turn) => turn.error)).toEqual([
      'INTERNAL',
      'INTERNAL',
    ]);
  });

  it('restores a saved conversation without calling the AI (AC-9)', () => {
    const { store, api, chat } = setup();
    const views = TestBed.inject(ViewStore);
    views.select('search');
    store.restore({
      kind: 'research',
      id: '2b0f4a52-8a8b-4b0e-9a55-0d1b5c2b3c4d',
      topic: 'outro',
      title: 'quais são?',
      createdAt: '2026-10-24T10:00:00.000Z',
      updatedAt: '2026-10-24T10:01:00.000Z',
      turns: [
        {
          question: 'quais são?',
          answer: 'São sete [1].',
          sources: [SOURCE],
          steps: 3,
          usd: 0.01,
          billing: 'per-token',
          model: 'm',
          interrupted: false,
          at: '2026-10-24T10:00:30.000Z',
        },
      ],
    });
    expect(api.research).not.toHaveBeenCalled();
    expect(chat.selectTopic).toHaveBeenCalledWith('outro');
    expect(views.current()).toBe('research');
    expect(store.conversationId()).toBe('2b0f4a52-8a8b-4b0e-9a55-0d1b5c2b3c4d');
    expect(store.turns()[0]).toMatchObject({
      phase: 'done',
      text: 'São sete [1].',
      sources: [SOURCE],
      stepCount: 3,
      restored: true,
    });
  });

  it('starts a new conversation without context, and hides one from another collection', () => {
    const { store, api, streams, chat } = setup();
    store.ask('quais são?');
    answer(streams[0] as Subject<ResearchEvent>, 'São sete [1].');
    const first = store.conversationId();
    store.newConversation();
    expect(store.turns()).toEqual([]);
    expect(store.conversationId()).not.toBe(first);
    store.ask('outra');
    expect(api.research).toHaveBeenLastCalledWith('hermetismo', {
      question: 'outra',
      history: [],
    });
    chat.topicSlug.set('outro');
    expect(store.turns()).toEqual([]);
  });

  it('does not save a conversation with no turn ended yet', () => {
    const { store, save } = setup();
    store.persist();
    store.ask('quais são?');
    expect(save).not.toHaveBeenCalled();
  });

  it('saves a turn stopped before any text, with the model and the cost spent (100% of the history)', () => {
    vi.useFakeTimers();
    try {
      const { store, streams, save, spendNow } = setup();
      store.ask('quais são?');
      const stream = streams[0] as Subject<ResearchEvent>;
      stream.next({ type: 'start', model: 'deepseek/x', billing: 'per-token' });
      stream.next({ type: 'step', step: { kind: 'search', text: 'Buscando' } });
      store.stop();
      expect(save.mock.lastCall?.[0].turns).toEqual([
        expect.objectContaining({
          question: 'quais são?',
          answer: '',
          model: 'deepseek/x',
          interrupted: true,
          usd: 0,
        }),
      ]);
      spendNow.usd = 0.13;
      vi.advanceTimersByTime(STOP_SETTLE_MS);
      expect(save.mock.lastCall?.[0].turns[0]?.usd).toBeCloseTo(0.03, 10);
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks a stopped question again in its place on "Tentar de novo"', () => {
    const { store, api } = setup();
    store.ask('quais são?');
    store.stop();
    store.retry();
    expect(api.research).toHaveBeenCalledTimes(2);
    expect(store.turns()).toHaveLength(1);
    expect(store.streaming()).toBe(true);
  });
});
