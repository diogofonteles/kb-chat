import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { EMPTY_FILTERS } from '@kb-chat/contracts';
import {
  HistoryStore,
  MAX_CONVERSATIONS,
  upsertConversation,
  type Conversation,
} from './history-store.js';

const aConversation = (
  id: string,
  question = `pergunta ${id}`,
): Conversation => ({
  id,
  topic: 'hermetismo',
  asks: [{ question, mode: 'all', filters: EMPTY_FILTERS, total: 3 }],
  updatedAt: '2026-10-24T12:00:00.000Z',
});

function createStore(): HistoryStore {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection()],
  });
  return TestBed.inject(HistoryStore);
}

describe('HistoryStore (KBC-005 BR-1)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('keeps the newest first and moves an updated conversation to the top', () => {
    const history = upsertConversation(
      upsertConversation([aConversation('a')], aConversation('b')),
      aConversation('a', 'nova'),
    );
    expect(history.map((c) => [c.id, c.asks[0]?.question])).toEqual([
      ['a', 'nova'],
      ['b', 'pergunta b'],
    ]);
  });

  it('drops the oldest when the 51st conversation is saved (AC-3)', () => {
    const store = createStore();
    for (let n = 1; n <= MAX_CONVERSATIONS + 1; n++)
      store.save(aConversation(String(n)));
    const ids = store.conversations().map((c) => c.id);
    expect(ids).toHaveLength(MAX_CONVERSATIONS);
    expect(ids[0]).toBe('51');
    expect(ids).not.toContain('1');
  });

  it('survives a reload from localStorage', () => {
    createStore().save(aConversation('a'));
    TestBed.resetTestingModule();
    const store = createStore();
    expect(store.find('a')?.asks[0]?.question).toBe('pergunta a');
    expect(store.available()).toBe(true);
  });

  it('ignores unreadable data from an older version', () => {
    localStorage.setItem('kb-chat.history', '{"not":"a list"}');
    const store = createStore();
    expect(store.conversations()).toEqual([]);
    expect(store.available()).toBe(true);
  });

  it('runs without history when localStorage throws (AC-4)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const store = createStore();
    store.save(aConversation('a'));
    expect(store.available()).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('marks the history unavailable when a write fails', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const store = createStore();
    store.save(aConversation('a'));
    expect(store.available()).toBe(false);
    expect(store.conversations()).toHaveLength(1);
  });
});
