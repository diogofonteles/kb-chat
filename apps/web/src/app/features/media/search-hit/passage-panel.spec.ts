import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { fireEvent, render, screen } from '@testing-library/angular';
import {
  MEDIA_ELEMENT_FACTORY,
  MediaEngine,
} from '@core/media/media-engine.js';
import { VOLUME_SUPPORT } from '@core/media/volume-support.js';
import type { MediaHit } from '@kb-chat/contracts';
import {
  fakeMediaElement,
  type FakeMedia,
} from '../../../testing/fake-media-element.js';
import { aMediaHit } from '../../../testing/fixtures.js';
import { aMediaItem } from '../../../testing/media-fixtures.js';
import { PassagePanel } from './passage-panel.js';
import { playbackStartOf } from './passage-focus.js';

const HIT = aMediaHit({ mediaId: aMediaItem().id });
const ITEM_URL = `/api/v1/media/${HIT.mediaId}`;

async function openPanel(passage: MediaHit = HIT): Promise<{
  media: FakeMedia;
  http: HttpTestingController;
  closed: ReturnType<typeof vi.fn>;
  rerender: (hit: MediaHit) => Promise<void>;
}> {
  const media = fakeMediaElement('audio');
  const closed = vi.fn();
  const view = await render(PassagePanel, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: MEDIA_ELEMENT_FACTORY, useValue: () => media.element },
      { provide: VOLUME_SUPPORT, useValue: Promise.resolve(false) },
    ],
    inputs: { passage },
    on: { closed },
  });
  return {
    media,
    http: TestBed.inject(HttpTestingController),
    closed,
    rerender: async (hit) => {
      await view.rerender({ inputs: { passage: hit }, partialUpdate: true });
      // Effects (toObservable) run with the app's change detection.
      TestBed.tick();
    },
  };
}

describe('PassagePanel (KBC-039 FR-3, FR-6)', () => {
  afterEach(() => TestBed.inject(MediaEngine).unload());

  it('shows the passage with its words marked and plays the audio from 2 s before it (AC-1, AC-10)', async () => {
    const { media, http } = await openPanel();
    http.expectOne(ITEM_URL).flush(aMediaItem());
    await screen.findByRole('slider', { name: 'Posição' });

    expect(
      screen.getByRole('heading', { name: 'Palestra do Tiuaco' }),
    ).toBeTruthy();
    expect(screen.getByText(/Áudio · Na fala/)).toBeTruthy();
    expect(screen.getByText('aos 8 minutos e 15 segundos')).toBeTruthy();
    const marks = [...document.querySelectorAll('blockquote mark')].map(
      (mark) => mark.textContent,
    );
    expect(marks).toEqual(['Tiuaco', 'Mariri']);
    expect(media.calls).toContain(`load:${ITEM_URL}/stream`);
    expect(media.calls).toContain('play');
    const engine = TestBed.inject(MediaEngine);
    expect(engine.source()?.id).toBe(HIT.mediaId);
    expect(engine.playback().currentMs).toBe(493_000);
    expect(playbackStartOf({ startMs: 1_000 })).toBe(0);
  });

  it('links to the media page at the passage second', async () => {
    const { http } = await openPanel();
    http.expectOne(ITEM_URL).flush(aMediaItem());
    const link = await screen.findByRole('link', {
      name: 'Abrir na página da mídia',
    });
    expect(link.getAttribute('href')).toBe(`/midia/${HIT.mediaId}?t=493`);
  });

  it('says a low-confidence transcript may be wrong (BR-3)', async () => {
    const { http } = await openPanel(
      aMediaHit({ mediaId: HIT.mediaId, confidence: 'low' }),
    );
    http.expectOne(ITEM_URL).flush(aMediaItem());
    expect(
      await screen.findByText(
        'Transcrição automática de baixa confiança: pode haver trechos errados.',
      ),
    ).toBeTruthy();
  });

  it('says the audio is gone when it was removed meanwhile, and closes with Fechar or Esc', async () => {
    const { http, closed, media } = await openPanel();
    http
      .expectOne(ITEM_URL)
      .flush(
        { error: { code: 'MEDIA_NOT_FOUND', message: 'Unknown media' } },
        { status: 404, statusText: 'Not Found' },
      );
    expect(
      await screen.findByText('Esta mídia não está mais disponível.'),
    ).toBeTruthy();
    expect(media.calls).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: /Fechar/ }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(closed).toHaveBeenCalledTimes(2);
  });

  it('moves to another passage of the same audio without loading it again', async () => {
    const { http, media, rerender } = await openPanel();
    http.expectOne(ITEM_URL).flush(aMediaItem());
    await screen.findByRole('slider', { name: 'Posição' });
    media.setDuration(3_735);
    media.emit('loadedmetadata');
    media.emit('seeked');
    await rerender(aMediaHit({ mediaId: HIT.mediaId, startMs: 60_000 }));
    for (const again of http.match(ITEM_URL)) again.flush(aMediaItem());
    media.emit('seeked');
    await vi.waitFor(() =>
      expect(TestBed.inject(MediaEngine).playback().currentMs).toBe(58_000),
    );
    expect(media.calls.filter((call) => call.startsWith('load:'))).toHaveLength(
      1,
    );
  });
});
