import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { fireEvent, screen } from '@testing-library/angular';
import {
  MEDIA_ELEMENT_FACTORY,
  MediaEngine,
} from '@core/media/media-engine.js';
import {
  fakeMediaElement,
  type FakeMedia,
} from '../../testing/fake-media-element.js';
import { aMediaItem } from '../../testing/media-fixtures.js';
import { MediaPlayerPage } from './media-player-page.js';
import { MEDIA_POLL_MS } from './media-polling.js';
import { VOLUME_SUPPORT } from '@core/media/volume-support.js';

const ITEM = aMediaItem();
const ITEM_URL = `/api/v1/media/${ITEM.id}`;

async function openPage(): Promise<{
  harness: RouterTestingHarness;
  http: HttpTestingController;
  media: FakeMedia;
}> {
  const media = fakeMediaElement('audio');
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([
        { path: 'midia/:id', component: MediaPlayerPage },
        { path: 'outra', children: [] },
      ]),
      { provide: MEDIA_ELEMENT_FACTORY, useValue: () => media.element },
      { provide: MEDIA_POLL_MS, useValue: 20 },
      { provide: VOLUME_SUPPORT, useValue: Promise.resolve(false) },
    ],
  });
  const harness = await RouterTestingHarness.create(`/midia/${ITEM.id}`);
  return { harness, http: TestBed.inject(HttpTestingController), media };
}

describe('MediaPlayerPage (T15)', () => {
  it('reserves the player while loading, then shows the item and loads it paused', async () => {
    const { harness, http, media } = await openPage();
    expect(
      harness.routeNativeElement?.querySelector('.player-box'),
    ).not.toBeNull();
    http.expectOne(ITEM_URL).flush(ITEM);
    await harness.fixture.whenStable();
    expect(
      screen.getByRole('heading', { name: 'Palestra de 1998' }),
    ).toBeTruthy();
    expect(screen.getByText('1:02:15')).toBeTruthy();
    expect(screen.getByRole('slider', { name: 'Posição' })).toBeTruthy();
    expect(media.calls).toEqual([`load:/api/v1/media/${ITEM.id}/stream`]);
    expect(TestBed.inject(Title).getTitle()).toBe(
      'Palestra de 1998 — Nova Alexandria',
    );
  });

  it('says an item that is not ready yet will appear when it is', async () => {
    const { harness, http, media } = await openPage();
    http
      .expectOne(ITEM_URL)
      .flush(
        aMediaItem({ status: 'processing', progress: 40, durationMs: null }),
      );
    await harness.fixture.whenStable();
    expect(screen.getByRole('status').textContent).toContain(
      'Convertendo… 40%',
    );
    expect(screen.queryByRole('slider')).toBeNull();
    expect(media.calls).toEqual([]);
  });

  it('says the item is gone (or not yours) and offers the way back', async () => {
    const { harness, http } = await openPage();
    http
      .expectOne(ITEM_URL)
      .flush(
        { error: { code: 'MEDIA_NOT_FOUND', message: 'x' } },
        { status: 404, statusText: 'Not Found' },
      );
    await harness.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Esta mídia não está mais no acervo ou você não tem acesso a ela.',
    );
    expect(
      screen.getByRole('link', { name: 'Voltar à Mídia' }).getAttribute('href'),
    ).toBe('/midia');
  });

  it('stops the audio when leaving the page', async () => {
    const { harness, http, media } = await openPage();
    http.expectOne(ITEM_URL).flush(ITEM);
    await harness.fixture.whenStable();
    await harness.navigateByUrl('/outra');
    expect(media.calls.slice(-2)).toEqual(['pause', 'load:']);
    expect(TestBed.inject(MediaEngine).source()).toBeNull();
  });

  it('tries again after a failed load', async () => {
    const { harness, http } = await openPage();
    http.expectOne(ITEM_URL).flush(null, { status: 500, statusText: 'x' });
    await harness.fixture.whenStable();
    screen.getByRole('button', { name: 'Tentar de novo' }).click();
    TestBed.tick();
    http.expectOne(ITEM_URL).flush(ITEM);
    await harness.fixture.whenStable();
    expect(
      screen.getByRole('heading', { name: 'Palestra de 1998' }),
    ).toBeTruthy();
  });

  it('keeps playing the same source when the item is shown again', async () => {
    const { harness, http, media } = await openPage();
    http.expectOne(ITEM_URL).flush(ITEM);
    await harness.fixture.whenStable();
    const engine = TestBed.inject(MediaEngine);
    expect(engine.source()?.id).toBe(ITEM.id);
    expect(media.calls.filter((call) => call.startsWith('load:'))).toHaveLength(
      1,
    );
  });

  it('asks again while converting and loads the audio once it is ready', async () => {
    const { harness, http, media } = await openPage();
    http
      .expectOne(ITEM_URL)
      .flush(
        aMediaItem({ status: 'processing', progress: 40, durationMs: null }),
      );
    // Not whenStable: the next poll's request would keep it waiting for its answer.
    TestBed.tick();
    await vi.waitFor(() => http.expectOne(ITEM_URL).flush(ITEM));
    await harness.fixture.whenStable();
    expect(screen.getByRole('slider', { name: 'Posição' })).toBeTruthy();
    expect(media.calls).toEqual([`load:/api/v1/media/${ITEM.id}/stream`]);
  });

  it('shows "não encontrada" when the audio fails because the item was removed', async () => {
    const { harness, http, media } = await openPage();
    http.expectOne(ITEM_URL).flush(ITEM);
    await harness.fixture.whenStable();
    screen.getByRole('slider', { name: 'Posição' }).focus();
    media.setError(2);
    media.emit('error');
    TestBed.tick();
    http
      .expectOne(ITEM_URL)
      .flush(
        { error: { code: 'MEDIA_NOT_FOUND', message: 'x' } },
        { status: 404, statusText: 'Not Found' },
      );
    await harness.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Esta mídia não está mais no acervo ou você não tem acesso a ela.',
    );
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
    expect(TestBed.inject(MediaEngine).source()).toBeNull();
    // The slider is gone: the focus goes to the way out, not to <body> (NG-30).
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('link', { name: 'Voltar à Mídia' }),
      ),
    );
  });

  it('offers "Continuar de" at the saved position, without sound (AC-3, AC-12)', async () => {
    localStorage.clear();
    const { harness, http, media } = await openPage();
    http.expectOne(ITEM_URL).flush({ ...ITEM, positionMs: 1_390_000 });
    await harness.fixture.whenStable();
    media.setDuration(3_735);
    media.emit('loadedmetadata');
    await harness.fixture.whenStable();
    expect(media.calls).not.toContain('play');
    expect(media.calls).toContain('seek:1390');
    fireEvent.click(screen.getByRole('button', { name: 'Continuar de 23:10' }));
    expect(media.calls.at(-1)).toBe('play');
    media.emit('playing');
    await harness.fixture.whenStable();
    expect(screen.queryByRole('button', { name: /Continuar de/ })).toBeNull();
    expect(TestBed.inject(Title).getTitle()).toBe(
      `▶ ${ITEM.title} — Nova Alexandria`,
    );
  });

  it('starts over from the beginning when asked', async () => {
    localStorage.clear();
    const { harness, http, media } = await openPage();
    http.expectOne(ITEM_URL).flush({ ...ITEM, positionMs: 60_000 });
    await harness.fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Começar do início' }));
    expect(media.calls.slice(-2)).toEqual(['seek:0', 'play']);
  });

  it('continues from this browser’s newer position, and sends it again', async () => {
    localStorage.clear();
    localStorage.setItem(`kb-chat.media-position.${ITEM.id}`, '90000');
    const { harness, http } = await openPage();
    http.expectOne(ITEM_URL).flush({ ...ITEM, positionMs: 60_000 });
    await harness.fixture.whenStable();
    expect(
      screen.getByRole('button', { name: 'Continuar de 1:30' }),
    ).toBeTruthy();
    expect(
      http.expectOne({ method: 'PUT', url: `${ITEM_URL}/progress` }).request
        .body,
    ).toEqual({ positionMs: 90_000 });
  });

  it('has nothing to continue for a media heard to the end', async () => {
    localStorage.clear();
    const { harness, http } = await openPage();
    http
      .expectOne(ITEM_URL)
      .flush({ ...ITEM, positionMs: 0, completedAt: '2026-10-28T12:00:00Z' });
    await harness.fixture.whenStable();
    expect(screen.queryByRole('button', { name: /Continuar de/ })).toBeNull();
  });

  it('keeps playing after leaving the page, for the mini-player (FR-8)', async () => {
    localStorage.clear();
    const { harness, http, media } = await openPage();
    http.expectOne(ITEM_URL).flush(ITEM);
    await harness.fixture.whenStable();
    TestBed.inject(MediaEngine).play();
    media.emit('playing');
    await harness.navigateByUrl('/outra');
    expect(media.calls).not.toContain('load:');
    expect(TestBed.inject(MediaEngine).source()?.id).toBe(ITEM.id);
  });

  it('hands key presses to the player shortcuts (FR-6)', async () => {
    localStorage.clear();
    const { harness, http, media } = await openPage();
    http.expectOne(ITEM_URL).flush(ITEM);
    await harness.fixture.whenStable();
    media.setDuration(3_735);
    media.emit('loadedmetadata');
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', bubbles: true }),
    );
    expect(media.calls.at(-1)).toBe('play');
  });
});
