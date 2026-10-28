import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import {
  MEDIA_ELEMENT_FACTORY,
  MediaEngine,
} from '@core/media/media-engine.js';
import {
  fakeMediaElement,
  type FakeMedia,
} from '../../../testing/fake-media-element.js';
import { MediaPlayer } from './media-player.js';

const SOURCE = { id: 'm1', title: 'Palestra', src: '/api/v1/media/m1/stream' };

async function renderPlayer(
  prepare: (media: FakeMedia, engine: MediaEngine) => void = () => undefined,
) {
  const media = fakeMediaElement('audio');
  const view = await render(MediaPlayer, {
    providers: [
      provideZonelessChangeDetection(),
      { provide: MEDIA_ELEMENT_FACTORY, useValue: () => media.element },
    ],
  });
  const engine = TestBed.inject(MediaEngine);
  prepare(media, engine);
  await view.fixture.whenStable();
  return { ...view, media, engine };
}

/** 1 h 2 min 15 s, loaded and paused. */
function loaded(media: FakeMedia, engine: MediaEngine) {
  engine.load(SOURCE);
  media.setDuration(3_735);
  media.emit('loadedmetadata');
  media.emit('canplay');
}

describe('MediaPlayer (T15 basic controls)', () => {
  it('disables the controls while there is no source', async () => {
    await renderPlayer();
    for (const name of ['Tocar', 'Voltar 15 segundos', 'Avançar 30 segundos'])
      expect(
        screen.getByRole('button', { name }).hasAttribute('disabled'),
      ).toBe(true);
  });

  it('lets "Tocar" start a source still loading, then shows it is busy', async () => {
    const { container, media, fixture } = await renderPlayer((fake, engine) =>
      engine.load(SOURCE),
    );
    const play = screen.getByRole('button', { name: 'Tocar' });
    expect(play.hasAttribute('disabled')).toBe(false);
    expect(
      screen
        .getByRole('button', { name: 'Voltar 15 segundos' })
        .hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(play);
    await fixture.whenStable();
    expect(media.calls.at(-1)).toBe('play');
    expect(
      screen.getByRole('button', { name: 'Carregando. Pausar' }),
    ).toBeTruthy();
    expect(container.querySelector('.play .spinner')).not.toBeNull();
  });

  it('plays, and turns into "Pausar" only when the audio really plays (AC-10)', async () => {
    const { media, fixture } = await renderPlayer(loaded);
    fireEvent.click(screen.getByRole('button', { name: 'Tocar' }));
    expect(media.calls).toContain('play');
    await fixture.whenStable();
    expect(screen.getByRole('button', { name: 'Tocar' })).toBeTruthy();
    media.emit('playing');
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Pausar' }));
    expect(media.calls.at(-1)).toBe('pause');
  });

  it('skips back 15 s and forward 30 s', async () => {
    const { media } = await renderPlayer(loaded);
    fireEvent.click(
      screen.getByRole('button', { name: 'Avançar 30 segundos' }),
    );
    expect(media.calls.at(-1)).toBe('seek:30');
    fireEvent.click(screen.getByRole('button', { name: 'Voltar 15 segundos' }));
    expect(media.calls.at(-1)).toBe('seek:15');
  });

  it('shows elapsed and remaining time, and switches to the total on a tap', async () => {
    const { media, fixture, container } = await renderPlayer(loaded);
    media.emit('seeked');
    media.setCurrentTime(1_390);
    media.emit('timeupdate');
    await fixture.whenStable();
    expect(container.querySelector('.elapsed')?.textContent).toBe('23:10');
    const right = screen.getByRole('button', { name: /Tempo restante/ });
    expect(right.textContent?.trim()).toBe('-39:05');
    fireEvent.click(right);
    await fixture.whenStable();
    expect(
      screen.getByRole('button', { name: /Duração total/ }).textContent?.trim(),
    ).toBe('1:02:15');
  });

  it('seeks from the slider, stepping from the live position on fast keys (AC-11)', async () => {
    const { media } = await renderPlayer(loaded);
    const slider = screen.getByRole('slider');
    // Three presses with no render between them, as a held-down arrow does.
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(media.calls.filter((call) => call.startsWith('seek:'))).toEqual([
      'seek:5',
      'seek:10',
      'seek:15',
    ]);
    fireEvent.keyDown(slider, { key: 'End' });
    expect(media.calls.at(-1)).toBe('seek:3735');
  });

  it('says the audio failed and retries from the same second (AC-12)', async () => {
    const { media, fixture } = await renderPlayer(loaded);
    media.emit('seeked');
    media.setCurrentTime(23);
    media.emit('timeupdate');
    media.setError(2);
    media.emit('error');
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Não consegui carregar o áudio. Verifique a conexão.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    media.setError(null);
    media.setDuration(3_735);
    media.emit('loadedmetadata');
    // Reload, play at once (a gesture), then seek back to 0:23 as soon as it is known.
    const afterRetry = media.calls.slice(
      media.calls.lastIndexOf(`load:${SOURCE.src}`),
    );
    expect(afterRetry).toEqual([`load:${SOURCE.src}`, 'play', 'seek:23']);
  });

  it.each([
    [3, 'Este áudio não pôde ser tocado neste navegador.'],
    [1, 'O carregamento do áudio foi interrompido.'],
  ])('explains error code %i', async (code, message) => {
    const { media, fixture } = await renderPlayer(loaded);
    media.setError(code);
    media.emit('error');
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(message);
  });

  it('says to check the connection when a source fails to load (Safari reports code 4)', async () => {
    const { media, fixture } = await renderPlayer((fake, engine) =>
      engine.load(SOURCE),
    );
    media.setError(4);
    media.emit('error');
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Não consegui carregar o áudio. Verifique a conexão.',
    );
  });

  it('offers "Ouvir de novo" at the end, which plays from the start', async () => {
    const { media, fixture } = await renderPlayer(loaded);
    media.emit('playing');
    media.emit('ended');
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Ouvir de novo' }));
    expect(media.calls.slice(-2)).toEqual(['seek:0', 'play']);
  });

  it('shows the waiting indicator only after the debounce', async () => {
    const { media } = await renderPlayer(loaded);
    // Fake timers only after rendering: the render waits on real timers.
    vi.useFakeTimers();
    try {
      media.emit('playing');
      media.emit('waiting');
      TestBed.tick();
      expect(
        screen.queryByRole('button', { name: 'Carregando. Pausar' }),
      ).toBeNull();
      vi.advanceTimersByTime(300);
      TestBed.tick();
      expect(
        screen.getByRole('button', { name: 'Carregando. Pausar' }),
      ).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
