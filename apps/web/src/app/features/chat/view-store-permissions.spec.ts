import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Feature } from '@kb-chat/contracts';
import { SessionStore } from '@core/auth/session-store.js';
import { SpendStore } from '@core/spend/spend-store.js';
import { SettingsStore } from '@features/settings/settings-store.js';
import { aSettingsView } from '../../testing/settings-fixtures.js';
import { ViewStore } from './view-store.js';

function setup(features: readonly Feature[]) {
  localStorage.clear();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      ViewStore,
      {
        provide: SpendStore,
        useValue: { configured: signal(true), refresh: vi.fn() },
      },
      {
        provide: SettingsStore,
        useValue: { settings: signal(aSettingsView()) },
      },
      {
        provide: SessionStore,
        useValue: { can: (f: Feature) => features.includes(f) },
      },
    ],
  });
  return TestBed.inject(ViewStore);
}

describe('ViewStore per permission (KBC-010 AC-3)', () => {
  it('keeps a person without research in the search view, with no switch', () => {
    const views = setup(['search']);

    expect(views.current()).toBe('search');
    expect(views.researchAvailable()).toBe(false);
    expect(views.bothAllowed()).toBe(false);
    views.select('research');
    expect(views.current()).toBe('search');
  });

  it('opens the research view for a person with research only', () => {
    const views = setup(['research']);
    expect(views.current()).toBe('research');
    expect(views.bothAllowed()).toBe(false);
  });

  it('offers both views with both features', () => {
    expect(setup(['search', 'research']).bothAllowed()).toBe(true);
  });
});
