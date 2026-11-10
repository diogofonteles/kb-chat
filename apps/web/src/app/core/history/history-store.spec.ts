import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { ApplicationRef, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  summarizeConversation,
  type Conversation,
  type ResearchConversation,
  type SavedResearchTurn,
  type SearchConversation,
} from '@kb-chat/contracts';
import { aSearchConversation } from '../../testing/fake-conversations.js';
import {
  HistoryStore,
  POLL_PENDING_MS,
  RETRY_FIRST_MS,
} from './history-store.js';
import { LEGACY_HISTORY_KEY } from './legacy-history.js';
import { PENDING_SAVES_KEY } from './pending-saves.js';

const LIST = '/api/v1/conversations';
const one = (id: string) => `${LIST}/${id}`;
const NETWORK_DOWN = { status: 0, statusText: 'Unknown Error' };

function createStore() {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  const store = TestBed.inject(HistoryStore);
  // The list resource sends its request on the first change detection.
  TestBed.tick();
  return { store, http: TestBed.inject(HttpTestingController) };
}

/** Waits for the resources; only once no request is left open (they keep the app unstable). */
const settle = () => TestBed.inject(ApplicationRef).whenStable();

/** A store whose list already arrived with `saved`. */
async function loadedStore(saved: readonly Conversation[] = []) {
  const setup = createStore();
  setup.http.expectOne(LIST).flush({ items: saved.map(summarizeConversation) });
  await settle();
  return setup;
}

const legacyEntry = (id: string, question: string) => ({
  id,
  topic: 'hermetismo',
  asks: [
    {
      question,
      mode: 'all',
      filters: aSearchConversation().asks[0]?.filters,
      total: 2,
    },
  ],
  updatedAt: '2026-10-20T08:00:00.000Z',
});

describe('HistoryStore (the complete history on the local API)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('lists every conversation the API keeps, with no cap', async () => {
    const saved = Array.from({ length: 60 }, () => aSearchConversation());
    const { store } = await loadedStore(saved);
    expect(store.conversations()).toHaveLength(60);
    expect(store.available()).toBe(true);
    expect(store.lastError()).toBeNull();
  });

  it('is unavailable when the list cannot be read', async () => {
    const { store, http } = createStore();
    http.expectOne(LIST).error(new ProgressEvent('error'), NETWORK_DOWN);
    await settle();
    expect(store.available()).toBe(false);
    expect(store.lastError()).toEqual({ action: 'list', id: null });
    expect(store.conversations()).toEqual([]);
  });

  it('shows a saved conversation at the top at once and sends the saves in order', async () => {
    const older = aSearchConversation({ title: 'antiga' });
    const { store, http } = await loadedStore([older]);
    const conversation = aSearchConversation({ title: 'ritmo' });
    store.save(conversation);
    store.save({ ...conversation, title: 'ritmo de novo' });
    expect(store.conversations().map((c) => c.title)).toEqual([
      'ritmo de novo',
      'antiga',
    ]);
    const first = http.expectOne(one(conversation.id));
    expect(first.request.method).toBe('PUT');
    expect(first.request.body).toEqual(conversation);
    // The second PUT waits for the first one (a newer version never lands first).
    first.flush(summarizeConversation(conversation));
    expect(http.expectOne(one(conversation.id)).request.body.title).toBe(
      'ritmo de novo',
    );
  });

  it('keeps a conversation whose save failed and reports it until a save works', async () => {
    const { store, http } = await loadedStore();
    const conversation = aSearchConversation();
    store.save(conversation);
    http
      .expectOne(one(conversation.id))
      .error(new ProgressEvent('error'), NETWORK_DOWN);
    expect(store.conversations().map((c) => c.id)).toEqual([conversation.id]);
    expect(store.available()).toBe(false);
    expect(store.lastError()).toEqual({ action: 'save', id: conversation.id });
    store.save(conversation);
    http
      .expectOne(one(conversation.id))
      .flush(summarizeConversation(conversation));
    expect(store.available()).toBe(true);
    expect(store.lastError()).toBeNull();
  });

  it('keeps a failed save pending through other saves and sends it again on the next save', async () => {
    const { store, http } = await loadedStore();
    const [failed, other] = [aSearchConversation(), aSearchConversation()];
    store.save(failed);
    http
      .expectOne(one(failed.id))
      .error(new ProgressEvent('error'), NETWORK_DOWN);
    store.save(other);
    http.expectOne(one(other.id)).flush(summarizeConversation(other));
    // Another conversation saving fine does not clear the one still missing.
    expect(store.available()).toBe(false);
    expect(store.lastError()).toEqual({ action: 'save', id: failed.id });
    const retry = http.expectOne(one(failed.id));
    expect(retry.request.body).toEqual(failed);
    retry.flush(summarizeConversation(failed));
    expect(store.available()).toBe(true);
    expect(store.lastError()).toBeNull();
    expect(localStorage.getItem(PENDING_SAVES_KEY)).toBeNull();
  });

  it('retries a failed save by itself, with backoff', async () => {
    const { store, http } = await loadedStore();
    vi.useFakeTimers();
    try {
      const conversation = aSearchConversation();
      store.save(conversation);
      http
        .expectOne(one(conversation.id))
        .error(new ProgressEvent('error'), NETWORK_DOWN);
      vi.advanceTimersByTime(RETRY_FIRST_MS);
      http
        .expectOne(one(conversation.id))
        .error(new ProgressEvent('error'), NETWORK_DOWN);
      vi.advanceTimersByTime(RETRY_FIRST_MS);
      http.expectNone(one(conversation.id));
      vi.advanceTimersByTime(RETRY_FIRST_MS);
      http
        .expectOne(one(conversation.id))
        .flush(summarizeConversation(conversation));
      expect(store.available()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a pending conversation across a reload and saves it once the list loads', async () => {
    const first = await loadedStore();
    const conversation = aSearchConversation({ title: 'não salva' });
    first.store.save(conversation);
    first.http
      .expectOne(one(conversation.id))
      .error(new ProgressEvent('error'), NETWORK_DOWN);
    TestBed.resetTestingModule();
    const { store, http } = createStore();
    // Listed and readable from this browser before the API has it.
    expect(store.conversations().map((c) => c.title)).toEqual(['não salva']);
    const loaded: Conversation[] = [];
    store.load(conversation.id).subscribe((c) => loaded.push(c));
    // The server is asked first (KBC-110); it does not have it yet.
    http
      .expectOne({ method: 'GET', url: one(conversation.id) })
      .flush(null, { status: 404, statusText: 'Not Found' });
    expect(loaded).toEqual([conversation]);
    expect(store.available()).toBe(false);
    http.expectOne(LIST).flush({ items: [] });
    await settle();
    http
      .expectOne({ method: 'PUT', url: one(conversation.id) })
      .flush(summarizeConversation(conversation));
    expect(store.available()).toBe(true);
    expect(localStorage.getItem(PENDING_SAVES_KEY)).toBeNull();
  });

  it('loads a whole conversation by id, and reports a failed load', async () => {
    const conversation = aSearchConversation();
    const { store, http } = await loadedStore([conversation]);
    const loaded: Conversation[] = [];
    store.load(conversation.id).subscribe((c) => loaded.push(c));
    http.expectOne(one(conversation.id)).flush(conversation);
    expect(loaded).toEqual([conversation]);
    store.load(conversation.id).subscribe({ error: () => undefined });
    http
      .expectOne(one(conversation.id))
      .flush(null, { status: 404, statusText: 'Not Found' });
    expect(store.lastError()).toEqual({ action: 'load', id: conversation.id });
    expect(store.available()).toBe(true);
  });

  it('removes a conversation at once, and reads the list again if the server refuses', async () => {
    const [a, b] = [aSearchConversation(), aSearchConversation()];
    const { store, http } = await loadedStore([a, b]);
    store.remove(a.id);
    expect(store.conversations().map((c) => c.id)).toEqual([b.id]);
    const removal = http.expectOne(one(a.id));
    expect(removal.request.method).toBe('DELETE');
    removal.flush(null, { status: 500, statusText: 'Server Error' });
    expect(store.lastError()).toEqual({ action: 'remove', id: a.id });
    TestBed.tick();
    http.expectOne(LIST).flush({ items: [a, b].map(summarizeConversation) });
    await settle();
    expect(store.conversations()).toHaveLength(2);
  });
});

describe('HistoryStore migration of the old browser history', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('saves each old conversation as a search one, then forgets the old key', async () => {
    const uuid = crypto.randomUUID();
    localStorage.setItem(
      LEGACY_HISTORY_KEY,
      JSON.stringify([
        legacyEntry(uuid, 'lei do ritmo'),
        legacyEntry('not-a-uuid', 'polaridade'),
        { broken: true },
      ]),
    );
    const { http } = createStore();
    const first = http.expectOne(one(uuid));
    const migrated = first.request.body as SearchConversation;
    expect(migrated).toMatchObject({
      kind: 'search',
      id: uuid,
      title: 'lei do ritmo',
      createdAt: '2026-10-20T08:00:00.000Z',
      updatedAt: '2026-10-20T08:00:00.000Z',
    });
    first.flush(summarizeConversation(migrated));
    const second = http.expectOne((r) => r.method === 'PUT');
    expect(second.request.body.title).toBe('polaridade');
    expect(second.request.body.id).not.toBe('not-a-uuid');
    expect(localStorage.getItem(LEGACY_HISTORY_KEY)).not.toBeNull();
    second.flush(summarizeConversation(second.request.body));
    expect(localStorage.getItem(LEGACY_HISTORY_KEY)).toBeNull();
    http.expectOne(LIST).flush({ items: [] });
  });

  it('keeps the old key when a save fails, and still lists the history', async () => {
    const uuid = crypto.randomUUID();
    localStorage.setItem(
      LEGACY_HISTORY_KEY,
      JSON.stringify([legacyEntry(uuid, 'ritmo')]),
    );
    const { store, http } = createStore();
    http
      .expectOne(one(uuid))
      .flush(null, { status: 500, statusText: 'Server Error' });
    http.expectOne(LIST).flush({ items: [] });
    await settle();
    expect(localStorage.getItem(LEGACY_HISTORY_KEY)).not.toBeNull();
    expect(store.available()).toBe(true);
  });

  it('drops an old history that is not readable at all', async () => {
    localStorage.setItem(LEGACY_HISTORY_KEY, '{not json');
    const { http } = createStore();
    http.expectOne(LIST).flush({ items: [] });
    expect(localStorage.getItem(LEGACY_HISTORY_KEY)).toBeNull();
  });

  describe('KBC-029: conversations whose research is running', () => {
    afterEach(() => vi.useRealTimers());

    const research = (status?: 'pending'): Conversation => ({
      kind: 'research',
      id: '2b0f4a52-8a8b-4b0e-9a55-0d1b5c2b3c4d',
      topic: 'hermetismo',
      title: 'lei do ritmo',
      createdAt: '2026-10-27T09:00:00.000Z',
      updatedAt: '2026-10-27T09:00:00.000Z',
      turns: [
        {
          id: '0b9d7c1e-3f2a-4c5b-8d6e-7f8091a2b3c4',
          question: 'lei do ritmo',
          answer: status ? '' : 'Tudo flui [1].',
          sources: [],
          steps: 1,
          usd: 0,
          billing: 'per-token',
          model: 'm',
          interrupted: false,
          ...(status ? { status } : {}),
          at: '2026-10-27T09:00:00.000Z',
        },
      ],
    });

    it('checks a pending one every few seconds until it ends, in place', async () => {
      vi.useFakeTimers();
      const running = research('pending');
      const other = aSearchConversation();
      const { store, http } = createStore();
      http
        .expectOne(LIST)
        .flush({ items: [running, other].map(summarizeConversation) });
      await vi.advanceTimersByTimeAsync(0);
      TestBed.tick();
      expect(store.conversations()[0]?.status).toBe('pending');
      vi.advanceTimersByTime(POLL_PENDING_MS);
      http.expectOne(one(running.id)).flush(running);
      expect(store.conversations()[0]?.status).toBe('pending');
      vi.advanceTimersByTime(POLL_PENDING_MS);
      http.expectOne(one(running.id)).flush(research());
      TestBed.tick();
      expect(store.conversations().map((c) => [c.id, c.status])).toEqual([
        [running.id, undefined],
        [other.id, undefined],
      ]);
      vi.advanceTimersByTime(POLL_PENDING_MS * 3);
      http.expectNone(one(running.id));
    });

    it('does not check when nothing is pending', async () => {
      vi.useFakeTimers();
      const { http } = createStore();
      http
        .expectOne(LIST)
        .flush({ items: [summarizeConversation(research())] });
      await vi.advanceTimersByTimeAsync(0);
      TestBed.tick();
      vi.advanceTimersByTime(POLL_PENDING_MS * 2);
      http.expectNone(() => true);
    });
  });
});

describe('HistoryStore and the level of today (KBC-110)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  const turn: SavedResearchTurn = {
    id: crypto.randomUUID(),
    question: 'o que diz o Caibalion?',
    answer: 'Tudo é mente [1].',
    sources: [{ n: 1, id: 'raw/caibalion.md', title: 'O Caibalion' }],
    steps: 1,
    usd: 0,
    billing: 'per-token',
    model: 'stub/model',
    interrupted: false,
    at: '2026-11-10T12:00:00.000Z',
  };
  const whole: ResearchConversation = {
    kind: 'research',
    id: crypto.randomUUID(),
    topic: 'hermetismo',
    title: turn.question,
    createdAt: turn.at,
    updatedAt: turn.at,
    turns: [turn],
  };
  const masked: ResearchConversation = {
    ...whole,
    turns: [
      { ...turn, sources: [{ n: 1, restricted: true }], restrictedSources: 1 },
    ],
  };

  it('AC-5: a whole copy left in localStorage opens as the server masks it, and is kept so', async () => {
    localStorage.setItem(PENDING_SAVES_KEY, JSON.stringify([whole]));
    const { store, http } = createStore();
    const loaded: Conversation[] = [];

    store.load(whole.id).subscribe((c) => loaded.push(c));
    http.expectOne({ method: 'GET', url: one(whole.id) }).flush(masked);

    expect(loaded).toEqual([masked]);
    const kept = JSON.parse(localStorage.getItem(PENDING_SAVES_KEY) ?? '[]');
    expect(JSON.stringify(kept)).not.toContain('raw/caibalion.md');
    expect(kept).toEqual([masked]);
    http.expectOne(LIST).flush({ items: [] });
    await settle();
    // The copy sent again is the masked one: the server keeps what its file had (BR-4).
    const put = http.expectOne({ method: 'PUT', url: one(whole.id) });
    expect(put.request.body).toEqual(masked);
    put.flush(summarizeConversation(masked));
  });

  it('keeps the turns only this browser has, and its copy when the server is out', async () => {
    const extra = { ...turn, id: crypto.randomUUID(), question: 'outra' };
    const local: ResearchConversation = { ...whole, turns: [turn, extra] };
    localStorage.setItem(PENDING_SAVES_KEY, JSON.stringify([local]));
    const { store, http } = createStore();
    const loaded: Conversation[] = [];

    store.load(whole.id).subscribe((c) => loaded.push(c));
    http.expectOne({ method: 'GET', url: one(whole.id) }).flush(masked);
    store.load(whole.id).subscribe((c) => loaded.push(c));
    http
      .expectOne({ method: 'GET', url: one(whole.id) })
      .error(new ProgressEvent('error'), NETWORK_DOWN);

    const first = loaded[0];
    expect(
      first?.kind === 'research' && first.turns.map((t) => t.sources),
    ).toEqual([[{ n: 1, restricted: true }], extra.sources]);
    expect(loaded[1]).toEqual(first);
    http.expectOne(LIST).flush({ items: [] });
    await settle();
    http
      .expectOne({ method: 'PUT', url: one(whole.id) })
      .flush(summarizeConversation(local));
  });

  it('QA F-4: with the API out the local copy opens as it is; once the API is back it opens masked', async () => {
    localStorage.setItem(PENDING_SAVES_KEY, JSON.stringify([whole]));
    const { store, http } = createStore();
    const loaded: Conversation[] = [];

    store.load(whole.id).subscribe((c) => loaded.push(c));
    http
      .expectOne({ method: 'GET', url: one(whole.id) })
      .error(new ProgressEvent('error'), NETWORK_DOWN);
    store.load(whole.id).subscribe((c) => loaded.push(c));
    http.expectOne({ method: 'GET', url: one(whole.id) }).flush(masked);

    expect(loaded).toEqual([whole, masked]);
    http.expectOne(LIST).flush({ items: [] });
    await settle();
    http
      .expectOne({ method: 'PUT', url: one(whole.id) })
      .flush(summarizeConversation(masked));
  });
});
