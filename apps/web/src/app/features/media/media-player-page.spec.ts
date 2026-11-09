import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
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
} from '../../testing/fake-media-element.js';
import {
  aMediaItem,
  aTranscription,
  chatStoreOn,
  viewStoreStub,
  sessionAs,
} from '../../testing/media-fixtures.js';
import { MediaPlayerPage } from './media-player-page.js';
import { MEDIA_POLL_MS } from './media-polling.js';
import { VOLUME_SUPPORT } from '@core/media/volume-support.js';
import { ANIMATION_FRAMES } from '@core/media/playback-clock.js';
import type { MediaTranscript } from '@kb-chat/contracts';
import { EMPTY } from 'rxjs';

const ITEM = aMediaItem();
const ITEM_URL = `/api/v1/media/${ITEM.id}`;
/** A recording nobody began to divide (KBC-066): what whoever edits reads on the page. */
const NOT_STARTED = {
  mediaId: ITEM.id,
  version: 0,
  started: false,
  status: 'draft',
  step: 3,
  tracks: [],
  run: null,
  lastFailure: null,
  voices: [],
  approvedTracks: 0,
  transcriptChanged: false,
};

async function openPage(
  url = `/midia/${ITEM.id}`,
  who?: Parameters<typeof sessionAs>[0],
): Promise<{
  harness: RouterTestingHarness;
  http: HttpTestingController;
  media: FakeMedia;
}> {
  const media = fakeMediaElement('audio');
  TestBed.configureTestingModule({
    providers: [
      chatStoreOn(),
      viewStoreStub,
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
      { provide: ANIMATION_FRAMES, useValue: EMPTY },
      ...(who ? [sessionAs(who)] : []),
    ],
  });
  const harness = await RouterTestingHarness.create(url);
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

  it('says the transcript is automatic and of low confidence, apart (BR-5)', async () => {
    const { harness, http } = await openPage();
    http.expectOne(ITEM_URL).flush(
      aMediaItem({
        transcription: aTranscription({ status: 'done', confidence: 'low' }),
      }),
    );
    await harness.fixture.whenStable();
    expect(document.body.textContent).toContain(
      'Transcrição automática de baixa confiança: pode haver trechos errados.',
    );
    expect(document.body.textContent).not.toContain('Transcrita');
  });

  it('says the transcription waits for the transcriber (FR-1)', async () => {
    const { harness, http } = await openPage();
    http.expectOne(ITEM_URL).flush(
      aMediaItem({
        transcription: aTranscription({
          status: 'waiting',
          transcriber: 'none',
        }),
      }),
    );
    await harness.fixture.whenStable();
    expect(document.body.textContent).toContain(
      'Aguardando o transcritor · nenhum transcritor pareado',
    );
    expect(document.body.textContent).not.toContain('baixa confiança');
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
    const { http, media } = await openPage();
    http
      .expectOne(ITEM_URL)
      .flush(
        aMediaItem({ status: 'processing', progress: 40, durationMs: null }),
      );
    // Not whenStable: the next poll's request would keep it waiting for its answer.
    TestBed.tick();
    await vi.waitFor(() => http.expectOne(ITEM_URL).flush(ITEM));
    // Not whenStable either: the player asks for the person's preferences as it appears,
    // and a slow run may poll once more before the page sees the item is ready.
    await vi.waitFor(() => {
      for (const request of http.match(ITEM_URL)) request.flush(ITEM);
      for (const request of http.match('/api/v1/media/preferences'))
        request.flush({
          speed: 1,
          showRemaining: true,
          skipBackSec: 15,
          skipForwardSec: 30,
          skipSilences: false,
          wordHighlight: true,
        });
      TestBed.tick();
      expect(screen.getByRole('slider', { name: 'Posição' })).toBeTruthy();
    });
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
    // Unsent, and no device saved since (the server's save time is still null).
    localStorage.setItem(
      `kb-chat.media-position..${ITEM.id}`,
      JSON.stringify({ positionMs: 90_000, delivered: false, basedOn: null }),
    );
    const { harness, http } = await openPage();
    http.expectOne(ITEM_URL).flush({ ...ITEM, positionMs: 60_000 });
    await harness.fixture.whenStable();
    expect(
      screen.getByRole('button', { name: 'Continuar de 1:30' }),
    ).toBeTruthy();
    expect(
      http.expectOne({ method: 'PUT', url: `${ITEM_URL}/progress` }).request
        .body,
    ).toEqual({ positionMs: 90_000, basedOn: null });
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

  it('keeps a play asked and not yet started after leaving the page (FR-8)', async () => {
    localStorage.clear();
    const { harness, http, media } = await openPage();
    http.expectOne(ITEM_URL).flush(ITEM);
    await harness.fixture.whenStable();
    media.setDuration(3_735);
    media.emit('loadedmetadata');
    const engine = TestBed.inject(MediaEngine);
    engine.play();
    // The element knows the duration and still has not said `playing`: neither playing nor busy.
    expect(engine.playing()).toBe(false);
    expect(engine.busy()).toBe(false);
    await harness.navigateByUrl('/outra');
    expect(engine.source()?.id).toBe(ITEM.id);
    media.emit('playing');
    expect(engine.playing()).toBe(true);
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

describe('MediaPlayerPage opened from "Meus marcadores" (KBC-042 FR-5)', () => {
  it('plays from the bookmark, with no "Continuar de", even over a saved position', async () => {
    const { harness, http, media } = await openPage();
    http.expectOne(ITEM_URL).flush(ITEM);
    await harness.fixture.whenStable();
    await harness.navigateByUrl('/outra');
    const router = TestBed.inject(Router);
    await router.navigateByUrl(`/midia/${ITEM.id}`, {
      state: { playFromMs: 758_000 },
    });
    TestBed.tick();
    http.expectOne(ITEM_URL).flush(aMediaItem({ positionMs: 120_000 }));
    await harness.fixture.whenStable();
    expect(media.calls).toContain('seek:758');
    expect(media.calls.at(-1)).toBe('play');
    expect(screen.queryByRole('button', { name: /Continuar de/ })).toBeNull();
  });

  it('ignores a navigation state that is not a position', async () => {
    const { harness, http, media } = await openPage();
    http.expectOne(ITEM_URL).flush(ITEM);
    await harness.fixture.whenStable();
    await harness.navigateByUrl('/outra');
    await TestBed.inject(Router).navigateByUrl(`/midia/${ITEM.id}`, {
      state: { playFromMs: 'muito' },
    });
    TestBed.tick();
    http.expectOne(ITEM_URL).flush(ITEM);
    await harness.fixture.whenStable();
    expect(media.calls).not.toContain('play');
  });
});

describe('MediaPlayerPage: link to a minute (KBC-038 FR-5, AC-5)', () => {
  it('opens ?t=754 at 12:34, paused, with no "Continuar de" over the saved position', async () => {
    localStorage.clear();
    const { harness, http, media } = await openPage(`/midia/${ITEM.id}?t=754`);
    http.expectOne(ITEM_URL).flush({ ...ITEM, positionMs: 120_000 });
    await harness.fixture.whenStable();
    media.setDuration(3_735);
    media.emit('loadedmetadata');
    await harness.fixture.whenStable();
    expect(media.calls).toContain('seek:754');
    expect(media.calls).not.toContain('seek:120');
    expect(media.calls).not.toContain('play');
    expect(screen.queryByRole('button', { name: /Continuar de/ })).toBeNull();
  });

  it('moves the media already playing in the mini-player to ?t=', async () => {
    const { harness, http, media } = await openPage();
    http.expectOne(ITEM_URL).flush(ITEM);
    await harness.fixture.whenStable();
    media.emit('playing');
    await harness.navigateByUrl('/outra');
    await harness.navigateByUrl(`/midia/${ITEM.id}?t=60`);
    TestBed.tick();
    http.expectOne(ITEM_URL).flush(ITEM);
    await harness.fixture.whenStable();
    expect(media.calls.at(-1)).toBe('seek:60');
  });

  it('ignores a ?t= that is not a whole number of seconds', async () => {
    localStorage.clear();
    const { harness, http, media } = await openPage(
      `/midia/${ITEM.id}?t=12:34`,
    );
    http.expectOne(ITEM_URL).flush({ ...ITEM, positionMs: 120_000 });
    await harness.fixture.whenStable();
    expect(
      screen.getByRole('button', { name: 'Continuar de 2:00' }),
    ).toBeTruthy();
    expect(media.calls).not.toContain('seek:754');
  });
});

/** Lets the page ask for what the answer needs (whenStable would wait for those requests). */
/**
 * What a recording's page reads for who edits: "Faixas apagadas" (KBC-073) and where it
 * stands in the AI research (KBC-100: a recording with no document, here).
 */
const answerArchivedTracks = (http: HttpTestingController): void => {
  http.expectOne(`${ITEM_URL}/archived-tracks`).flush({ tracks: [] });
  http
    .expectOne(`${ITEM_URL}/publication`)
    .flush({ mediaId: ITEM.id, publication: null });
};

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

describe('MediaPlayerPage: transcript and subtitles (KBC-038)', () => {
  const TRANSCRIBED = aMediaItem({
    transcription: aTranscription({
      status: 'done',
      confidence: 'low',
      version: 2,
    }),
  });
  const TRANSCRIPT: MediaTranscript = {
    mediaId: ITEM.id,
    version: 2,
    revision: 0,
    confidence: 'low',
    segments: [{ startMs: 0, endMs: 3_000, text: 'Existia um rei.' }],
  };
  const transcriptRequest = (r: { urlWithParams: string }) =>
    r.urlWithParams === `${ITEM_URL}/transcript?v=2`;
  const subtitlesRequest = (r: { urlWithParams: string }) =>
    r.urlWithParams === `${ITEM_URL}/subtitles.vtt?v=2`;
  const LOW =
    'Transcrição automática de baixa confiança: pode haver trechos errados.';

  it('shows the transcript beside the player, the low notice once, above the text (AC-6)', async () => {
    localStorage.clear();
    const { harness, http } = await openPage();
    http.expectOne(ITEM_URL).flush(TRANSCRIBED);
    await settle();
    http.expectOne(transcriptRequest).flush(TRANSCRIPT);
    await harness.fixture.whenStable();
    expect(screen.getByRole('heading', { name: 'Transcrição' })).toBeTruthy();
    expect(screen.getByText('Existia um rei.')).toBeTruthy();
    expect(screen.getAllByText(LOW)).toHaveLength(1);
    expect(
      screen
        .getByRole('button', { name: 'CC, legendas' })
        .hasAttribute('disabled'),
    ).toBe(false);
    // With CC on, a short notice goes with the subtitles: on a phone the column's own
    // notice is far below (CSS hides this one when the column sits beside the player).
    fireEvent.click(screen.getByRole('button', { name: 'CC, legendas' }));
    await settle();
    expect(
      screen.getByText(
        'Legendas de baixa confiança: podem ter trechos errados.',
      ),
    ).toBeTruthy();
  });

  it('hides the column when asked, keeps it hidden for the next media, and the header says low (FR-9, AC-10)', async () => {
    localStorage.clear();
    const { harness, http } = await openPage();
    http.expectOne(ITEM_URL).flush(TRANSCRIBED);
    await settle();
    http.expectOne(transcriptRequest).flush(TRANSCRIPT);
    await harness.fixture.whenStable();
    const toggle = screen.getByRole('button', { name: 'Esconder transcrição' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe('transcript-column');
    fireEvent.click(toggle);
    await harness.fixture.whenStable();
    expect(screen.queryByRole('heading', { name: 'Transcrição' })).toBeNull();
    expect(screen.getAllByText(LOW)).toHaveLength(1);
    const shown = screen.getByRole('button', { name: 'Mostrar transcrição' });
    expect(shown.getAttribute('aria-expanded')).toBe('false');
    expect(shown.hasAttribute('aria-controls')).toBe(false);
    expect(localStorage.getItem('kb-chat.player.transcript-collapsed')).toBe(
      'on',
    );
  });

  it('loads the subtitles of the current version when CC is on (FR-1, AC-4)', async () => {
    localStorage.clear();
    localStorage.setItem('kb-chat.player.captions', 'on');
    localStorage.setItem('kb-chat.player.transcript-collapsed', 'on');
    const { harness, http, media } = await openPage();
    http.expectOne(ITEM_URL).flush(TRANSCRIBED);
    await settle();
    http
      .expectOne(subtitlesRequest)
      .flush('WEBVTT\n\n00:00.000 --> 00:02.000\nExistia um rei.\n');
    media.setDuration(3_735);
    media.emit('loadedmetadata');
    media.setCurrentTime(1);
    media.emit('timeupdate');
    await harness.fixture.whenStable();
    expect(
      screen
        .getByRole('button', { name: 'CC, legendas' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(document.querySelector('.caption')?.textContent).toBe(
      'Existia um rei.',
    );
  });

  it('says when the transcript did not load, and tries again', async () => {
    localStorage.clear();
    const { harness, http } = await openPage();
    http.expectOne(ITEM_URL).flush(TRANSCRIBED);
    await settle();
    http
      .expectOne(transcriptRequest)
      .flush(null, { status: 500, statusText: 'Server Error' });
    await harness.fixture.whenStable();
    expect(screen.getAllByText(LOW)).toHaveLength(1);
    fireEvent.click(
      screen
        .getAllByRole('button', { name: 'Tentar de novo' })
        .at(-1) as HTMLElement,
    );
    await settle();
    http.expectOne(transcriptRequest).flush(TRANSCRIPT);
    await harness.fixture.whenStable();
    expect(screen.getByText('Existia um rei.')).toBeTruthy();
  });
});

describe('MediaPlayerPage: "Vozes" (KBC-064 AC-2)', () => {
  it('shows the voices block to whoever edits recordings', async () => {
    const { harness, http } = await openPage(undefined, {
      features: ['media', 'media-edit'],
    });
    http.expectOne(ITEM_URL).flush(ITEM);
    // The item renders, then the block asks for the voices (a pending read keeps it unstable).
    await Promise.resolve();
    TestBed.tick();
    answerArchivedTracks(http);
    http.expectOne(`${ITEM_URL}/edit`).flush(NOT_STARTED);
    http.expectOne(`${ITEM_URL}/speakers`).flush({
      mediaId: ITEM.id,
      status: 'none',
      transcriber: 'on',
      transcriberOffSince: null,
      canRequest: true,
      diarization: null,
    });
    await harness.fixture.whenStable();
    expect(screen.getByRole('heading', { name: 'Vozes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Separar vozes' })).toBeTruthy();
    // Not transcribed yet: "Preparar áudio" offers that too (KBC-072 AC-16).
    expect(screen.getByRole('link', { name: 'Preparar áudio' })).toBeTruthy();
  });

  it('names the recording of a track and listens in context (KBC-068 AC-2)', async () => {
    const { harness, http } = await openPage(undefined, {
      features: ['media', 'media-edit', 'media-tracks'],
    });
    http.expectOne(ITEM_URL).flush({
      ...ITEM,
      parent: {
        id: '22222222-2222-4222-8222-222222222222',
        title: 'Palestra completa',
        startMs: 754_500,
        endMs: 900_000,
        ordinal: 3,
        total: 12,
      },
    });
    await Promise.resolve();
    TestBed.tick();
    http.expectOne(`${ITEM_URL}/tracks`).flush({ tracks: [] });
    await Promise.resolve();
    TestBed.tick();
    expect(harness.routeNativeElement).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Palestra completa' }),
    ).toBeTruthy();
    expect(screen.getByText('· faixa 3 de 12')).toBeTruthy();
    const context = screen.getByRole('link', { name: 'Ouvir no contexto' });
    expect(context.getAttribute('href')).toBe(
      '/midia/22222222-2222-4222-8222-222222222222?t=754',
    );
    http.expectNone(`${ITEM_URL}/edit`);
    expect(
      screen.queryByRole('link', { name: 'Dividir em faixas' }),
    ).toBeNull();
  });

  it('says a track left the edit, with no player (KBC-068 AC-5)', async () => {
    const { harness, http } = await openPage(undefined, {
      features: ['media', 'media-tracks'],
    });
    http.expectOne(ITEM_URL).flush({
      ...ITEM,
      archived: true,
      parent: {
        id: '22222222-2222-4222-8222-222222222222',
        title: 'Palestra completa',
        startMs: 0,
        endMs: 60_000,
        ordinal: null,
        total: 11,
      },
    });
    await Promise.resolve();
    TestBed.tick();
    http.expectOne('/api/v1/media/bookmarks/moved').flush({ moved: [] });
    await harness.fixture.whenStable();
    expect(screen.getByText('Faixa removida da edição')).toBeTruthy();
    expect(screen.queryByText(/faixa \d+ de/)).toBeNull();
    expect(
      screen.getByRole('link', { name: 'Ouvir no contexto' }),
    ).toBeTruthy();
    expect(screen.queryByRole('slider')).toBeNull();
  });

  it('says where a preparation stopped, with the way back (KBC-066 AC-17)', async () => {
    const { harness, http } = await openPage(undefined, {
      features: ['media', 'media-edit'],
    });
    http.expectOne(ITEM_URL).flush(ITEM);
    await Promise.resolve();
    TestBed.tick();
    answerArchivedTracks(http);
    http
      .expectOne(`${ITEM_URL}/edit`)
      .flush({ ...NOT_STARTED, started: true, version: 2 });
    http.match(`${ITEM_URL}/speakers`).forEach((one) =>
      one.flush({
        mediaId: ITEM.id,
        status: 'none',
        transcriber: 'on',
        transcriberOffSince: null,
        canRequest: true,
        diarization: null,
      }),
    );
    await harness.fixture.whenStable();
    expect(screen.getByText('Preparação parada no passo 3')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Continuar' })).toBeTruthy();
  });

  it('shows nothing of voices to a person who only listens, and asks for none', async () => {
    const { harness, http } = await openPage(undefined, {
      features: ['media'],
    });
    http.expectOne(ITEM_URL).flush(ITEM);
    await harness.fixture.whenStable();
    expect(screen.queryByRole('heading', { name: 'Vozes' })).toBeNull();
    http.expectNone(`${ITEM_URL}/speakers`);
  });
});

describe('MediaPlayerPage: the transcript reads its voices again (KBC-064 FR-5)', () => {
  const VOICED_ITEM = aMediaItem({
    transcription: aTranscription({ status: 'done', version: 1 }),
  });
  const transcriptRequest = (r: { urlWithParams: string }) =>
    r.urlWithParams === `${ITEM_URL}/transcript?v=1`;
  const TWO_SEGMENTS: MediaTranscript = {
    mediaId: ITEM.id,
    version: 1,
    revision: 0,
    confidence: 'normal',
    segments: [
      { startMs: 0, endMs: 3_000, text: 'Existia um rei.' },
      { startMs: 3_000, endMs: 6_000, text: 'Que rei?' },
    ],
  };
  const separation = {
    version: 1,
    createdAt: '2026-11-03T12:00:00.000Z',
    transcriptVersion: 1,
    staleTranscript: false,
    requestedVoices: null,
    voiceCount: 2,
    voices: [
      { voice: 1, speakingMs: 3_000 },
      { voice: 2, speakingMs: 3_000 },
    ],
    turns: [
      { voice: 1, startMs: 0, endMs: 3_000 },
      { voice: 2, startMs: 3_000, endMs: 6_000 },
    ],
    labels: [
      { voice: 1, kind: 'unnamed', speakerId: null, name: null, main: false },
      { voice: 2, kind: 'unnamed', speakerId: null, name: null, main: false },
    ],
    merged: [],
    namesPending: false,
  } as const;
  const VOICED_TRANSCRIPT: MediaTranscript = {
    ...TWO_SEGMENTS,
    segments: TWO_SEGMENTS.segments.map((segment, index) => ({
      ...segment,
      voice: index + 1,
    })),
    voiceNames: [
      {
        voice: 1,
        kind: 'person',
        speakerId: '11111111-1111-4111-8111-111111111111',
        name: 'Mestre Gabriel',
        main: true,
      },
      { voice: 2, kind: 'audience', speakerId: null, name: null, main: false },
    ],
  };
  const VTT = 'WEBVTT\n\n00:00.000 --> 00:02.000\nExistia um rei.\n';

  it('AC-1, FR-4: subtitles say who speaks, even with the column hidden', async () => {
    localStorage.clear();
    localStorage.setItem('kb-chat.player.captions', 'on');
    localStorage.setItem('kb-chat.player.transcript-collapsed', 'on');
    const { harness, http } = await openPage(undefined, {
      features: ['media', 'media-speakers'],
    });
    http.expectOne(ITEM_URL).flush(VOICED_ITEM);
    await settle();
    http.expectOne(transcriptRequest).flush(VOICED_TRANSCRIPT);
    http.expectOne((r) => r.url === `${ITEM_URL}/subtitles.vtt`).flush(VTT);
    await harness.fixture.whenStable();
    const page = harness.routeDebugElement?.componentInstance as {
      cues(): readonly { text: string }[];
    };
    expect(page.cues()[0]?.text).toBe('— ✦ Mestre Gabriel: Existia um rei.');
    localStorage.clear();
  });

  it('AC-4: without `media-speakers` a hidden column stays unread', async () => {
    localStorage.clear();
    localStorage.setItem('kb-chat.player.captions', 'on');
    localStorage.setItem('kb-chat.player.transcript-collapsed', 'on');
    const { harness, http } = await openPage(undefined, {
      features: ['media'],
    });
    http.expectOne(ITEM_URL).flush(VOICED_ITEM);
    await settle();
    http.expectNone(transcriptRequest);
    http.expectOne((r) => r.url === `${ITEM_URL}/subtitles.vtt`).flush(VTT);
    await harness.fixture.whenStable();
    localStorage.clear();
  });

  it('asks for the transcript again once "Vozes" shows a separation it lacks, and labels it', async () => {
    localStorage.clear();
    const { harness, http } = await openPage(undefined, {
      features: ['media', 'media-edit'],
    });
    http.expectOne(ITEM_URL).flush(VOICED_ITEM);
    await settle();
    answerArchivedTracks(http);
    http.expectOne(transcriptRequest).flush(TWO_SEGMENTS);
    http.expectOne(`${ITEM_URL}/edit`).flush(NOT_STARTED);
    http.expectOne(`${ITEM_URL}/speakers`).flush({
      mediaId: ITEM.id,
      status: 'done',
      transcriber: 'on',
      transcriberOffSince: null,
      canRequest: true,
      diarization: {
        ...separation,
        segments: [
          { startMs: 0, endMs: 3_000, voice: 1 },
          { startMs: 3_000, endMs: 6_000, voice: 2 },
        ],
      },
    });
    await settle();
    http.expectOne(transcriptRequest).flush({
      ...TWO_SEGMENTS,
      segments: TWO_SEGMENTS.segments.map((segment, index) => ({
        ...segment,
        voice: index + 1,
      })),
      speakers: separation,
    });
    http
      .expectOne(`/api/v1/topics/${ITEM.topic}/speakers`)
      .flush({ items: [] });
    http.expectOne(`/api/v1/topics/${ITEM.topic}/authors`).flush({ items: [] });
    await harness.fixture.whenStable();
    const list = screen.getByRole('list', { name: 'Trechos da transcrição' });
    expect(within(list).getByText('Voz 1')).toBeTruthy();
    expect(within(list).getByText('Voz 2')).toBeTruthy();
    http.expectNone(transcriptRequest);
  });
});

describe('MediaPlayerPage: "Editar informações" (KBC-050 FR-2)', () => {
  it('stays hidden from who may not edit', async () => {
    const { harness, http } = await openPage();
    http.expectOne(ITEM_URL).flush(ITEM);
    await harness.fixture.whenStable();
    expect(
      screen.queryByRole('button', { name: 'Editar informações' }),
    ).toBeNull();
  });

  it('AC-1: the page shows the new title at once and the sound goes on', async () => {
    const { harness, http, media } = await openPage();
    const editable = aMediaItem({ canEdit: true });
    http.expectOne(ITEM_URL).flush(editable);
    await harness.fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Editar informações' }));
    await harness.fixture.whenStable();
    fireEvent.input(screen.getByLabelText('Título'), {
      target: { value: 'A conselheira do rei' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    const calls = [...media.calls];
    http
      .expectOne(ITEM_URL)
      .flush({ ...editable, title: 'A conselheira do rei' });
    await harness.fixture.whenStable();
    expect(
      screen.getByRole('heading', { name: 'A conselheira do rei' }),
    ).toBeTruthy();
    expect(screen.getByText('Informações salvas')).toBeTruthy();
    expect(media.calls).toEqual(calls);
    expect(TestBed.inject(Title).getTitle()).toContain('A conselheira do rei');
    expect(TestBed.inject(MediaEngine).source()?.title).toBe(
      'A conselheira do rei',
    );
  });
});

describe('MediaPlayerPage: listening by track (KBC-066 FR-9)', () => {
  const TRACKS = {
    tracks: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        ordinal: 1,
        startMs: 0,
        endMs: 600_000,
        kind: 'qa',
        title: 'Primeira',
      },
      {
        id: '00000000-0000-4000-8000-000000000002',
        ordinal: 2,
        startMs: 600_000,
        endMs: 900_000,
        kind: 'talk',
        title: 'Segunda',
      },
    ],
  };

  it('asks for no tracks without `media-tracks` (AC-13)', async () => {
    const { harness, http } = await openPage(undefined, {
      features: ['media'],
    });
    http.expectOne(ITEM_URL).flush(ITEM);
    await harness.fixture.whenStable();
    http.expectNone(`${ITEM_URL}/tracks`);
    expect(screen.queryByRole('heading', { name: 'Faixas' })).toBeNull();
  });

  it('lists the tracks; a row goes to its start', async () => {
    const { harness, http, media } = await openPage(undefined, {
      features: ['media', 'media-tracks'],
    });
    http.expectOne(ITEM_URL).flush(ITEM);
    await Promise.resolve();
    TestBed.tick();
    http.expectOne(`${ITEM_URL}/tracks`).flush(TRACKS);
    await harness.fixture.whenStable();
    expect(screen.getByRole('heading', { name: 'Faixas' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Segunda/ }));
    expect(media.element.currentTime).toBe(600);
  });

  it('opens `?track=2` at that track, before anything else (AC-12)', async () => {
    const { harness, http, media } = await openPage(
      `/midia/${ITEM.id}?track=2`,
      { features: ['media', 'media-tracks'] },
    );
    http.expectOne(ITEM_URL).flush(ITEM);
    await Promise.resolve();
    TestBed.tick();
    http.expectOne(`${ITEM_URL}/tracks`).flush(TRACKS);
    await harness.fixture.whenStable();
    media.setDuration(3_735);
    media.emit('loadedmetadata');
    await harness.fixture.whenStable();
    expect(media.element.currentTime).toBe(600);
  });
});
