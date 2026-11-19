import { ApplicationRef, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ThemeStore, shownTheme } from './theme-store.js';

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

  it('KBC-124 AC-1: with nothing chosen, no data-theme: the page is in the revised theme', async () => {
    const store = create();
    await TestBed.inject(ApplicationRef).whenStable();
    expect(store.theme()).toBe('auto');
    expect(shownTheme(store.theme())).toBe('revised');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('KBC-124 AC-1: a saved "light" stays light; "revised" and "system" are kept as chosen', async () => {
    for (const theme of ['light', 'revised', 'system'] as const) {
      TestBed.resetTestingModule();
      localStorage.setItem('kb-chat.theme', theme);
      const store = create();
      await TestBed.inject(ApplicationRef).whenStable();
      expect(store.theme()).toBe(theme);
      expect(document.documentElement.dataset['theme']).toBe(theme);
    }
  });
});
