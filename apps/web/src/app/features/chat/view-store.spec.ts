import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { DefaultView, SettingsView } from '@kb-chat/contracts';
import { SpendStore } from '@core/spend/spend-store.js';
import { SettingsStore } from '@features/settings/settings-store.js';
import { aSettingsView } from '../../testing/settings-fixtures.js';
import { ViewStore } from './view-store.js';

const settings = signal<SettingsView | null>(null);

const refresh = vi.fn();

function setup(configured = true) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      ViewStore,
      {
        provide: SpendStore,
        useValue: { configured: signal(configured), refresh },
      },
      { provide: SettingsStore, useValue: { settings } },
    ],
  });
  return TestBed.inject(ViewStore);
}

const withDefaultView = (defaultView: DefaultView): SettingsView =>
  aSettingsView({
    preferences: {
      searchMode: 'all',
      theme: 'auto',
      defaultView,
      researchProfile: 'fast',
      autoDeepen: true,
    },
  });

describe('ViewStore (KBC-008 FR-5)', () => {
  beforeEach(() => {
    localStorage.clear();
    settings.set(null);
    refresh.mockClear();
  });

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

  it('leaves the research view at once when Settings save "Nenhum", and asks the API again', () => {
    settings.set(aSettingsView());
    const views = setup();
    TestBed.tick();
    expect(views.current()).toBe('research');
    settings.set(
      aSettingsView({
        ai: { provider: 'none', models: {}, keys: {}, dailyCapUsd: 1 },
      }),
    );
    TestBed.tick();
    expect(views.researchAvailable()).toBe(false);
    expect(views.current()).toBe('search');
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('ignores an unknown remembered value', () => {
    localStorage.setItem('kb-chat.view', 'other');
    expect(setup().current()).toBe('research');
  });

  it("starts in the Settings' default view when this browser never chose one (KBC-007)", () => {
    settings.set(withDefaultView('search'));
    const views = setup();
    expect(views.current()).toBe('search');
    settings.set(withDefaultView('research'));
    expect(views.current()).toBe('research');
  });

  it("keeps a view chosen in this browser over the Settings' default", () => {
    settings.set(withDefaultView('search'));
    localStorage.setItem('kb-chat.view', 'research');
    expect(setup().current()).toBe('research');
  });

  it('never opens the research view by default without a provider', () => {
    settings.set(withDefaultView('research'));
    expect(setup(false).current()).toBe('search');
  });
});
