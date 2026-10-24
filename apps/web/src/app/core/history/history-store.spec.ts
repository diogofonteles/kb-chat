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
  type SearchConversation,
} from '@kb-chat/contracts';
import { aSearchConversation } from '../../testing/fake-conversations.js';
import { HistoryStore, RETRY_FIRST_MS } from './history-store.js';
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
    expect(loaded).toEqual([conversation]);
    expect(store.available()).toBe(false);
    http.expectOne(LIST).flush({ items: [] });
    await settle();
    http
      .expectOne(one(conversation.id))
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
});
