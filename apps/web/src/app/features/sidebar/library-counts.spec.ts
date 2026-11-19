import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { SessionStore } from '@core/auth/session-store.js';
import { MY_BOOKMARKS_URL } from '@core/media/bookmarks-api.js';
import { LIBRARY_COUNTS_URL } from '@core/media/library-api.js';
import { LibraryCounts } from './library-counts.js';

async function setUp() {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([
        { path: 'biblioteca', children: [] },
        { path: 'midia', children: [] },
      ]),
      {
        provide: SessionStore,
        useValue: { me: signal({ media: true }), can: () => true },
      },
    ],
  });
  const router = TestBed.inject(Router);
  const http = TestBed.inject(HttpTestingController);
  const counts = TestBed.inject(LibraryCounts);
  const answer = () => {
    TestBed.tick();
    const media = http.match(LIBRARY_COUNTS_URL);
    const bookmarks = http.match(MY_BOOKMARKS_URL);
    media.forEach((one) => one.flush({ total: 3, topics: { hermetismo: 3 } }));
    bookmarks.forEach((one) => one.flush({ items: [] }));
    return media.length + bookmarks.length;
  };
  await router.navigateByUrl('/biblioteca');
  expect(answer()).toBe(2);
  return { router, http, counts, answer };
}

describe('LibraryCounts ("Sua biblioteca")', () => {
  it('asks again when the page changes, so a media sent shows on the next page', async () => {
    const { router, answer, counts } = await setUp();
    expect(counts.total()).toBe(3);

    await router.navigateByUrl('/midia');

    expect(answer()).toBe(2);
  });

  it('does not ask again while the library search writes its words in the URL', async () => {
    const { router, answer, http } = await setUp();

    await router.navigateByUrl('/biblioteca?q=her', { replaceUrl: true });
    await router.navigateByUrl('/biblioteca?q=herm', { replaceUrl: true });
    await router.navigateByUrl('/biblioteca#topo');

    expect(answer()).toBe(0);
    http.verify();
  });
});
