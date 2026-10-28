import { HttpBackend, provideHttpClient } from '@angular/common/http';
import { MEDIA_UPLOAD_BACKEND } from '@core/media/media-api.js';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { Feature, MediaItem } from '@kb-chat/contracts';
import { fireEvent, render, screen, within } from '@testing-library/angular';
import {
  aMediaItem,
  chatStoreOn,
  mediaId,
  sessionAs,
} from '../../testing/media-fixtures.js';
import { MediaListPage } from './media-list-page.js';
import { MEDIA_POLL_MS } from './media-polling.js';

const LIST_URL = '/api/v1/topics/hermetismo/media';

async function renderList(
  who: { features: Feature[]; master?: boolean } = { features: ['search'] },
) {
  const view = await render(MediaListPage, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      chatStoreOn(),
      sessionAs(who),
      { provide: MEDIA_POLL_MS, useValue: 20 },
      {
        provide: MEDIA_UPLOAD_BACKEND,
        useFactory: () => TestBed.inject(HttpBackend),
      },
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  const answer = async (items: MediaItem[]) => {
    http.expectOne(LIST_URL).flush({ items });
    await view.fixture.whenStable();
  };
  return { ...view, http, answer };
}

describe('MediaListPage (T14)', () => {
  it('shows a skeleton while loading, then the items with status in words', async () => {
    const { answer } = await renderList();
    expect(screen.getByRole('list', { name: 'Carregando…' })).toBeTruthy();
    await answer([
      aMediaItem({ id: mediaId(1), title: 'Palestra pronta' }),
      aMediaItem({
        id: mediaId(2),
        title: 'Na fila agora',
        status: 'queued',
        durationMs: null,
      }),
      aMediaItem({
        id: mediaId(3),
        title: 'Convertendo agora',
        status: 'processing',
        progress: 40,
        durationMs: null,
      }),
      aMediaItem({
        id: mediaId(4),
        title: 'Arquivo ruim',
        status: 'failed',
        failure: 'invalid-audio',
        durationMs: null,
      }),
    ]);
    expect(
      screen.getByRole('heading', { name: /Mídia — Hermetismo/ }),
    ).toBeTruthy();
    expect(screen.getByText('4 áudios · 1 h')).toBeTruthy();
    expect(screen.getByText('Na fila')).toBeTruthy();
    expect(screen.getByText('Convertendo… 40%')).toBeTruthy();
    expect(
      screen.getByText('Falhou: o arquivo não é um áudio válido'),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Palestra pronta' })
        .getAttribute('href'),
    ).toBe(`/midia/${mediaId(1)}`);
    expect(screen.queryByRole('link', { name: 'Na fila agora' })).toBeNull();
  });

  it('shows "Enviar áudio" only to who may upload (AC-4)', async () => {
    const reader = await renderList({ features: ['search'] });
    await reader.answer([]);
    expect(screen.getByText('Ainda não há áudios neste acervo.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Enviar áudio' })).toBeNull();
  });

  it('offers the upload in the empty state to who may upload', async () => {
    const { answer, fixture } = await renderList({
      features: ['media-upload'],
    });
    await answer([]);
    const buttons = screen.getAllByRole('button', { name: 'Enviar áudio' });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0] as HTMLElement);
    await fixture.whenStable();
    expect(screen.getByRole('dialog', { name: 'Enviar áudio' })).toBeTruthy();
  });

  it('says when the list cannot load and tries again', async () => {
    const { http, fixture } = await renderList();
    http.expectOne(LIST_URL).flush(null, { status: 500, statusText: 'x' });
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Não consegui carregar a mídia deste acervo.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    TestBed.tick();
    http.expectOne(LIST_URL).flush({ items: [] });
  });

  it('filters by title from 11 items on, without minding accents', async () => {
    const { answer, fixture } = await renderList();
    const many = Array.from({ length: 11 }, (_, i) =>
      aMediaItem({
        id: mediaId(i),
        title: i === 3 ? 'Lição sobre Salomão' : `Palestra ${i}`,
      }),
    );
    await answer(many);
    const filter = screen.getByRole('searchbox', {
      name: 'Filtrar por título',
    });
    fireEvent.input(filter, { target: { value: 'salomao' } });
    await fixture.whenStable();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    fireEvent.input(filter, { target: { value: 'xyz' } });
    await fixture.whenStable();
    expect(screen.getByText('Nenhum áudio com "xyz" no título.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtro' }));
    await fixture.whenStable();
    expect(screen.getAllByRole('listitem')).toHaveLength(11);
  });

  it('refreshes every 5 s while something converts, and announces it once ready', async () => {
    const { answer, http, fixture, container } = await renderList();
    await answer([
      aMediaItem({ status: 'processing', progress: 10, durationMs: null }),
    ]);
    // The list asks again on its own (20 ms in this test, 5 s in the app).
    await vi.waitFor(() =>
      http.expectOne(LIST_URL).flush({ items: [aMediaItem()] }),
    );
    await fixture.whenStable();
    expect(
      container.querySelector('[aria-live="polite"]')?.textContent,
    ).toContain('Palestra de 1998 está pronta.');
    // Nothing is moving anymore: no more requests.
    await new Promise((resolve) => setTimeout(resolve, 100));
    http.expectNone(LIST_URL);
  });

  it('lets a master retry a failure that may pass', async () => {
    const { answer, http } = await renderList({
      features: ['search'],
      master: true,
    });
    const failed = aMediaItem({
      status: 'failed',
      failure: 'too-many-attempts',
      canRetry: true,
    });
    await answer([failed]);
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    http
      .expectOne(`/api/v1/media/${failed.id}/retry`)
      .flush({ ...failed, status: 'queued' });
    TestBed.tick();
    http.expectOne(LIST_URL).flush({ items: [] });
  });

  it('asks before removing, naming the item, and removes on confirm (AC-13)', async () => {
    const { answer, http, fixture } = await renderList({
      features: ['search'],
      master: true,
    });
    const item = aMediaItem();
    await answer([item]);
    fireEvent.click(
      screen.getByRole('button', { name: 'Mais ações para Palestra de 1998' }),
    );
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remover' }));
    await fixture.whenStable();
    const dialog = screen.getByRole('dialog', {
      name: 'Remover "Palestra de 1998"?',
    });
    expect(dialog.textContent).toContain('não podem ser recuperados');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remover' }));
    http
      .expectOne({ method: 'DELETE', url: `/api/v1/media/${item.id}` })
      .flush(null);
    TestBed.tick();
    http.expectOne(LIST_URL).flush({ items: [] });
    await fixture.whenStable();
    expect(screen.getByText('Palestra de 1998 foi removido.')).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: /Mídia/ }),
    );
  });

  it('removes nothing when the master cancels', async () => {
    const { answer, http, fixture } = await renderList({
      features: ['search'],
      master: true,
    });
    await answer([aMediaItem()]);
    fireEvent.click(
      screen.getByRole('button', { name: 'Mais ações para Palestra de 1998' }),
    );
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remover' }));
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await fixture.whenStable();
    expect(screen.queryByRole('dialog')).toBeNull();
    http.expectNone({ method: 'DELETE' });
  });

  it('shows why a master action failed', async () => {
    const { answer, http, fixture } = await renderList({
      features: ['search'],
      master: true,
    });
    const failed = aMediaItem({
      status: 'failed',
      failure: 'conversion-failed',
      canRetry: true,
    });
    await answer([failed]);
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    http
      .expectOne(`/api/v1/media/${failed.id}/retry`)
      .flush(
        { error: { code: 'MEDIA_CONFLICT', message: 'x' } },
        { status: 409, statusText: 'Conflict' },
      );
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Esta mídia mudou enquanto você agia.',
    );
  });

  it('gives no master actions to a member', async () => {
    const { answer } = await renderList({
      features: ['search', 'media-upload'],
    });
    await answer([
      aMediaItem({
        status: 'failed',
        failure: 'conversion-failed',
        canRetry: false,
      }),
    ]);
    expect(screen.queryByRole('button', { name: /Mais ações/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
  });

  it('puts the new item on top and focuses it after an upload (UP-01)', async () => {
    const { answer, http, fixture, container } = await renderList({
      features: ['media-upload'],
    });
    await answer([]);
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Enviar áudio' })[0] as HTMLElement,
    );
    await fixture.whenStable();
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    const file = new File([new Uint8Array(3)], 'Nova.mp3', {
      type: 'audio/mpeg',
    });
    Object.defineProperty(input, 'files', {
      value: { item: () => file, length: 1 },
    });
    fireEvent.change(input as HTMLInputElement);
    fireEvent.click(screen.getByRole('radio', { name: /Outros autores/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    const created = aMediaItem({
      id: mediaId(9),
      title: 'Nova',
      status: 'uploading',
      durationMs: null,
    });
    http.expectOne({ method: 'POST', url: LIST_URL }).flush(created);
    http
      .expectOne(`/api/v1/media/${created.id}/file`)
      .flush({ ...created, status: 'queued' });
    TestBed.tick();
    http
      .expectOne({ method: 'GET', url: LIST_URL })
      .flush({ items: [{ ...created, status: 'queued' }] });
    await fixture.whenStable();
    await vi.waitFor(() =>
      expect(
        (document.activeElement as HTMLElement | null)?.dataset['mediaId'],
      ).toBe(created.id),
    );
    http.expectNone({ method: 'GET', url: LIST_URL });
  });

  it('closes the upload panel without uploading', async () => {
    const { answer, fixture } = await renderList({
      features: ['media-upload'],
    });
    await answer([]);
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Enviar áudio' })[0] as HTMLElement,
    );
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await fixture.whenStable();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('has no title filter for a short list', async () => {
    const { answer } = await renderList();
    await answer([aMediaItem()]);
    expect(screen.queryByRole('searchbox')).toBeNull();
  });
});
