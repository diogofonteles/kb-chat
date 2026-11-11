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
import { TOPICS, aHit, aMediaHit, aResponse } from '../../testing/fixtures.js';
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
    kinds?: readonly string[];
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
          search: (
            topic: string,
            request: { q: string; kinds?: readonly string[] },
          ) => {
            const reply = new Subject<SearchResponse>();
            searches.push({ topic, q: request.q, reply, kinds: request.kinds });
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
    // The question was in the history from the moment it was sent (KBC-029), once.
    expect(history.conversations().map((c) => c.title)).toEqual(['ritmo']);
  });

  it('writes the history only when the conversation summary changes', async () => {
    const { store, history, answer } = await setup();
    const save = vi.spyOn(history, 'save');
    store.ask('ritmo');
    // Once when sent (KBC-029), once with the result count.
    answer(0, aResponse(undefined, { nextOffset: 1 }));
    expect(save).toHaveBeenCalledTimes(2);
    const [message] = store.messages();
    if (!message) throw new Error('no message');
    store.loadMore(message);
    answer(1);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('KBC-029: saves the conversation as the question is sent, and says it is searching', async () => {
    const { store, history, savedOnServer } = await setup();
    expect(store.searching()).toBe(false);
    store.ask('ritmo');
    expect(store.searching()).toBe(true);
    expect(history.conversations()[0]).toMatchObject({
      id: store.conversationId(),
      title: 'ritmo',
    });
    await TestBed.inject(ApplicationRef).whenStable();
    expect(savedOnServer(store.conversationId())?.asks).toEqual([
      expect.objectContaining({ question: 'ritmo', total: null }),
    ]);
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

describe('ChatStore and spoken passages (KBC-039)', () => {
  it('searches every kind by default and remembers "Buscar em" for the next searches (BR-4)', async () => {
    const { store, searches, answer } = await setup();
    store.ask('hoasca');
    answer(0);
    expect(searches[0]?.kinds).toEqual(['text', 'audio']);
    const message = store.messages()[0];
    if (!message) throw new Error('no message');
    store.chooseKinds(message, ['audio']);
    expect(searches[1]?.kinds).toEqual(['audio']);
    expect(store.messages()).toHaveLength(1);
    store.ask('mariri');
    expect(searches[2]?.kinds).toEqual(['audio']);
    TestBed.tick();
    expect(localStorage.getItem('kb-chat.search-kinds')).toBe('["audio"]');
  });

  it('searches only what was said when asked to, and keeps the person\'s "Buscar em" (KBC-051 AC-12)', async () => {
    const { store, searches } = await setup();

    store.ask('conselheira', { kinds: ['audio'] });

    expect(searches[0]?.kinds).toEqual(['audio']);
    expect(store.kinds()).toEqual(['text', 'audio']);
  });

  it('opens a passage in the reading panel, logs it and closes the document (FR-4, AC-7)', async () => {
    const { store } = await setup();
    store.open('hermetismo', { id: 'a.md', title: 'A' });
    const hit = aMediaHit();
    store.openMedia(hit, { messageId: 1, position: 2 });
    expect(store.openDocument()).toBeNull();
    expect(store.openPassage()).toEqual({ hit, messageId: 1 });
    expect(usage.track).toHaveBeenLastCalledWith({
      type: 'media_hit_opened',
      mediaId: hit.mediaId,
      startMs: 495_000,
      position: 2,
    });
    store.open('hermetismo', { id: 'b.md', title: 'B' });
    expect(store.openPassage()).toBeNull();
    store.openMedia(hit, { messageId: null, position: null });
    store.close();
    expect(store.openPassage()).toBeNull();
  });

  it('KBC-099 T22 flow 1: a cited track opened over a document keeps "← Voltar" to it', async () => {
    const { store } = await setup();
    const track = {
      source: { n: 1, id: 'raw/media/r/t.md', title: 'O que é o ritmo?' },
      at: '0:41',
    };
    store.open('hermetismo', { id: 'a.md', title: 'A' });
    store.openTrackPassage(track);
    expect(store.openDocument()).toBeNull();
    expect(store.openTrack()).toEqual(track);
    expect(store.canGoBack()).toBe(true);

    // Another track over the first one still goes back to the document.
    store.openTrackPassage({ ...track, at: '1:00' });
    expect(store.canGoBack()).toBe(true);

    store.back();
    expect(store.openTrack()).toBeNull();
    expect(store.openDocument()?.id).toBe('a.md');
    expect(store.canGoBack()).toBe(false);

    // Opened from the answer with nothing open: no way back.
    store.close();
    store.openTrackPassage(track);
    expect(store.canGoBack()).toBe(false);
  });

  it("counts a document's place among texts and passages, as for a passage (FR-4)", async () => {
    const { store, answer } = await setup();
    store.ask('hoasca');
    answer(
      0,
      aResponse(
        [aHit({ id: 'a.md', score: 0.9 }), aHit({ id: 'b.md', score: 0.2 })],
        { media: [aMediaHit({ score: 0.5 })] },
      ),
    );
    const message = store.messages()[0];
    if (!message) throw new Error('no message');
    store.open('hermetismo', { id: 'b.md', title: 'B' }, message);
    expect(usage.track).toHaveBeenLastCalledWith({
      type: 'open_doc',
      position: 3,
    });
    store.open('hermetismo', { id: 'copia.md', title: 'Cópia' }, message);
    expect(usage.track).toHaveBeenLastCalledWith({
      type: 'open_doc',
      position: null,
    });
  });
});
