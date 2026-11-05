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
import { MyBookmarksPage } from './my-bookmarks-page.js';

const MEDIA = '11111111-1111-4111-8111-111111111111';
const at = '2026-10-29T10:00:00.000Z';

@Component({ template: '<p>player</p>' })
class PlayerStub {}

async function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([
        { path: 'midia/marcadores', component: MyBookmarksPage },
        { path: 'midia/:id', component: PlayerStub },
        { path: 'midia', component: PlayerStub },
      ]),
    ],
  });
  const harness = await RouterTestingHarness.create('/midia/marcadores');
  const http = TestBed.inject(HttpTestingController);
  http.expectOne('/api/v1/media/bookmarks/moved').flush({ moved: [] });
  return { harness, http };
}

describe('MyBookmarksPage (KBC-042 FR-5)', () => {
  it('lists the person’s bookmarks and opens the media playing from one', async () => {
    const { harness, http } = await setup();
    expect(screen.getByText('Carregando marcadores…')).toBeTruthy();
    http.expectOne('/api/v1/media/bookmarks').flush({
      items: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          mediaId: MEDIA,
          positionMs: 758_000,
          note: 'lei do ritmo',
          createdAt: at,
          updatedAt: at,
          mediaTitle: 'Palestra de 1998',
          mediaDurationMs: 3_600_000,
        },
      ],
    });
    await harness.fixture.whenStable();
    const open = screen.getByRole('link', {
      name: 'Palestra de 1998 12:38, tocar daqui',
    });
    expect(open.textContent).toContain('12:38');
    expect(screen.getByText('lei do ritmo')).toBeTruthy();
    const router = TestBed.inject(Router);
    fireEvent.click(open);
    await harness.fixture.whenStable();
    expect(router.url).toBe(`/midia/${MEDIA}`);
    expect(router.lastSuccessfulNavigation()?.extras.state).toEqual({
      playFromMs: 758_000,
    });
  });

  it('says how to mark when there is none', async () => {
    const { harness, http } = await setup();
    http.expectOne('/api/v1/media/bookmarks').flush({ items: [] });
    await harness.fixture.whenStable();
    expect(screen.getByText(/ainda não marcou nenhum trecho/)).toBeTruthy();
  });

  it('says what went wrong and tries again', async () => {
    const { harness, http } = await setup();
    http
      .expectOne('/api/v1/media/bookmarks')
      .flush(null, { status: 503, statusText: 'Unavailable' });
    await harness.fixture.whenStable();
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    harness.fixture.detectChanges();
    http.expectOne('/api/v1/media/bookmarks').flush({ items: [] });
    await harness.fixture.whenStable();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
