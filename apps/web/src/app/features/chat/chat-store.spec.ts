import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { ApplicationRef, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  EMPTY_FILTERS,
  type SearchConversation,
  type SearchFilters,
  type SearchResponse,
} from '@kb-chat/contracts';
import { KbApi } from '@core/api/kb-api.js';
import { HistoryStore } from '@core/history/history-store.js';
import { UsageLog } from '@core/usage/usage-log.js';
import { Subject } from 'rxjs';
import { FakeConversationsServer } from '../../testing/fake-conversations.js';
import { TOPICS, aResponse } from '../../testing/fixtures.js';
import { ChatStore } from './chat-store.js';

const GENRE: SearchFilters = { ...EMPTY_FILTERS, genres: ['paper'] };

const usage = { track: vi.fn() };

async function setup() {
  usage.track.mockClear();
  localStorage.clear();
  const server = new FakeConversationsServer();
  const searches: {
    topic: string;
    q: string;
    reply: Subject<SearchResponse>;
  }[] = [];
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(withInterceptors([server.interceptor])),
      provideHttpClientTesting(),
      ChatStore,
      { provide: UsageLog, useValue: usage },
      {
        provide: KbApi,
        useValue: {
          search: (topic: string, request: { q: string }) => {
            const reply = new Subject<SearchResponse>();
            searches.push({ topic, q: request.q, reply });
            return reply;
          },
        },
      },
    ],
  });
  const store = TestBed.inject(ChatStore);
  // The topics resource sends its request on the first change detection.
  TestBed.tick();
  TestBed.inject(HttpTestingController)
    .expectOne('/api/v1/topics')
    .flush(TOPICS);
  await TestBed.inject(ApplicationRef).whenStable();
  const history = TestBed.inject(HistoryStore);
  const answer = (index: number, response = aResponse()) => {
    searches[index]?.reply.next(response);
    searches[index]?.reply.complete();
  };
  /** The conversation as the API received it. */
  const savedOnServer = (id: string) =>
    server.saved.get(id) as SearchConversation | undefined;
  return { store, history, searches, answer, savedOnServer };
}

describe('ChatStore conversations (KBC-005)', () => {
  it('restores every question of a conversation in order with its mode and filters (FR-2)', async () => {
    const { store, history, searches, answer, savedOnServer } = await setup();
    store.ask('ritmo', { mode: 'semantic', filters: GENRE });
    answer(0);
    store.ask('polaridade', { mode: 'exact' });
    answer(1);
    const saved = savedOnServer(store.conversationId());
    if (!saved) throw new Error('the conversation was not saved');
    expect(saved).toMatchObject({ kind: 'search', title: 'ritmo' });
    expect(saved.asks.map((a) => [a.question, a.mode])).toEqual([
      ['ritmo', 'semantic'],
      ['polaridade', 'exact'],
    ]);
    expect(history.conversations()[0]).toMatchObject({
      id: saved.id,
      kind: 'search',
      count: 2,
    });
    store.newConversation();
    store.restore(saved);
    expect(searches.slice(2).map((s) => s.q)).toEqual(['ritmo', 'polaridade']);
    expect(
      store.messages().map((m) => [m.question, m.mode, m.filters]),
    ).toEqual([
      ['ritmo', 'semantic', GENRE],
      ['polaridade', 'exact', EMPTY_FILTERS],
    ]);
    expect(store.conversationId()).toBe(saved.id);
    answer(2);
    answer(3);
    // Restored searches are not new searches in the usage log (KBC-006 review).
    const origins = usage.track.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'search')
      .map((event) => event.origin);
    expect(origins).toEqual(['typed', 'typed']);
    // Saved again after the re-run, it keeps the day it started.
    expect(savedOnServer(saved.id)?.createdAt).toBe(saved.createdAt);
  });

  it('keeps the creation time across the saves of one conversation', async () => {
    const { store, answer, savedOnServer } = await setup();
    store.ask('ritmo');
    answer(0);
    const first = savedOnServer(store.conversationId());
    store.ask('polaridade');
    answer(1);
    const second = savedOnServer(store.conversationId());
    expect(second?.asks).toHaveLength(2);
    expect(second?.createdAt).toBe(first?.createdAt);
  });

  it('drops a late result of the previous conversation after "+ Nova conversa"', async () => {
    const { store, history, answer } = await setup();
    store.ask('ritmo');
    store.newConversation();
    answer(0);
    expect(store.messages()).toEqual([]);
    expect(history.conversations()).toEqual([]);
  });

  it('writes the history only when the conversation summary changes', async () => {
    const { store, history, answer } = await setup();
    const save = vi.spyOn(history, 'save');
    store.ask('ritmo');
    answer(0, aResponse(undefined, { nextOffset: 1 }));
    expect(save).toHaveBeenCalledTimes(1);
    const [message] = store.messages();
    if (!message) throw new Error('no message');
    store.loadMore(message);
    answer(1);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('switches collection into a new conversation and ignores the current one', async () => {
    const { store, searches } = await setup();
    store.selectTopic('hermetismo');
    expect(store.topicNotice()).toBeNull();
    store.selectTopic('alquimia');
    expect(store.topicNotice()).toBe('alquimia');
    store.ask('pedra');
    expect(searches[0]?.topic).toBe('alquimia');
    expect(store.topicNotice()).toBeNull();
  });
});
