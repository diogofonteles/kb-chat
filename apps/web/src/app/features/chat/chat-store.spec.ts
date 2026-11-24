import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import {
  ApplicationRef,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  EMPTY_FILTERS,
  type SearchConversation,
  type SearchFilters,
  type SearchResponse,
  type TopicList,
} from '@kb-chat/contracts';
import { SessionStore } from '@core/auth/session-store.js';
import { KbApi } from '@core/api/kb-api.js';
import { HistoryStore } from '@core/history/history-store.js';
import { UsageLog } from '@core/usage/usage-log.js';
import { Subject } from 'rxjs';
import { FakeConversationsServer } from '../../testing/fake-conversations.js';
import {
  TOPICS,
  aHit,
  aMediaHit,
  aResponse,
  aTopic,
} from '../../testing/fixtures.js';
import { ChatStore } from './chat-store.js';
import { topicPreferenceKey } from './topic-preference.js';

const GENRE: SearchFilters = { ...EMPTY_FILTERS, genres: ['paper'] };

const usage = { track: vi.fn() };

interface SetupOptions {
  /** The list /topics answers. */
  readonly topics?: TopicList;
  /** Who is signed in (null: nobody, as before /me answers). */
  readonly email?: string | null;
  /** Keeps what this browser already stored (a reload). */
  readonly keepStorage?: boolean;
}

const ANA = 'ana@example.com';

async function setup(options: SetupOptions = {}) {
  const { topics = TOPICS, email = ANA, keepStorage = false } = options;
  usage.track.mockClear();
  if (!keepStorage) localStorage.clear();
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
        provide: SessionStore,
        useValue: { me: signal(email === null ? null : { email }) },
      },
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
  // Nothing is in use before the list arrives, not even the default (KBC-157 AC-1).
  expect(store.topicSlug()).toBeNull();
  TestBed.inject(HttpTestingController)
    .expectOne('/api/v1/topics')
    .flush(topics);
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

  it('keeps a conversation opened again in its place until it asks something new (chat-results)', async () => {
    const { store, history, answer, savedOnServer } = await setup();
    store.ask('ritmo');
    answer(0);
    const saved = savedOnServer(store.conversationId());
    if (!saved) throw new Error('the conversation was not saved');
    store.newConversation();
    store.ask('polaridade');
    answer(1);
    expect(history.conversations().map((c) => c.title)).toEqual([
      'polaridade',
      'ritmo',
    ]);
    store.newConversation();
    store.restore(saved);
    answer(2);
    // The search ran again: the list keeps its order and the saved copy its time.
    expect(history.conversations().map((c) => c.title)).toEqual([
      'polaridade',
      'ritmo',
    ]);
    expect(savedOnServer(saved.id)?.updatedAt).toBe(saved.updatedAt);
    // A new question in it is news: it goes to the top.
    store.ask('vibração');
    answer(3);
    expect(history.conversations()[0]?.id).toBe(saved.id);
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

describe('ChatStore and the sources of an AI answer (KBC-127 FR-1)', () => {
  const sources = [
    { n: 1, id: 'a.md', title: 'A' },
    { n: 2, id: 'b.md', title: 'B' },
  ];

  it("opens a source on the answer's question, steps between the sources and leaves them", async () => {
    const { store } = await setup();
    store.openSource(
      'hermetismo',
      { id: 'b.md', title: 'B' },
      { question: 'ritmo', sources },
    );
    expect(store.openDocument()).toEqual({
      topic: 'hermetismo',
      id: 'b.md',
      title: 'B',
      messageId: null,
      question: 'ritmo',
      sources,
    });
    store.switchSource({ id: 'a.md', title: 'A' });
    expect(store.openDocument()?.id).toBe('a.md');
    expect(store.canGoBack()).toBe(false);
    store.leaveSources();
    expect(store.openDocument()).toEqual({
      topic: 'hermetismo',
      id: 'a.md',
      title: 'A',
      messageId: null,
      question: 'ritmo',
    });
    // A search result has no sources to step between.
    store.switchSource({ id: 'b.md', title: 'B' });
    expect(store.openDocument()?.id).toBe('a.md');
  });
});

describe('ChatStore: the collection in use survives a reload (KBC-157)', () => {
  const keyOf = (email: string) => topicPreferenceKey(email) ?? '';
  const remember = (email: string, slug: string) =>
    localStorage.setItem(keyOf(email), slug);
  const THREE: TopicList = {
    items: [
      ...TOPICS.items,
      aTopic({ slug: 'cabala', title: 'Cabala', documentCount: 9 }),
    ],
    defaultSlug: null,
  };

  afterEach(() => vi.restoreAllMocks());

  it('FR-1: choosing a collection keeps it for this person in this browser', async () => {
    const { store } = await setup();
    expect(localStorage.getItem(keyOf(ANA))).toBeNull();
    store.selectTopic('alquimia');
    expect(localStorage.getItem(keyOf(ANA))).toBe('alquimia');
    // The key names the person without showing the address (BR-1).
    expect(keyOf(ANA)).toMatch(/^kb-chat\.topic:/);
    expect(keyOf(ANA)).not.toContain('ana');
    expect(keyOf('ANA@example.com')).toBe(keyOf(ANA));
  });

  it('AC-1 (FR-2): a reload opens on the remembered collection once the list arrives', async () => {
    remember(ANA, 'alquimia');
    const { store } = await setup({ keepStorage: true });
    expect(store.topicSlug()).toBe('alquimia');
    expect(store.topic()?.title).toBe('Alquimia');
    // A reload starts a new conversation, with no "switched" notice (KBC-164).
    expect(store.messages()).toEqual([]);
    expect(store.topicNotice()).toBeNull();
  });

  it("BR-2: the remembered collection wins over the person's default", async () => {
    remember(ANA, 'cabala');
    const { store } = await setup({
      keepStorage: true,
      topics: { ...THREE, defaultSlug: 'alquimia' },
    });
    expect(store.topicSlug()).toBe('cabala');
  });

  it('AC-2: a removed collection falls back to the default, then the largest, without error', async () => {
    remember(ANA, 'apagado');
    const first = await setup({
      keepStorage: true,
      topics: { ...THREE, defaultSlug: 'cabala' },
    });
    expect(first.store.topicSlug()).toBe('cabala');
    TestBed.resetTestingModule();
    const second = await setup({ keepStorage: true });
    expect(second.store.topicSlug()).toBe('hermetismo');
  });

  it('AC-3 (BR-3): a collection no longer open falls back without being forgotten', async () => {
    remember(ANA, 'alquimia');
    const closed: TopicList = {
      items: TOPICS.items.map((one) =>
        one.slug === 'alquimia' ? { ...one, canOpen: false } : one,
      ),
      defaultSlug: null,
    };
    const first = await setup({ keepStorage: true, topics: closed });
    expect(first.store.topicSlug()).toBe('hermetismo');
    // The fallback is not a choice: it does not write over the remembered one.
    expect(localStorage.getItem(keyOf(ANA))).toBe('alquimia');
    TestBed.resetTestingModule();
    const gone = await setup({
      keepStorage: true,
      topics: { items: TOPICS.items.slice(0, 1), defaultSlug: null },
    });
    expect(gone.store.topicSlug()).toBe('hermetismo');
    expect(localStorage.getItem(keyOf(ANA))).toBe('alquimia');
    // The access comes back: so does the collection.
    TestBed.resetTestingModule();
    const back = await setup({ keepStorage: true });
    expect(back.store.topicSlug()).toBe('alquimia');
  });

  it('AC-4 (BR-1): the next person in the same browser gets their own collection', async () => {
    remember(ANA, 'alquimia');
    const { store } = await setup({
      keepStorage: true,
      email: 'bia@example.com',
    });
    expect(store.topicSlug()).toBe('hermetismo');
    store.selectTopic('alquimia');
    store.selectTopic('hermetismo');
    expect(localStorage.getItem(keyOf('bia@example.com'))).toBe('hermetismo');
    expect(localStorage.getItem(keyOf(ANA))).toBe('alquimia');
  });

  it('nobody signed in: nothing is read or kept', async () => {
    const { store } = await setup({ email: null });
    store.selectTopic('alquimia');
    expect(store.topicSlug()).toBe('alquimia');
    expect(localStorage.length).toBe(
      Object.keys(localStorage).filter((k) => !k.startsWith('kb-chat.topic'))
        .length,
    );
  });

  it('AC-5 (BR-4): a storage that throws leaves the default and the choice for the session', async () => {
    remember(ANA, 'alquimia');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { store } = await setup({ keepStorage: true });
    expect(store.topicSlug()).toBe('hermetismo');
    store.selectTopic('alquimia');
    expect(store.topicSlug()).toBe('alquimia');
  });

  it('AC-6 (FR-3): opening a conversation of another collection keeps that collection', async () => {
    const { store, answer } = await setup();
    const conversation: SearchConversation = {
      kind: 'search',
      id: 'c-1',
      topic: 'alquimia',
      title: 'pedra',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      asks: [
        { question: 'pedra', mode: 'all', filters: EMPTY_FILTERS, total: 1 },
      ],
    };
    store.restore(conversation);
    answer(0);
    expect(localStorage.getItem(keyOf(ANA))).toBe('alquimia');
  });
});
