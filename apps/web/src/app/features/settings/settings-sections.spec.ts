import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { screen, within } from '@testing-library/angular';
import type { Me } from '@kb-chat/contracts';
import { RELOAD_PAGE, SessionStore } from '@core/auth/session-store.js';
import { TOPICS } from '../../testing/fixtures.js';
import {
  aSettingsView,
  flushAiStatus,
} from '../../testing/settings-fixtures.js';
import { aMe, anOwner } from '../../testing/session-fixtures.js';
import { SettingsHost } from './settings-host.js';
import { SettingsStore } from './settings-store.js';
import { LEND_NONE } from '../../testing/lending-fixtures.js';

async function openSettingsAs(me: Me, section: 'people' | null = null) {
  localStorage.clear();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: RELOAD_PAGE, useValue: () => undefined },
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  TestBed.inject(SessionStore).signIn('credential').subscribe();
  http.expectOne('/api/v1/auth/google').flush(me);
  const fixture = TestBed.createComponent(SettingsHost);
  document.body.appendChild(fixture.nativeElement);
  TestBed.inject(SettingsStore).openSettings(section);
  TestBed.tick();
  http.expectOne('/api/v1/settings').flush(aSettingsView());
  flushAiStatus(http);
  TestBed.tick();
  return { fixture, http };
}

const sectionNames = () =>
  within(screen.getByRole('navigation', { name: 'Seções' }))
    .getAllByRole('button')
    .map((b) => b.textContent?.trim());

describe('Configurações per permission (KBC-010)', () => {
  it('shows a guest without own AI settings only what they may change, and no wizard', async () => {
    const { http, fixture } = await openSettingsAs(
      aMe({ features: ['search'] }),
    );
    TestBed.tick();
    for (const request of http.match('/api/v1/topics')) request.flush(TOPICS);
    await fixture.whenStable();

    expect(sectionNames()).toEqual(['Preferências', 'Sobre']);
    expect(
      screen.getByRole('heading', { name: 'Preferências', level: 3 }),
    ).toBeTruthy();
    http.expectNone('/api/v1/ai/providers');
    expect(TestBed.inject(SettingsStore).firstRun()).toBe(false);
  });

  it('opens "Pessoas e permissões" for a master from the sidebar entry', async () => {
    const { http, fixture } = await openSettingsAs(anOwner(), 'people');
    http.expectOne('/api/v1/ai/providers').flush({ items: [], active: 'none' });
    flushAiStatus(http);
    TestBed.tick();

    expect(sectionNames()).toEqual([
      'Sua IA',
      'IA da aplicação',
      'Preferências',
      'Pessoas e permissões',
      'Sobre',
    ]);
    expect(
      screen.getByRole('heading', { name: 'Pessoas e permissões', level: 3 }),
    ).toBeTruthy();
    http
      .expectOne('/api/v1/house-ai/default')
      .flush({ defaultAppAi: 'house', lendable: LEND_NONE });
    http.expectOne('/api/v1/people').flush({ items: [] });
    http.expectOne('/api/v1/topics').flush({ items: [], defaultSlug: null });
    http.expectOne('/api/v1/spend/people').flush({ items: [] });
    http.expectOne('/api/v1/access-requests').flush({ items: [] });
    await fixture.whenStable();
  });
});
