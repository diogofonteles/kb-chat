import {
  Component,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { TrackBoundsPage } from './track-edit/track-bounds-page.js';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { Feature } from '@kb-chat/contracts';
import { SessionStore } from '@core/auth/session-store.js';
import { MediaListPage } from './media-list-page.js';
import { MediaPlayerPage } from './media-player-page.js';
import { PreparationPage } from './preparation/preparation-page.js';
import { TrackEditorPage } from './tracks/track-editor-page.js';
import { MyBookmarksPage } from './my-bookmarks-page.js';
import { LibraryPage } from './library/library-page.js';
import { MediaRedirect } from './library/media-redirect.js';
import {
  MEDIA_ROUTES,
  libraryEnabled,
  libraryOnly,
  mediaEnabled,
} from './media-routes.js';

@Component({ template: 'media page' })
class MediaStub {}

async function landingFor(
  me: { media: boolean } | null,
  features: Feature[],
  state = signal<{ kind: string }>({ kind: 'signed-in' }),
) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([
        { path: 'midia', canMatch: [mediaEnabled], component: MediaStub },
        { path: '', children: [] },
      ]),
      {
        provide: SessionStore,
        useValue: {
          state,
          me: signal(me),
          can: (feature: Feature) => features.includes(feature),
        },
      },
    ],
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl('/midia');
  return TestBed.inject(Router).url;
}

describe('mediaEnabled (every feature granted per person)', () => {
  it('opens the media pages with the library on and "Ouvir mídia"', async () => {
    expect(await landingFor({ media: true }, ['media'])).toBe('/midia');
  });

  it('sends home without "Ouvir mídia"', async () => {
    expect(await landingFor({ media: true }, ['search'])).toBe('/');
  });

  it('sends home when the server has media off', async () => {
    expect(await landingFor({ media: false }, ['media'])).toBe('/');
  });

  it('waits for the session before deciding (a link opened directly)', async () => {
    const state = signal<{ kind: string }>({ kind: 'loading' });
    const landing = landingFor({ media: true }, ['media'], state);
    setTimeout(() => state.set({ kind: 'signed-in' }), 10);
    expect(await landing).toBe('/midia');
  });

  it('lazy-loads the media pages it declares', async () => {
    const pages = await Promise.all(
      MEDIA_ROUTES.map((route) =>
        route.loadComponent ? route.loadComponent() : null,
      ),
    );
    expect(pages).toEqual([
      LibraryPage,
      MediaRedirect,
      MediaListPage,
      MyBookmarksPage,
      PreparationPage,
      TrackEditorPage,
      TrackBoundsPage,
      MediaPlayerPage,
    ]);
    // The library's /midia comes before the list's; "marcadores" before ":id".
    expect(MEDIA_ROUTES.map((route) => route.path)).toEqual([
      'biblioteca',
      'midia',
      'midia',
      'midia/marcadores',
      'midia/:id/preparar',
      'midia/:id/faixas',
      'midia/:id/limites',
      'midia/:id',
    ]);
  });
});

@Component({ template: 'library' })
class LibraryStub {}

/** Where /midia and /biblioteca land with the real media routes' guards. */
async function libraryLanding(
  url: string,
  me: { media: boolean },
  features: Feature[],
) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([
        {
          path: 'biblioteca',
          canMatch: [libraryEnabled],
          component: LibraryStub,
        },
        { path: 'midia', canMatch: [libraryOnly], component: LibraryStub },
        { path: 'midia', canMatch: [mediaEnabled], component: MediaStub },
        { path: '', children: [] },
      ]),
      {
        provide: SessionStore,
        useValue: {
          state: signal({ kind: 'signed-in' }),
          me: signal(me),
          can: (feature: Feature) => features.includes(feature),
        },
      },
    ],
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  const shown = harness.routeNativeElement?.textContent?.trim() ?? '';
  return `${TestBed.inject(Router).url} ${shown}`.trim();
}

describe('libraryEnabled (KBC-051 BR-1, FR-7)', () => {
  it('opens /biblioteca with "Ouvir mídia" and "Biblioteca de mídia" (AC-1)', async () => {
    expect(
      await libraryLanding('/biblioteca', { media: true }, [
        'media',
        'media-library',
      ]),
    ).toBe('/biblioteca library');
  });

  it('takes /midia to the library for who has it (AC-1)', async () => {
    expect(
      await libraryLanding('/midia', { media: true }, [
        'media',
        'media-library',
      ]),
    ).toBe('/midia library');
  });

  it('keeps the list for who has only "Ouvir mídia", and /biblioteca goes home (AC-2)', async () => {
    expect(await libraryLanding('/midia', { media: true }, ['media'])).toBe(
      '/midia media page',
    );
    TestBed.resetTestingModule();
    expect(
      await libraryLanding('/biblioteca', { media: true }, ['media']),
    ).toBe('/');
  });

  it('needs "Ouvir mídia" too', async () => {
    expect(
      await libraryLanding('/biblioteca', { media: true }, ['media-library']),
    ).toBe('/');
  });
});
