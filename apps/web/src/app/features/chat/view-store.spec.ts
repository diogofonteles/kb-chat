import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SpendStore } from '@core/spend/spend-store.js';
import { ViewStore } from './view-store.js';

function setup(configured = true) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      ViewStore,
      { provide: SpendStore, useValue: { configured: signal(configured) } },
    ],
  });
  return TestBed.inject(ViewStore);
}

describe('ViewStore (KBC-008 FR-5)', () => {
  beforeEach(() => localStorage.clear());

  it('starts in the research view when a provider is configured', () => {
    expect(setup().current()).toBe('research');
  });

  it('remembers the chosen view in the browser', () => {
    setup().select('search');
    expect(localStorage.getItem('kb-chat.view')).toBe('search');
    TestBed.resetTestingModule();
    expect(setup().current()).toBe('search');
  });

  it('stays in the search view without a provider, even when research was remembered', () => {
    localStorage.setItem('kb-chat.view', 'research');
    const views = setup(false);
    views.select('research');
    expect(views.current()).toBe('search');
    expect(views.researchAvailable()).toBe(false);
  });

  it('ignores an unknown remembered value', () => {
    localStorage.setItem('kb-chat.view', 'other');
    expect(setup().current()).toBe('research');
  });
});
