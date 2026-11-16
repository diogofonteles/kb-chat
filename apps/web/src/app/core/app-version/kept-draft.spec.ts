import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SessionStore } from '@core/auth/session-store.js';
import { aMe } from '../../testing/session-fixtures.js';
import { DRAFT_OWNER, ownerOf } from './kept-draft.js';

describe('DRAFT_OWNER (KBC-123 review R2-5)', () => {
  function ownerWith(me: ReturnType<typeof aMe> | null) {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: SessionStore, useValue: { me: signal(me) } },
      ],
    });
    return TestBed.inject(DRAFT_OWNER);
  }

  it('is a short hash of who is signed in, never the e-mail itself', () => {
    const owner = ownerWith(aMe({ email: 'ana@example.com' }));
    expect(owner()).toBe(ownerOf('ana@example.com'));
    expect(owner()).toMatch(/^[0-9a-f]{16}$/);
    expect(ownerOf('ana@example.com')).not.toBe(ownerOf('bia@example.com'));
  });

  it('is nobody while signed out', () => {
    expect(ownerWith(null)()).toBeNull();
  });
});
