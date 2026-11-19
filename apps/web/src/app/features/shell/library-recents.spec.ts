import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SessionStore } from '@core/auth/session-store.js';
import type { Me } from '@kb-chat/contracts';
import { aMe } from '../../testing/session-fixtures.js';
import { LibraryRecents } from './library-recents.js';

const storedKeys = () =>
  Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));

describe('LibraryRecents (KBC-125 FR-5)', () => {
  const me = signal<Me | null>(null);

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: SessionStore, useValue: { me } },
      ],
    });
  });

  afterEach(() => localStorage.clear());

  const doc = { topic: 'alquimia', id: 'a.md', title: 'Tratado secreto' };

  it('never shows one account the documents another opened in the same browser', () => {
    me.set(aMe({ email: 'ana@example.com' }));
    const recents = TestBed.inject(LibraryRecents);
    recents.noteDocument(doc, 1);
    recents.noteCollection('alquimia', 1);
    expect(recents.documents().map((d) => d.title)).toEqual([
      'Tratado secreto',
    ]);

    // Ana signs out and Bruno signs in, in the same browser.
    me.set(null);
    expect(recents.documents()).toEqual([]);
    me.set(aMe({ email: 'bruno@example.com' }));
    expect(recents.documents()).toEqual([]);
    expect(recents.collections()).toEqual({});
    // Nor the address of who used it before.
    expect(storedKeys().join()).not.toContain('ana@');

    // Back to Ana: her own list is still there.
    me.set(aMe({ email: 'ana@example.com' }));
    expect(recents.documents().map((d) => d.title)).toEqual([
      'Tratado secreto',
    ]);
  });

  it('keeps nothing on disk with no one signed in, and drops the old shared list', () => {
    localStorage.setItem(
      'kb-chat.library-recents',
      JSON.stringify({ documents: [{ ...doc, at: 1 }] }),
    );
    me.set(null);
    const recents = TestBed.inject(LibraryRecents);
    expect(recents.documents()).toEqual([]);
    expect(localStorage.getItem('kb-chat.library-recents')).toBeNull();
    recents.noteDocument(doc, 2);
    expect(localStorage.length).toBe(0);
  });
});
