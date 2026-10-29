import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { fireEvent, screen } from '@testing-library/angular';
import {
  MEDIA_ELEMENT_FACTORY,
  MediaEngine,
} from '@core/media/media-engine.js';
import {
  fakeMediaElement,
  type FakeMedia,
} from '../../../testing/fake-media-element.js';
import { SessionStore } from '@core/auth/session-store.js';
import { signal } from '@angular/core';
import { ListeningPreferences } from '@core/media/listening-preferences.js';
import { MiniPlayer } from './mini-player.js';

const ID = '11111111-1111-4111-8111-111111111111';
const SOURCE = {
  id: ID,
  title: 'Palestra de 1998',
  src: '/s',
  durationMs: 600_000,
};

@Component({
  template: '<main><h1>Conversa</h1><app-mini-player /></main>',
  imports: [MiniPlayer],
})
class Shell {}

async function setup(url = '/') {
  localStorage.clear();
  const media: FakeMedia = fakeMediaElement();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: MEDIA_ELEMENT_FACTORY, useValue: () => media.element },
      { provide: SessionStore, useValue: { me: signal(null) } },
      provideRouter([
        { path: '', component: Shell },
        { path: 'midia/:id', component: Shell },
      ]),
    ],
  });
  const harness = await RouterTestingHarness.create(url);
  const engine = TestBed.inject(MediaEngine);
  engine.load(SOURCE);
  media.setDuration(600);
  media.emit('loadedmetadata');
  engine.play();
  media.emit('playing');
  media.setCurrentTime(150);
  media.emit('timeupdate');
  await harness.fixture.whenStable();
  return {
    harness,
    engine,
    media,
    http: TestBed.inject(HttpTestingController),
  };
}

describe('MiniPlayer (KBC-041 FR-8)', () => {
  it('shows what plays, its time and a link back to the player (AC-10)', async () => {
    await setup();
    const link = screen.getByRole('link', { name: 'Palestra de 1998' });
    expect(link.getAttribute('href')).toBe(`/midia/${ID}`);
    const progress = screen.getByRole('progressbar', { name: 'Posição' });
    expect(progress.getAttribute('aria-valuenow')).toBe('25');
    expect(progress.getAttribute('aria-valuetext')).toBe(
      '2 minutos e 30 segundos de 10 minutos',
    );
    expect(screen.getByText('2:30')).toBeTruthy();
  });

  it('is not shown on the media’s own page', async () => {
    const { harness } = await setup(`/midia/${ID}`);
    expect(screen.queryByRole('region', { name: 'Mini-player' })).toBeNull();
    await harness.navigateByUrl('/');
    expect(screen.getByRole('region', { name: 'Mini-player' })).toBeTruthy();
  });

  it('pauses, goes back 15 s and plays from the bar', async () => {
    const { media, harness } = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Voltar 15 segundos' }));
    expect(media.calls.at(-1)).toBe('seek:135');
    fireEvent.click(screen.getByRole('button', { name: 'Pausar' }));
    expect(media.calls.at(-1)).toBe('pause');
    media.setPaused(true);
    media.emit('pause');
    await harness.fixture.whenStable();
    expect(screen.getByRole('button', { name: 'Tocar' })).toBeTruthy();
  });

  it('closes: stops, saves the position and goes away (AC-11)', async () => {
    const { media, http, harness, engine } = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Fechar o player' }));
    await harness.fixture.whenStable();
    expect(media.calls).toContain('pause');
    expect(
      http.expectOne({ method: 'PUT', url: `/api/v1/media/${ID}/progress` })
        .request.body,
    ).toEqual({ positionMs: 150_000, basedOn: null });
    expect(engine.source()).toBeNull();
    expect(screen.queryByRole('region', { name: 'Mini-player' })).toBeNull();
    // The focus goes to the main area, not to <body> (WCAG 2.4.3).
    expect(document.activeElement?.tagName).toBe('MAIN');
  });

  it('stops and says why when the media is gone from the server', async () => {
    const { media, http, harness } = await setup();
    media.setPaused(true);
    media.emit('pause');
    await harness.fixture.whenStable();
    http
      .expectOne({ method: 'PUT', url: `/api/v1/media/${ID}/progress` })
      .flush(
        { error: { code: 'MEDIA_NOT_FOUND', message: 'x' } },
        { status: 404, statusText: 'Not Found' },
      );
    await harness.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Esta mídia não está mais no acervo',
    );
    expect(
      screen
        .getByRole('button', { name: /Tocar|Pausar/ })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(media.calls.at(-1)).toBe('pause');
  });

  it('says the audio stopped on an error, and tries again', async () => {
    const { media, harness } = await setup();
    media.setError(2);
    media.emit('error');
    await harness.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Não consegui continuar o áudio.',
    );
    screen.getByRole('button', { name: 'Tentar de novo' }).click();
    expect(media.calls).toContain('load:/s');
  });

  it('takes the player shortcuts while the focus is inside it', async () => {
    const { media } = await setup();
    const back = screen.getByRole('button', { name: 'Voltar 15 segundos' });
    fireEvent.keyDown(back, { key: 'l' });
    expect(media.calls.at(-1)).toBe('seek:180');
  });

  it('keeps the status region on every page', async () => {
    const { engine, harness } = await setup();
    engine.unload();
    await harness.fixture.whenStable();
    expect(screen.getAllByRole('status').length).toBe(1);
    expect(TestBed.inject(Router).url).toBe('/');
  });

  it('goes back by the person’s skip, and says so (KBC-043 FR-2)', async () => {
    const { media, harness } = await setup();
    TestBed.inject(ListeningPreferences).setSkipBack(10);
    await harness.fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Voltar 10 segundos' }));
    expect(media.calls.at(-1)).toBe('seek:140');
  });
});
