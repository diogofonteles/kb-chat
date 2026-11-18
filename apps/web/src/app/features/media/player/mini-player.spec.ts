import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { fireEvent, screen, within } from '@testing-library/angular';
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
import { VOLUME_SUPPORT } from '@core/media/volume-support.js';
import { SleepTimerService } from '@core/media/sleep-timer.js';
import { RightPanel } from '@features/shell/right-panel.js';
import { MiniPlayer } from './mini-player.js';
import { NowPlayingPanel } from './now-playing-panel.js';
import { PlayerPanel } from './player-panel.js';
import { PlayerPanelTabs } from './player-panel-tab.js';

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

/** The chat page while the reading panel's full player shows the media (KBC-039). */
@Component({
  template: `<main><app-mini-player [shownElsewhere]="'${ID}'" /></main>`,
  imports: [MiniPlayer],
})
class ShellWithPanel {}

/** The desktop shell: the v2 player bar, with the volume where the browser allows it. */
@Component({
  template: '<main><app-mini-player [desktop]="true" /></main>',
  imports: [MiniPlayer],
})
class DesktopShell {}

async function setup(url = '/', volume = true) {
  localStorage.clear();
  const media: FakeMedia = fakeMediaElement();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: MEDIA_ELEMENT_FACTORY, useValue: () => media.element },
      { provide: SessionStore, useValue: { me: signal(null) } },
      { provide: VOLUME_SUPPORT, useValue: Promise.resolve(volume) },
      provideRouter([
        { path: 'barra', component: DesktopShell },
        { path: '', component: Shell },
        { path: 'midia/:id', component: Shell },
        { path: 'painel', component: ShellWithPanel },
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

  it('KBC-039: is not shown while the reading panel plays the same media', async () => {
    const { harness } = await setup('/painel');
    expect(screen.queryByRole('region', { name: 'Mini-player' })).toBeNull();
    await harness.navigateByUrl('/');
    expect(screen.getByRole('region', { name: 'Mini-player' })).toBeTruthy();
  });

  it('KBC-129 FR-2: the transcript button opens "Tocando agora" in the right panel and closes it', async () => {
    const { harness } = await setup();
    const panel = TestBed.inject(RightPanel);
    const button = screen.getByRole('button', { name: 'Tocando agora' });
    expect(button.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(button);
    await harness.fixture.whenStable();
    expect(panel.content()).toMatchObject({
      component: NowPlayingPanel,
      width: 'narrow',
      label: 'Tocando agora',
    });
    expect(button.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(button);
    await harness.fixture.whenStable();
    expect(panel.content()).toBeNull();
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('KBC-129: the queue button opens the player panel on Fila and closes it', async () => {
    const { harness } = await setup();
    const panel = TestBed.inject(RightPanel);
    const tabs = TestBed.inject(PlayerPanelTabs);
    const queue = screen.getByRole('button', { name: 'Fila' });
    expect(queue.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(queue);
    await harness.fixture.whenStable();
    expect(panel.content()).toMatchObject({
      component: PlayerPanel,
      width: 'narrow',
      label: 'Fila',
    });
    expect(tabs.tab()).toBe('queue');
    expect(queue.getAttribute('aria-pressed')).toBe('true');

    // The transcript button moves the same panel to Sobre, the queue one is off then.
    fireEvent.click(screen.getByRole('button', { name: 'Tocando agora' }));
    await harness.fixture.whenStable();
    expect(tabs.tab()).toBe('about');
    expect(queue.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(queue);
    await harness.fixture.whenStable();
    fireEvent.click(queue);
    await harness.fixture.whenStable();
    expect(panel.content()).toBeNull();
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

  it('has no ✕ of its own (v2: "Fechar o player" is in the player\'s ⋯) and goes when it closes (AC-11)', async () => {
    const { harness, engine } = await setup();
    const bar = screen.getByRole('region', { name: 'Mini-player' });
    expect(
      within(bar).queryByRole('button', { name: 'Fechar o player' }),
    ).toBeNull();
    engine.unload();
    await harness.fixture.whenStable();
    expect(screen.queryByRole('region', { name: 'Mini-player' })).toBeNull();
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

  it('says when a sleep timer will stop the audio on its green moon, and nothing once it is off (KBC-046 FR-1)', async () => {
    const { harness } = await setup('/barra');
    const bar = screen.getByRole('region', { name: 'Mini-player' });
    const moon = () => bar.querySelector<HTMLButtonElement>('button.moon');
    expect(moon()?.getAttribute('aria-label')).toBe('Timer para dormir');
    expect(moon()?.classList.contains('on')).toBe(false);
    const timer = TestBed.inject(SleepTimerService);
    timer.start(15);
    await harness.fixture.whenStable();
    // The bar's line stays plain (lib.js playerBar): the moon turns green and says it.
    expect(moon()?.getAttribute('aria-label')).toBe('Timer para dormir: 15:00');
    expect(moon()?.classList.contains('on')).toBe(true);
    // The phone's mini player says it beside the clock (CSS shows it below 1024 px only).
    expect(bar.querySelector('.sleep')?.textContent).toContain(
      'Timer para dormir: 15:00',
    );
    timer.start('end-of-media');
    await harness.fixture.whenStable();
    expect(moon()?.getAttribute('aria-label')).toBe(
      'Timer para dormir: No fim',
    );
    timer.off();
    await harness.fixture.whenStable();
    expect(moon()?.getAttribute('aria-label')).toBe('Timer para dormir');
    expect(bar.querySelector('.sleep')).toBeNull();
  });

  it('offers mute and volume in percent on the desktop bar where the browser allows it (KBC-041 AC-13)', async () => {
    const { harness, media } = await setup('/barra');
    await harness.fixture.whenStable();
    const volume = screen.getByRole('slider', { name: 'Volume' });
    expect(volume.getAttribute('aria-valuetext')).toBe('100%');
    fireEvent.input(volume, { target: { value: '40' } });
    await harness.fixture.whenStable();
    expect(media.element.volume).toBe(0.4);
    expect(volume.getAttribute('aria-valuetext')).toBe('40%');
    expect(localStorage.getItem('kb-chat.player.volume')).toBe('0.4');
    const mute = screen.getByRole('button', { name: 'Silenciar' });
    expect(mute.getAttribute('aria-keyshortcuts')).toBe('M');
    fireEvent.click(mute);
    await harness.fixture.whenStable();
    expect(media.element.muted).toBe(true);
    // One name, and the pressed state says it is on (not a name that also changes).
    expect(
      screen
        .getByRole('button', { name: 'Silenciar' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('has no volume control on the bar where the volume is read-only (iPhone, AC-13)', async () => {
    const { harness } = await setup('/barra', false);
    await harness.fixture.whenStable();
    expect(screen.queryByRole('slider', { name: 'Volume' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Silenciar' })).toBeNull();
    expect(
      harness.fixture.nativeElement
        .querySelector('[data-volume]')
        ?.getAttribute('data-volume'),
    ).toBe('off');
  });
});
