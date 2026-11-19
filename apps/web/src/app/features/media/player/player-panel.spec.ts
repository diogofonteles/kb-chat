import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import {
  Component,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { fireEvent, screen } from '@testing-library/angular';
import { SessionStore } from '@core/auth/session-store.js';
import {
  MEDIA_ELEMENT_FACTORY,
  MediaEngine,
} from '@core/media/media-engine.js';
import { RightPanel } from '@features/shell/right-panel.js';
import {
  fakeMediaElement,
  type FakeMedia,
} from '../../../testing/fake-media-element.js';
import { aMediaItem } from '../../../testing/media-fixtures.js';
import { PlayerPanel } from './player-panel.js';
import { PlayerPanelTabs } from './player-panel-tab.js';

const ID = '11111111-1111-4111-8111-111111111111';
const NEXT = '22222222-2222-4222-8222-222222222222';
const SOURCE = {
  id: ID,
  title: 'Palestra de 1998',
  src: '/s',
  durationMs: 600_000,
  artist: 'Irmã Helena Prado',
};

const item = (id: string, title: string) => ({
  tracks: [],
  ...aMediaItem({ id, title, durationMs: 60_000 }),
  kind: 'audio' as const,
  lastPlayedAt: '2026-11-17T12:00:00.000Z',
});

@Component({
  template: '<main><h1>Biblioteca</h1><app-player-panel /></main>',
  imports: [PlayerPanel],
})
class Shell {}

async function setup(tab: 'queue' | 'recent') {
  const media: FakeMedia = fakeMediaElement();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: MEDIA_ELEMENT_FACTORY, useValue: () => media.element },
      { provide: SessionStore, useValue: { me: signal(null) } },
      provideRouter([{ path: '', component: Shell }]),
    ],
  });
  TestBed.inject(PlayerPanelTabs).tab.set(tab);
  const harness = await RouterTestingHarness.create('/');
  const engine = TestBed.inject(MediaEngine);
  engine.load(SOURCE);
  media.setDuration(600);
  media.emit('loadedmetadata');
  media.setCurrentTime(150);
  media.emit('timeupdate');
  const http = TestBed.inject(HttpTestingController);
  // The strips are asked at once: answered before waiting, or the wait never ends.
  TestBed.tick();
  answerHome(http);
  await harness.fixture.whenStable();
  return { harness, engine, media, http };
}

/** The library's strips, which Fila and Ouvidas list (the app keeps no other queue). */
function answerHome(http: HttpTestingController): void {
  const request = http.match((one) =>
    one.url.startsWith('/api/v1/media/library/home'),
  );
  for (const one of request)
    one.flush({
      continueListening: [
        item(ID, SOURCE.title),
        item(NEXT, 'Leitura do Caibalion'),
      ],
      recentlyPlayed: [item(ID, SOURCE.title)],
      recentsClearedAt: null,
    });
}

describe('PlayerPanel (v2 · Mídia — Player: Sobre | Fila | Ouvidas)', () => {
  it('names its tabs and shows the chosen one, ← and → moving between them', async () => {
    const { harness, http } = await setup('queue');
    const tabs = screen
      .getAllByRole('tab')
      .map((tab) => tab.textContent?.trim());
    expect(tabs).toEqual(['Sobre', 'Fila', 'Ouvidas']);
    const fila = screen.getByRole('tab', { name: 'Fila' });
    expect(fila.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(
      'player-tab-queue',
    );

    fireEvent.keyDown(fila, { key: 'ArrowRight' });
    TestBed.tick();
    answerHome(http);
    await harness.fixture.whenStable();
    expect(TestBed.inject(PlayerPanelTabs).tab()).toBe('recent');
    expect(
      screen.getByRole('heading', { name: 'Ouvidas recentemente' }),
    ).toBeTruthy();
  });

  it('Fila: what plays now, then what is in progress to continue, without the one playing', async () => {
    await setup('queue');
    expect(screen.getByRole('heading', { name: 'Tocando agora' })).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: /Palestra de 1998/ })
        .getAttribute('href'),
    ).toBe(`/midia/${ID}`);
    const next = screen.getByRole('list');
    expect(next.textContent).toContain('Leitura do Caibalion');
    expect(next.textContent).not.toContain('Palestra de 1998');
  });

  it('Ouvidas: the recent plays, the one playing too', async () => {
    await setup('recent');
    expect(screen.getByRole('list').textContent).toContain('Palestra de 1998');
  });

  it('the ✕ closes the panel', async () => {
    const { harness } = await setup('queue');
    const panel = TestBed.inject(RightPanel);
    panel.open({ component: PlayerPanel, width: 'narrow', label: 'Fila' });
    fireEvent.click(screen.getByRole('button', { name: 'Fechar o painel' }));
    await harness.fixture.whenStable();
    expect(panel.content()).toBeNull();
  });
});
