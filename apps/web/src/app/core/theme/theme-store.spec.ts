import { ApplicationRef, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ThemeStore } from './theme-store.js';

const create = () => {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection()],
  });
  return TestBed.inject(ThemeStore);
};

describe('ThemeStore (KBC-005 BR-3)', () => {
  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    vi.restoreAllMocks();
  });

  it('starts from the remembered theme and applies it to <html>', async () => {
    localStorage.setItem('kb-chat.theme', 'esoteric');
    const store = create();
    await TestBed.inject(ApplicationRef).whenStable();
    expect(store.theme()).toBe('esoteric');
    expect(document.documentElement.dataset['theme']).toBe('esoteric');
  });

  it('falls back to "auto" for an unknown value or blocked storage', () => {
    localStorage.setItem('kb-chat.theme', 'neon');
    expect(create().theme()).toBe('auto');
    TestBed.resetTestingModule();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(create().theme()).toBe('auto');
  });
});
