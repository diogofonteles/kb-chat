import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { TUS_UPLOAD } from '@core/media/tus-upload.js';
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
  aTranscription,
  chatStoreOn,
  mediaId,
  sessionAs,
} from '../../testing/media-fixtures.js';
import { answeringLevels } from '../../testing/level-fixtures.js';
import { answeringOptions } from '../../testing/preparation-fixtures.js';
import { MediaListPage } from './media-list-page.js';
import { ChatStore } from '@features/chat/chat-store.js';
import { MEDIA_POLL_MS } from './media-polling.js';
import { AUDIO_LENGTH_READER } from './audio-length.js';
import { of } from 'rxjs';
import { FakeTus } from '../../testing/fake-tus.js';

const LIST_URL = '/api/v1/topics/hermetismo/media';

/** The file's hash runs on its own; waits for the question and says it is new. */
async function answerCheck(http: HttpTestingController, url: string) {
  await vi.waitFor(() =>
    http.expectOne(`${url}/check`).flush({ verdict: 'new' }),
  );
}

async function renderList(
  who: { features: Feature[]; master?: boolean } = { features: ['search'] },
  /** Long by default: a poll firing during whenStable would keep it waiting. */
  pollMs = 60_000,
) {
  const tus = new FakeTus();
  const view = await render(MediaListPage, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(
        withInterceptors([answeringOptions(), answeringLevels()]),
      ),
      provideHttpClientTesting(),
      provideRouter([
        { path: 'midia', children: [] },
        { path: 'fila', children: [] },
      ]),
      chatStoreOn(),
      sessionAs(who),
      { provide: MEDIA_POLL_MS, useValue: pollMs },
      { provide: TUS_UPLOAD, useValue: tus.factory },
      { provide: AUDIO_LENGTH_READER, useValue: () => of(60_000) },
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  const answer = async (items: MediaItem[]) => {
    http.expectOne(LIST_URL).flush({ items });
    await view.fixture.whenStable();
  };
  return { ...view, http, answer, tus };
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

  it('filters by author, the main one with ✦, "Outros autores" for none (KBC-049 FR-4)', async () => {
    const { answer, fixture } = await renderList();
    const gabriel = {
      slug: 'mestre-gabriel',
      name: 'Mestre Gabriel',
      main: true,
    };
    await answer([
      aMediaItem({ id: mediaId(1), title: 'Aula A', author: gabriel }),
      aMediaItem({ id: mediaId(2), title: 'Aula B', author: null }),
      aMediaItem({
        id: mediaId(3),
        title: 'Aula C',
        author: { slug: 'ana', name: 'Ana', main: false },
      }),
    ]);
    const filter = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Autoria',
    });
    expect(
      [...filter.options].map((option) => option.textContent?.trim()),
    ).toEqual([
      'Todos',
      'Mestre Gabriel, principal (1)',
      'Ana (1)',
      'Outros autores (1)',
    ]);
    expect(
      screen.getByText('Outros autores', {
        selector: '.authorship-badge *, .authorship-badge',
      }),
    ).toBeTruthy();

    fireEvent.change(filter, { target: { value: '-' } });
    await fixture.whenStable();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Aula B')).toBeTruthy();
  });

  it('has no author filter when every item has the same authorship', async () => {
    const { answer } = await renderList();
    await answer([aMediaItem()]);
    expect(screen.queryByRole('combobox', { name: 'Autoria' })).toBeNull();
  });

  it('refreshes every 5 s while something converts, and announces it once ready', async () => {
    const { http, container } = await renderList(undefined, 20);
    http.expectOne(LIST_URL).flush({
      items: [
        aMediaItem({ status: 'processing', progress: 10, durationMs: null }),
      ],
    });
    // The list asks again on its own (20 ms in this test, 5 s in the app).
    await vi.waitFor(() =>
      http.expectOne(LIST_URL).flush({ items: [aMediaItem()] }),
    );
    // Not whenStable: one more tick may ask again before the polling sees it is ready.
    await vi.waitFor(() => {
      for (const extra of http.match(LIST_URL))
        extra.flush({ items: [aMediaItem()] });
      TestBed.tick();
      expect(
        container.querySelector('[aria-live="polite"]')?.textContent,
      ).toContain('Palestra de 1998 está pronta.');
    });
    for (const extra of http.match(LIST_URL))
      extra.flush({ items: [aMediaItem()] });
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
        canEdit: false,
      }),
    ]);
    expect(screen.queryByRole('button', { name: /Mais ações/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
  });

  it('puts the new item on top and focuses it after an upload (UP-01)', async () => {
    const { answer, http, fixture, container, tus } = await renderList({
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
    Object.defineProperty(input, 'files', { value: [file] });
    fireEvent.change(input as HTMLInputElement);
    await answerCheck(http, LIST_URL);
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    const created = aMediaItem({
      id: mediaId(9),
      title: 'Nova',
      status: 'uploading',
      durationMs: null,
    });
    http.expectOne({ method: 'POST', url: LIST_URL }).flush(created);
    tus.last.succeed();
    http
      .expectOne(`/api/v1/media/${created.id}`)
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

  it('shows where each preparation stopped after several files went (KBC-072 FR-6)', async () => {
    const OPEN_URL = '/api/v1/media/preparations';
    const { answer, http, fixture, container, tus } = await renderList({
      features: ['media-upload', 'media-edit'],
    });
    TestBed.tick();
    http.expectOne(OPEN_URL).flush({ items: [] });
    await answer([]);
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Enviar áudio' })[0] as HTMLElement,
    );
    await fixture.whenStable();
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    const files = ['Uma.mp3', 'Outra.mp3'].map(
      (name, i) =>
        new File([new Uint8Array(3 + i)], name, { type: 'audio/mpeg' }),
    );
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    fireEvent.change(input as HTMLInputElement);
    await answerCheck(http, LIST_URL);
    await answerCheck(http, LIST_URL);
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    const items = [9, 8].map((n) =>
      aMediaItem({ id: mediaId(n), title: `Nova ${n}`, status: 'uploading' }),
    );
    const creates = http.match({ method: 'POST', url: LIST_URL });
    creates.forEach((call, i) => call.flush(items[i] as MediaItem));
    await fixture.whenStable();
    items.forEach((item, i) => {
      tus.sessions[i]?.succeed();
      http
        .expectOne(`/api/v1/media/${item.id}`)
        .flush({ ...item, status: 'queued' });
    });
    TestBed.tick();
    http
      .match({ method: 'GET', url: LIST_URL })
      .filter((call) => !call.cancelled)
      .forEach((call) => call.flush({ items }));
    http
      .match(OPEN_URL)
      .filter((call) => !call.cancelled)
      .forEach((call) =>
        call.flush({ items: [{ mediaId: mediaId(9), step: 2 }] }),
      );
    await fixture.whenStable();
    expect(screen.getByText('Preparação parada no passo 2')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Continuar' })).toBeTruthy();
  });

  it('says where an upload sent to another collection went, without moving the focus', async () => {
    const { answer, http, fixture, container, tus } = await renderList({
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
    Object.defineProperty(input, 'files', { value: [file] });
    fireEvent.change(input as HTMLInputElement);
    await answerCheck(http, LIST_URL);
    fireEvent.change(screen.getByRole('combobox', { name: 'Acervo' }), {
      target: { value: 'alquimia' },
    });
    await answerCheck(http, '/api/v1/topics/alquimia/media');
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    const created = aMediaItem({
      id: mediaId(9),
      title: 'Nova',
      topic: 'alquimia',
      status: 'uploading',
      durationMs: null,
    });
    http
      .expectOne({ method: 'POST', url: '/api/v1/topics/alquimia/media' })
      .flush(created);
    tus.last.succeed();
    http
      .expectOne(`/api/v1/media/${created.id}`)
      .flush({ ...created, status: 'queued' });
    await fixture.whenStable();
    expect(screen.getByRole('status').textContent).toContain(
      'Nova foi enviado para o acervo Alquimia.',
    );
    http.expectNone({ method: 'GET', url: LIST_URL });
    expect(
      (document.activeElement as HTMLElement | null)?.dataset['mediaId'],
    ).toBeUndefined();
    // Switching collection leaves no stale notice behind.
    TestBed.inject(ChatStore).topicSlug.set('alquimia');
    TestBed.tick();
    http.expectOne('/api/v1/topics/alquimia/media').flush({ items: [created] });
    await fixture.whenStable();
    expect(screen.getByRole('status').textContent?.trim()).toBe('');
  });

  it('shows "Continuar de" and the share heard on a media with a saved position (T14)', async () => {
    const { answer, container } = await renderList();
    await answer([
      aMediaItem({ positionMs: 1_390_000, durationMs: 3_735_000 }),
      aMediaItem({
        id: mediaId(2),
        title: 'Ouvida até o fim',
        positionMs: 0,
        completedAt: '2026-10-28T12:00:00.000Z',
      }),
    ]);
    const [first, second] = screen.getAllByRole('listitem');
    expect(first?.textContent).toContain('Continuar de 23:10');
    const bar = container.querySelector<HTMLElement>('.position span');
    expect(bar?.style.width).toMatch(/^37\.2/);
    expect(second?.textContent).not.toContain('Continuar de');
  });

  it('says where each transcription is, with the low notice in words (KBC-036)', async () => {
    const { answer } = await renderList();
    await answer([
      aMediaItem({
        transcription: aTranscription({ status: 'waiting', transcriber: 'on' }),
      }),
      aMediaItem({
        id: mediaId(2),
        transcription: aTranscription({ status: 'done', confidence: 'low' }),
      }),
      aMediaItem({
        id: mediaId(3),
        transcription: aTranscription({
          status: 'transcribing',
          confidence: 'low',
          version: 1,
        }),
      }),
    ]);
    const [waiting, low, again] = screen.getAllByRole('listitem');
    expect(waiting?.textContent).toContain('Aguardando o transcritor');
    expect(low?.textContent).toContain(
      'Transcrição automática de baixa confiança',
    );
    expect(again?.textContent).toContain('Retranscrevendo…');
    expect(again?.textContent).toContain(
      'Transcrição automática de baixa confiança',
    );
  });

  it('brings what takes the focus fully into view, but never moves the page under a press (WCAG 2.4.11)', async () => {
    const { answer } = await renderList();
    await answer([aMediaItem()]);
    const link = screen.getByRole('link', { name: /Palestra de 1998/ });
    const scroll = vi.fn();
    link.scrollIntoView = scroll;
    const pressed = vi.spyOn(link, 'matches');

    pressed.mockReturnValue(true);
    fireEvent.focusIn(link);
    expect(pressed).toHaveBeenCalledWith(':active');
    expect(scroll).not.toHaveBeenCalled();

    pressed.mockReturnValue(false);
    fireEvent.focusIn(link);
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
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

describe('MediaListPage: "Editar informações" (KBC-050)', () => {
  const itemUrl = (id: string) => `/api/v1/media/${id}`;
  /** A resource's request goes out after the answer's task, in the effects. */
  const nextRequest = async () => {
    await new Promise((resolve) => setTimeout(resolve));
    TestBed.tick();
  };

  async function openEdit(
    item: MediaItem,
    who?: Parameters<typeof renderList>[0],
  ) {
    const view = await renderList(who);
    await view.answer([item]);
    fireEvent.click(
      screen.getByRole('button', { name: `Mais ações para ${item.title}` }),
    );
    await view.fixture.whenStable();
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Editar informações' }),
    );
    await view.fixture.whenStable();
    return view;
  }

  it('FR-2: shows no menu to who may not edit', async () => {
    const { answer } = await renderList({ features: ['media'] });
    await answer([aMediaItem({ canEdit: false })]);
    expect(screen.queryByRole('button', { name: /Mais ações/ })).toBeNull();
  });

  it('FR-2: who sent it edits but does not remove', async () => {
    const { answer, fixture } = await renderList({ features: ['media'] });
    await answer([aMediaItem({ canEdit: true })]);
    fireEvent.click(screen.getByRole('button', { name: /Mais ações/ }));
    await fixture.whenStable();
    expect(
      screen.getAllByRole('menuitem').map((one) => one.textContent?.trim()),
    ).toEqual(['Editar informações']);
  });

  it('AC-1: saving closes the dialog, reloads and says so', async () => {
    const item = aMediaItem({ canEdit: true });
    const { http, fixture } = await openEdit(item);
    fireEvent.input(screen.getByLabelText('Título'), {
      target: { value: 'A conselheira do rei' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    const renamed = { ...item, title: 'A conselheira do rei' };
    http.expectOne(itemUrl(item.id)).flush(renamed);
    await nextRequest();
    http.expectOne(LIST_URL).flush({ items: [renamed] });
    await fixture.whenStable();
    expect(screen.getByText('Informações salvas')).toBeTruthy();
    expect(screen.getByRole('link', { name: renamed.title })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Ver o acervo' })).toBeNull();
  });

  it('AC-1: another audio getting ready on that reload does not take the saved notice away', async () => {
    const item = aMediaItem({ canEdit: true });
    const converting = aMediaItem({
      id: mediaId(2),
      title: 'A do vizinho',
      status: 'processing',
      progress: 90,
      durationMs: null,
    });
    const view = await renderList();
    await view.answer([item, converting]);
    fireEvent.click(
      screen.getByRole('button', { name: `Mais ações para ${item.title}` }),
    );
    await view.fixture.whenStable();
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Editar informações' }),
    );
    await view.fixture.whenStable();
    fireEvent.input(screen.getByLabelText('Título'), {
      target: { value: 'A conselheira do rei' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    const renamed = { ...item, title: 'A conselheira do rei' };
    view.http.expectOne(itemUrl(item.id)).flush(renamed);
    await nextRequest();
    const ready = {
      ...aMediaItem(),
      id: converting.id,
      title: converting.title,
    };
    view.http.expectOne(LIST_URL).flush({ items: [renamed, ready] });
    await view.fixture.whenStable();
    expect(screen.getByText('A do vizinho está pronta.')).toBeTruthy();
    expect(screen.getByText('Informações salvas')).toBeTruthy();
  });

  it('AC-2: a moved audio leaves the list with the notice, the link and the focus on the page', async () => {
    const item = aMediaItem({ canEdit: true, author: null });
    const { http, fixture } = await openEdit(item);
    fireEvent.change(screen.getByLabelText('Acervo'), {
      target: { value: 'alquimia' },
    });
    // KBC-105: the new collection's levels are asked first (none here).
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    http.expectOne(itemUrl(item.id)).flush({ ...item, topic: 'alquimia' });
    await nextRequest();
    http.expectOne(LIST_URL).flush({ items: [] });
    await fixture.whenStable();
    const text = 'Palestra de 1998 foi movido para o acervo Alquimia.';
    expect(screen.getAllByText(new RegExp(text)).length).toBe(2);
    const link = screen.getByRole('link', { name: 'Ver o acervo' });
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: /Mídia/ }),
    );
    fireEvent.click(link);
    expect(TestBed.inject(ChatStore).topicSlug()).toBe('alquimia');
  });

  it('a filter that no longer shows it takes the focus to the page', async () => {
    const item = aMediaItem({ canEdit: true, author: null });
    const view = await renderList();
    const many = Array.from({ length: 11 }, (_, n) =>
      aMediaItem({ id: mediaId(n + 1), title: `Palestra ${n}`, canEdit: true }),
    );
    await view.answer(many);
    fireEvent.input(screen.getByLabelText('Filtrar por título'), {
      target: { value: 'Palestra 1' },
    });
    await view.fixture.whenStable();
    fireEvent.click(
      screen.getByRole('button', { name: 'Mais ações para Palestra 1' }),
    );
    await view.fixture.whenStable();
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Editar informações' }),
    );
    await view.fixture.whenStable();
    fireEvent.input(screen.getByLabelText('Título'), {
      target: { value: 'Outra' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    view.http
      .expectOne(itemUrl(mediaId(2)))
      .flush({ ...item, id: mediaId(2), title: 'Outra' });
    await nextRequest();
    view.http.expectOne(LIST_URL).flush({ items: many });
    await view.fixture.whenStable();
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: /Mídia/ }),
    );
  });
});
