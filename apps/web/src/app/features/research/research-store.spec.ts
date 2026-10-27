import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type {
  ResearchEvent,
  SavedResearchTurn,
  SweepCoverage,
  SweepCursor,
  SweepProgress,
} from '@kb-chat/contracts';
import { ResearchApi } from '@core/api/research-api.js';
import { SpendStore } from '@core/spend/spend-store.js';
import { UsageLog } from '@core/usage/usage-log.js';
import { ChatStore } from '@features/chat/chat-store.js';
import { ViewStore } from '@features/chat/view-store.js';
import { Subject, of, throwError } from 'rxjs';
import {
  LOAD_CONVERSATION,
  SAVE_RESEARCH,
  type ResearchConversation,
} from './research-history.js';
import {
  OPEN_RESEARCH_KEY,
  ResearchStore,
  STOP_SETTLE_MS,
} from './research-store.js';
import { citedSources } from './research-turn.js';

const SOURCE = { n: 1, id: 'raw/a.md', title: 'Os Princípios' };

const CURSOR: SweepCursor = {
  plan: {
    target: { authorship: 'mestre-laercio' },
    phrases: [],
    extract: 'livros',
  },
  after: 'raw/c.md',
  totals: { documents: 10, scanned: 3, withHits: null, read: 3, batches: 1 },
  findings: [],
};
const PROGRESS: SweepProgress = {
  status: 'running',
  documents: 10,
  needed: 10,
  documentsDone: 3,
  batches: 4,
  batchesDone: 1,
  requests: 6,
  free: true,
  cursor: CURSOR,
};
const COVERAGE: SweepCoverage = {
  target: { authorship: 'mestre-laercio' },
  phrases: [],
  documents: 10,
  scanned: 3,
  withHits: null,
  read: 3,
  needed: 10,
  missing: 7,
  batches: 1,
  reason: 'requests',
};

function setup(options: { stored?: ResearchConversation } = {}) {
  localStorage.clear();
  const streams: Subject<ResearchEvent>[] = [];
  const follows: Subject<ResearchEvent>[] = [];
  const spendNow = { usd: 0.1 };
  const api = {
    research: vi.fn(() => {
      const stream = new Subject<ResearchEvent>();
      streams.push(stream);
      return stream;
    }),
    follow: vi.fn(() => {
      const stream = new Subject<ResearchEvent>();
      follows.push(stream);
      return stream;
    }),
    stopTurn: vi.fn(() => of(undefined)),
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
  const load = vi.fn((id: string) =>
    options.stored?.id === id
      ? of(options.stored)
      : throwError(() => new HttpErrorResponse({ status: 404 })),
  );
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      ResearchStore,
      ViewStore,
      { provide: ResearchApi, useValue: api },
      { provide: ChatStore, useValue: chat },
      { provide: SpendStore, useValue: spend },
      { provide: UsageLog, useValue: usage },
      { provide: SAVE_RESEARCH, useValue: save },
      { provide: LOAD_CONVERSATION, useValue: load },
    ],
  });
  const store = TestBed.inject(ResearchStore);
  return {
    store,
    api,
    streams,
    follows,
    chat,
    spend,
    usage,
    save,
    load,
    spendNow,
  };
}

function answer(stream: Subject<ResearchEvent>, text: string, usd = 0.002) {
  stream.next({ type: 'step', step: { kind: 'search', text: 'Buscando' } });
  stream.next({ type: 'sources', sources: [SOURCE] });
  stream.next({ type: 'token', text, segment: 0 });
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
  it('sends the profile picked in the composer and remembers it in this browser (KBC-011)', () => {
    const { store, api } = setup();
    expect(store.profile()).toBe('fast');
    store.chooseProfile('deep');
    store.ask('quais são os 5 princípios ocultos');
    expect(api.research).toHaveBeenLastCalledWith(
      'hermetismo',
      expect.objectContaining({
        question: 'quais são os 5 princípios ocultos',
        history: [],
        profile: 'deep',
      }),
    );
    expect(localStorage.getItem('kb-chat.research-profile')).toBe('deep');
  });

  it('saves and restores that a turn went on with the deep research (ADR 0009)', () => {
    const { store, streams, save } = setup();
    store.ask('quais são os 5 princípios ocultos');
    const stream = streams[0] as Subject<ResearchEvent>;
    stream.next({
      type: 'step',
      step: { kind: 'deepen', text: 'Aprofundando a pesquisa…' },
    });
    stream.next({ type: 'token', text: 'São cinco [1].', segment: 1 });
    stream.next({
      type: 'done',
      usd: 0,
      billing: 'subscription',
      model: 'claude-opus-5-5',
      interrupted: false,
      steps: 9,
      escalated: true,
    });
    const saved = save.mock.lastCall?.[0];
    expect(saved?.turns[0]).toMatchObject({ escalated: true, steps: 9 });
    if (saved) store.restore(saved);
    expect(store.turns()[0]).toMatchObject({ escalated: true, restored: true });
  });

  it('saves the profile of each turn and cites sources numbered past 99 (KBC-017 AC-14)', () => {
    const { store, streams, save } = setup();
    store.chooseProfile('exhaustive');
    store.ask('todas as obras citadas por José Laércio do Egito');
    const stream = streams[0] as Subject<ResearchEvent>;
    stream.next({
      type: 'sources',
      sources: [{ n: 123, id: 'raw/a.md', title: 'Obra A' }],
    });
    stream.next({ type: 'token', text: 'A Obra A [123].', segment: 0 });
    stream.next({
      type: 'done',
      usd: 0,
      billing: 'subscription',
      model: 'opus',
      interrupted: false,
      steps: 42,
    });
    const saved = save.mock.lastCall?.[0];
    expect(saved?.turns[0]).toMatchObject({ profile: 'exhaustive', steps: 42 });
    const turn = store.turns()[0];
    expect(turn && citedSources(turn).map((s) => s.n)).toEqual([123]);
    if (saved) store.restore(saved);
    expect(store.turns()[0]).toMatchObject({ profile: 'exhaustive' });
  });

  it('moves a retracted segment out of the answer into the steps as a thought (ADR 0009)', () => {
    const { store, streams, save } = setup();
    store.ask('ritmo');
    const stream = streams[0] as Subject<ResearchEvent>;
    stream.next({ type: 'token', text: 'Os textos são ', segment: 0 });
    stream.next({ type: 'token', text: 'dois.', segment: 0 });
    expect(store.turns()[0]?.text).toBe('Os textos são dois.');
    stream.next({ type: 'retract', segment: 0 });
    stream.next({ type: 'retract', segment: 7 });
    stream.next({ type: 'step', step: { kind: 'read', text: 'Lendo “A”' } });
    answer(stream, 'O ritmo é uma lei [1].');
    const turn = store.turns()[0];
    expect(turn?.text).toBe('O ritmo é uma lei [1].');
    expect(turn?.steps.slice(0, 2)).toEqual([
      { kind: 'thought', text: 'Os textos são dois.' },
      { kind: 'read', text: 'Lendo “A”' },
    ]);
    // Saved turns keep only the answer text.
    expect(save.mock.lastCall?.[0].turns[0]?.answer).toBe(
      'O ritmo é uma lei [1].',
    );
  });

  it('sends the previous question and answer as history on a follow-up (AC-2)', () => {
    const { store, api, streams } = setup();
    store.ask('quais são os princípios?');
    expect(api.research).toHaveBeenLastCalledWith(
      'hermetismo',
      expect.objectContaining({
        question: 'quais são os princípios?',
        history: [],
        profile: 'fast',
      }),
    );
    answer(streams[0] as Subject<ResearchEvent>, 'São sete [1].');
    store.ask('  e o terceiro?  ');
    expect(api.research).toHaveBeenLastCalledWith(
      'hermetismo',
      expect.objectContaining({
        question: 'e o terceiro?',
        history: [
          { question: 'quais são os princípios?', answer: 'São sete [1].' },
        ],
        profile: 'fast',
      }),
    );
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
    const { store, api, streams, usage, spend, save } = setup();
    store.ask('quais são?');
    const stream = streams[0] as Subject<ResearchEvent>;
    stream.next({ type: 'token', text: 'Começo', segment: 0 });
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
    // Saved when asked, then when stopped; the server is told to stop the turn (KBC-029).
    expect(save).toHaveBeenCalledTimes(2);
    expect(api.stopTurn).toHaveBeenCalledExactlyOnceWith(
      store.turns()[0]?.turnId,
    );
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
    ['CLI_MISSING', 'CLI_MISSING'],
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
    expect(api.research).toHaveBeenLastCalledWith(
      'hermetismo',
      expect.objectContaining({ question: 'outra', history: [] }),
    );
    chat.topicSlug.set('outro');
    expect(store.turns()).toEqual([]);
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

  describe('KBC-029: the question is in the history from the moment it is sent', () => {
    const CONVERSATION = '2b0f4a52-8a8b-4b0e-9a55-0d1b5c2b3c4d';
    const TURN = '0b9d7c1e-3f2a-4c5b-8d6e-7f8091a2b3c4';

    const savedTurn = (overrides: Partial<SavedResearchTurn> = {}) => ({
      id: TURN,
      question: 'e a polaridade?',
      answer: '',
      sources: [],
      steps: 0,
      usd: 0,
      billing: 'per-token' as const,
      model: '',
      interrupted: false,
      status: 'pending' as const,
      at: '2026-10-27T10:00:00.000Z',
      ...overrides,
    });

    const conversation = (
      turns: SavedResearchTurn[],
    ): ResearchConversation => ({
      kind: 'research',
      id: CONVERSATION,
      topic: 'hermetismo',
      title: 'lei do ritmo',
      createdAt: '2026-10-27T09:00:00.000Z',
      updatedAt: '2026-10-27T10:00:00.000Z',
      turns,
    });

    afterEach(() => sessionStorage.clear());

    it('saves the conversation with the pending question and sends its ids', () => {
      const { store, api, save } = setup();
      store.ask('quais são?');
      const turnId = store.turns()[0]?.turnId;
      expect(api.research).toHaveBeenLastCalledWith(
        'hermetismo',
        expect.objectContaining({
          conversationId: store.conversationId(),
          turnId,
        }),
      );
      expect(save.mock.lastCall?.[0]).toMatchObject({
        id: store.conversationId(),
        title: 'quais são?',
        turns: [{ id: turnId, question: 'quais são?', status: 'pending' }],
      });
      expect(sessionStorage.getItem(OPEN_RESEARCH_KEY)).toBe(
        store.conversationId(),
      );
    });

    it('saves a turn that failed, with its code', () => {
      const { store, streams, save } = setup();
      store.ask('quais são?');
      streams[0]?.next({ type: 'start', model: 'm', billing: 'per-token' });
      streams[0]?.next({ type: 'error', code: 'PROVIDER_UNAVAILABLE' });
      expect(save.mock.lastCall?.[0].turns[0]).toMatchObject({
        status: 'failed',
        error: 'PROVIDER_UNAVAILABLE',
      });
    });

    it('saves a question refused before the server took it as failed', () => {
      const { store, api, save } = setup();
      api.research.mockReturnValueOnce(
        throwError(() => new HttpErrorResponse({ status: 429 })) as never,
      );
      store.ask('quais são?');
      expect(store.turns()[0]?.phase).toBe('error');
      expect(save.mock.lastCall?.[0].turns[0]).toMatchObject({
        status: 'failed',
      });
    });

    it('follows the turn again when the stream drops after it started', () => {
      const { store, api, streams, follows, save } = setup();
      store.ask('quais são?');
      const turnId = store.turns()[0]?.turnId;
      streams[0]?.next({ type: 'start', model: 'm', billing: 'per-token' });
      streams[0]?.next({ type: 'token', text: 'Come', segment: 0 });
      streams[0]?.error(new HttpErrorResponse({ status: 0 }));
      expect(api.follow).toHaveBeenCalledExactlyOnceWith(turnId);
      expect(store.turns()[0]).toMatchObject({ phase: 'streaming', text: '' });
      answer(follows[0] as Subject<ResearchEvent>, 'São sete [1].');
      expect(store.turns()[0]).toMatchObject({
        phase: 'done',
        text: 'São sete [1].',
      });
      expect(save.mock.lastCall?.[0].turns[0]).not.toHaveProperty('status');
    });

    it('restores a conversation whose turn still runs and follows it to the answer', () => {
      const { store, api, follows } = setup();
      store.restore(conversation([savedTurn()]));
      expect(api.follow).toHaveBeenCalledExactlyOnceWith(TURN);
      expect(store.streaming()).toBe(true);
      const follow = follows[0] as Subject<ResearchEvent>;
      follow.next({ type: 'start', model: 'm', billing: 'per-token' });
      answer(follow, 'Tudo é duplo [1].');
      expect(store.turns()[0]).toMatchObject({
        phase: 'done',
        text: 'Tudo é duplo [1].',
        restored: false,
      });
    });

    it('shows what the history kept when the turn no longer runs, never a spinner', () => {
      const ended: SavedResearchTurn = {
        ...savedTurn({ answer: 'Tudo é duplo.' }),
      };
      delete ended.status;
      const { store, follows, load } = setup({
        stored: conversation([ended]),
      });
      store.restore(conversation([savedTurn()]));
      follows[0]?.error(new HttpErrorResponse({ status: 404 }));
      expect(load).toHaveBeenCalledWith(CONVERSATION);
      expect(store.turns()[0]).toMatchObject({
        phase: 'done',
        text: 'Tudo é duplo.',
      });
    });

    it('marks a turn interrupted when it neither runs nor ended in the history', () => {
      const { store, follows } = setup();
      store.restore(conversation([savedTurn()]));
      follows[0]?.error(new HttpErrorResponse({ status: 404 }));
      expect(store.turns()[0]).toMatchObject({
        phase: 'done',
        interrupted: true,
      });
      expect(store.streaming()).toBe(false);
    });

    it('restores a failed turn with its error and asks it again with the same id', () => {
      const { store, api } = setup();
      store.restore(
        conversation([savedTurn({ status: 'failed', error: 'RATE_LIMITED' })]),
      );
      expect(store.turns()[0]).toMatchObject({
        phase: 'error',
        error: 'RATE_LIMITED',
      });
      store.retry();
      expect(api.research).toHaveBeenLastCalledWith(
        'hermetismo',
        expect.objectContaining({ turnId: TURN, conversationId: CONVERSATION }),
      );
    });

    it('"+ Nova conversa" leaves the running turn to the server instead of stopping it', () => {
      const { store, api, streams } = setup();
      store.ask('quais são?');
      store.newConversation();
      expect(streams[0]?.observed).toBe(false);
      expect(api.stopTurn).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(OPEN_RESEARCH_KEY)).toBeNull();
    });

    it('brings back, after a reload, the research conversation that was on screen', () => {
      sessionStorage.setItem(OPEN_RESEARCH_KEY, CONVERSATION);
      const { store, api } = setup({ stored: conversation([savedTurn()]) });
      TestBed.tick();
      expect(store.conversationId()).toBe(CONVERSATION);
      expect(api.follow).toHaveBeenCalledWith(TURN);
    });
  });

  it('sweeps on: "Continuar varredura" asks only for the rest, from the saved cursor (KBC-030)', () => {
    const { store, api, streams, save } = setup();
    store.chooseProfile('exhaustive');
    store.ask('quais livros o Mestre cita?');
    const stream = streams[0];
    if (!stream) throw new Error('no stream');
    stream.next({ type: 'sweep', sweep: { ...PROGRESS, status: 'planned' } });
    stream.next({ type: 'sweep', sweep: PROGRESS });
    stream.next({ type: 'token', text: 'Lista parcial [1].', segment: 0 });
    stream.next({
      type: 'done',
      usd: 0,
      billing: 'free',
      model: 'm',
      interrupted: false,
      steps: 2,
      coverage: COVERAGE,
      sweep: CURSOR,
    });
    stream.complete();
    const saved = save.mock.calls.at(-1)?.[0].turns[0];
    expect(saved?.coverage).toEqual(COVERAGE);
    expect(saved?.sweep).toEqual(CURSOR);
    store.continueSweep();
    // Shown as a continuation, asked as the question itself.
    expect(store.turns()[1]?.question).toBe(
      'Continuar varredura: quais livros o Mestre cita?',
    );
    expect(api.research).toHaveBeenLastCalledWith('hermetismo', {
      question: 'quais livros o Mestre cita?',
      history: [
        {
          question: 'quais livros o Mestre cita?',
          answer: 'Lista parcial [1].',
        },
      ],
      profile: 'exhaustive',
      sweep: CURSOR,
      // Recorded in the same conversation, as its own turn (KBC-029).
      conversationId: store.conversationId(),
      turnId: store.turns()[1]?.turnId,
    });
    // In the history at once, as a continuation.
    const pending = save.mock.calls.at(-1)?.[0].turns.at(-1);
    expect(pending?.question).toBe(
      'Continuar varredura: quais livros o Mestre cita?',
    );
  });

  it('keeps the last progress cursor and every batch’s findings when the reader stops (QA F-1)', () => {
    const { store, streams, save } = setup();
    store.chooseProfile('exhaustive');
    store.ask('livros');
    const found = (text: string) => [{ id: 'raw/a.md', text }];
    streams[0]?.next({
      type: 'sweep',
      sweep: {
        ...PROGRESS,
        cursor: { ...CURSOR, findings: [] },
        found: found('A'),
      },
    });
    streams[0]?.next({
      type: 'sweep',
      sweep: {
        ...PROGRESS,
        cursor: { ...CURSOR, findings: [] },
        found: found('B'),
      },
    });
    store.stop();
    const expected = { ...CURSOR, findings: [...found('A'), ...found('B')] };
    expect(store.turns()[0]?.cursor).toEqual(expected);
    expect(save.mock.calls.at(-1)?.[0].turns[0]?.sweep).toEqual(expected);
  });

  it('continues nothing when the sweep covered its whole set', () => {
    const { store, api, streams } = setup();
    store.chooseProfile('exhaustive');
    store.ask('livros');
    streams[0]?.next({ type: 'sweep', sweep: PROGRESS });
    streams[0]?.next({ type: 'token', text: 'Tudo [1].', segment: 0 });
    streams[0]?.next({
      type: 'done',
      usd: 0,
      billing: 'free',
      model: 'm',
      interrupted: false,
      steps: 1,
      coverage: { ...COVERAGE, missing: 0, read: 10, reason: undefined },
    });
    expect(store.turns()[0]?.cursor).toBeNull();
    store.continueSweep();
    expect(api.research).toHaveBeenCalledTimes(1);
  });

  it('keeps the carried findings when a continuation is stopped too (code review 1)', () => {
    const { store, streams } = setup();
    store.chooseProfile('exhaustive');
    store.ask('livros');
    const earlier = { ...CURSOR, findings: [{ id: 'raw/a.md', text: 'A' }] };
    streams[0]?.next({ type: 'token', text: 'Parcial [1].', segment: 0 });
    streams[0]?.next({
      type: 'done',
      usd: 0,
      billing: 'free',
      model: 'm',
      interrupted: false,
      steps: 1,
      coverage: COVERAGE,
      sweep: earlier,
    });
    store.continueSweep();
    streams[1]?.next({
      type: 'sweep',
      sweep: {
        ...PROGRESS,
        cursor: { ...CURSOR, findings: [] },
        found: [{ id: 'raw/b.md', text: 'B' }],
      },
    });
    store.stop();
    expect(store.turns()[1]?.cursor?.findings).toEqual([
      { id: 'raw/a.md', text: 'A' },
      { id: 'raw/b.md', text: 'B' },
    ]);
  });

  it('continues a sweep whose answer failed, from the cursor it kept (code review 10)', () => {
    const { store, api, streams } = setup();
    store.chooseProfile('exhaustive');
    store.ask('livros');
    streams[0]?.next({ type: 'sweep', sweep: PROGRESS });
    streams[0]?.next({ type: 'error', code: 'PROVIDER_UNAVAILABLE' });
    store.continueSweep();
    expect(api.research).toHaveBeenCalledTimes(2);
  });

  it('keeps the estimate shown while the sweep goes on', () => {
    const { store, streams } = setup();
    store.chooseProfile('exhaustive');
    store.ask('livros');
    streams[0]?.next({
      type: 'sweep',
      sweep: { ...PROGRESS, status: 'planned', minutes: 4, usd: 0.3 },
    });
    streams[0]?.next({ type: 'sweep', sweep: PROGRESS });
    expect(store.turns()[0]?.sweep).toMatchObject({
      status: 'running',
      minutes: 4,
      usd: 0.3,
    });
  });

  it('keeps each finding once when a running sweep is followed again from its start', () => {
    const { store, streams } = setup();
    store.chooseProfile('exhaustive');
    store.ask('livros');
    const batch = {
      type: 'sweep' as const,
      sweep: {
        ...PROGRESS,
        cursor: { ...CURSOR, findings: [] },
        found: [{ id: 'raw/a.md', text: 'A' }],
      },
    };
    streams[0]?.next(batch);
    // The same batch again, as a replay from the turn's first event brings it.
    streams[0]?.next(batch);
    expect(store.turns()[0]?.cursor?.findings).toEqual([
      { id: 'raw/a.md', text: 'A' },
    ]);
  });
});
