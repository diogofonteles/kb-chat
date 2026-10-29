import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen, within } from '@testing-library/angular';
import { SessionStore } from '@core/auth/session-store.js';
import {
  MEDIA_ELEMENT_FACTORY,
  MediaEngine,
} from '@core/media/media-engine.js';
import { BookmarksStore } from '@core/media/bookmarks-store.js';
import {
  fakeMediaElement,
  type FakeMedia,
} from '../../testing/fake-media-element.js';
import { BookmarkList } from './bookmark-list.js';

const MEDIA = '11111111-1111-4111-8111-111111111111';
const URL = `/api/v1/media/${MEDIA}/bookmarks`;
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const at = '2026-10-29T10:00:00.000Z';
const bookmark = (id: string, positionMs: number, note: string | null) => ({
  id,
  mediaId: MEDIA,
  positionMs,
  note,
  createdAt: at,
  updatedAt: at,
});

async function renderList(
  items = [bookmark(B, 758_000, 'lei do ritmo'), bookmark(A, 5_000, null)],
) {
  const media: FakeMedia = fakeMediaElement();
  const view = await render(BookmarkList, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: MEDIA_ELEMENT_FACTORY, useValue: () => media.element },
      { provide: SessionStore, useValue: { me: signal(null) } },
    ],
  });
  const engine = TestBed.inject(MediaEngine);
  engine.load({ id: MEDIA, title: 'Palestra', src: '/s', durationMs: 900_000 });
  media.setDuration(900);
  media.emit('loadedmetadata');
  media.emit('canplay');
  await view.fixture.whenStable();
  const http = TestBed.inject(HttpTestingController);
  http.expectOne({ method: 'GET', url: URL }).flush({ items });
  await view.fixture.whenStable();
  return {
    ...view,
    media,
    engine,
    http,
    store: TestBed.inject(BookmarksStore),
  };
}

describe('BookmarkList (KBC-042 FR-3, FR-4)', () => {
  it('lists by position, with the note or "Sem nota"', async () => {
    await renderList();
    const items = screen.getAllByRole('listitem');
    expect(
      items.map((item) => item.textContent?.replace(/\s+/g, ' ').trim()),
    ).toEqual([
      '0:05 Sem nota Editar Apagar',
      '12:38 lei do ritmo Editar Apagar',
    ]);
    expect(
      screen.getByRole('heading', { name: /Marcadores/ }).textContent,
    ).toContain('2');
  });

  it('plays from a bookmark when its time is pressed (AC-2)', async () => {
    const { media } = await renderList();
    fireEvent.click(
      screen.getByRole('button', { name: 'Tocar de 12 minutos e 38 segundos' }),
    );
    expect(media.calls).toContain('seek:758');
    expect(media.calls.at(-1)).toBe('play');
  });

  it('edits a note in place: Enter saves, Esc cancels, and the focus comes back', async () => {
    const { fixture, http } = await renderList();
    const edit = screen.getByRole('button', {
      name: 'Editar a nota do marcador em 12:38',
    });
    fireEvent.click(edit);
    await fixture.whenStable();
    const field = screen.getByRole('textbox', {
      name: 'Nota do marcador em 12:38',
    }) as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe('lei do ritmo');
    fireEvent.keyDown(field, { key: 'Escape' });
    await fixture.whenStable();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', {
        name: 'Editar a nota do marcador em 12:38',
      }),
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Editar a nota do marcador em 12:38',
      }),
    );
    await fixture.whenStable();
    const again = screen.getByRole('textbox') as HTMLInputElement;
    again.value = 'ritmo e polaridade';
    pressEnter(again);
    await fixture.whenStable();
    expect(
      http.expectOne({ method: 'PATCH', url: `${URL}/${B}` }).request.body,
    ).toEqual({ note: 'ritmo e polaridade' });
    expect(screen.getByText('ritmo e polaridade')).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole('button', {
        name: 'Editar a nota do marcador em 12:38',
      }),
    );
  });

  it('deletes with no confirmation, offers "Desfazer" with the focus, and brings it back (FR-4, AC-3)', async () => {
    const { fixture, http } = await renderList();
    fireEvent.click(
      screen.getByRole('button', { name: 'Apagar o marcador em 12:38' }),
    );
    await fixture.whenStable();
    expect(screen.queryByText('lei do ritmo')).toBeNull();
    const undo = screen.getByRole('button', { name: 'Desfazer' });
    expect(document.activeElement).toBe(undo);
    fireEvent.click(undo);
    await fixture.whenStable();
    expect(screen.getByText('lei do ritmo')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Desfazer' })).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Tocar de 12 minutos e 38 segundos' }),
    );
    expect(http.match({ method: 'DELETE' })).toEqual([]);
  });

  it('shows a bookmark still on its way as "salvando…"', async () => {
    const { fixture, store } = await renderList([]);
    store.mark();
    await fixture.whenStable();
    expect(
      within(screen.getByRole('list')).getByText('salvando…'),
    ).toBeTruthy();
  });

  it('says how to mark when there is none yet', async () => {
    await renderList([]);
    expect(screen.getByText(/Nenhum marcador ainda/)).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });
});

/** Enter in the field, as the person would. */
function pressEnter(field: HTMLElement): void {
  fireEvent.keyDown(field, { key: 'Enter' });
}
