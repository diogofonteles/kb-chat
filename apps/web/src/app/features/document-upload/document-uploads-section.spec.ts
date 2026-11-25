import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { DocumentUpload } from '@kb-chat/contracts';
import { MEDIA_POLL_MS } from '@features/media/media-polling.js';
import { fireEvent, render, screen } from '@testing-library/angular';
import { DocumentUploadsSection } from './document-uploads-section.js';
import { DocumentUploadsStore } from './document-uploads-store.js';

const URL = '/api/v1/document-uploads';

const upload = (fields: Partial<DocumentUpload>): DocumentUpload => ({
  id: crypto.randomUUID(),
  topic: 'hermetismo',
  kind: 'file',
  name: 'Caibalion.pdf',
  state: 'received',
  failure: null,
  detail: null,
  document: null,
  mediaId: null,
  bytes: 10,
  received: 10,
  uploadUrl: null,
  batch: null,
  heldBy: null,
  retriable: false,
  createdAt: '2026-11-16T10:00:00.000Z',
  updatedAt: '2026-11-16T10:00:00.000Z',
  ...fields,
});

async function renderSection(
  items: DocumentUpload[],
  topic: string | null = null,
) {
  const opened = vi.fn();
  const view = await render(DocumentUploadsSection, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      DocumentUploadsStore,
      { provide: MEDIA_POLL_MS, useValue: 20 },
    ],
    inputs: { topic, titles: new Map([['hermetismo', 'Hermetismo']]) },
    on: { documentOpened: opened },
  });
  const http = TestBed.inject(HttpTestingController);
  await new Promise((resolve) => setTimeout(resolve, 5));
  http.expectOne(URL).flush({ items });
  await view.fixture.whenStable();
  return { ...view, http, opened };
}

describe('Documentos em processamento (KBC-149 FR-2)', () => {
  it('shows each state in words, why one failed and "Abrir" once ready', async () => {
    const document = { id: 'raw/articles/c.md', title: 'O Caibalion' };
    const { opened } = await renderSection([
      upload({ name: 'convertendo.pdf', state: 'converting' }),
      upload({ name: 'no-mapa.pdf', state: 'mapped', document }),
      upload({ name: 'pronto.pdf', state: 'ready', document }),
      upload({
        kind: 'url',
        name: 'https://example.org/quebrado',
        state: 'failed',
        failure: 'conversion-failed',
      }),
    ]);

    expect(
      screen.getByRole('heading', { name: 'Documentos em processamento' }),
    ).toBeTruthy();
    expect(screen.getByText('Convertendo')).toBeTruthy();
    expect(screen.getByText('No mapa')).toBeTruthy();
    expect(screen.getByText(/próxima sincronização/)).toBeTruthy();
    expect(screen.getByText('Pronto')).toBeTruthy();
    expect(screen.getByText('Falhou')).toBeTruthy();
    expect(screen.getByText(/Não consegui converter/)).toBeTruthy();
    expect(screen.getAllByText('Hermetismo')).toHaveLength(4);
    const open = screen.getAllByRole('button', { name: 'Abrir' });
    expect(open).toHaveLength(1);
    fireEvent.click(open[0] as HTMLElement);
    expect(opened).toHaveBeenCalledWith({ topic: 'hermetismo', ...document });
  });

  it('reads again while something is on its way, and stops once all settled', async () => {
    const { http, fixture } = await renderSection([
      upload({ state: 'converting' }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    http
      .expectOne(URL)
      .flush({ items: [upload({ state: 'failed', failure: 'empty' })] });
    await fixture.whenStable();
    expect(screen.getByText(/saiu vazia/)).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 60));
    http.expectNone(URL);
  });

  it('shows nothing when nothing was sent', async () => {
    await renderSection([]);
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('in "Adicionar conteúdo" shows only the chosen collection, without naming it', async () => {
    await renderSection(
      [upload({ name: 'a.pdf' }), upload({ name: 'b.pdf', topic: 'udv' })],
      'hermetismo',
    );
    expect(screen.getByText('a.pdf')).toBeTruthy();
    expect(screen.queryByText('b.pdf')).toBeNull();
    expect(screen.queryByText('Hermetismo')).toBeNull();
  });

  it("says which ceiling an item waits for, and raises the inclusion's by 0,50", async () => {
    const batch = { id: crypto.randomUUID(), capUsd: 0.5, spentUsd: 0.5 };
    const { http, fixture } = await renderSection([
      upload({ name: 'a.pdf', heldBy: 'batch-cap', batch }),
      upload({ name: 'b.pdf', heldBy: 'month-cap' }),
    ]);
    expect(
      screen.getByText(/teto desta inclusão \(US\$ 0[.,]50\)/),
    ).toBeTruthy();
    expect(screen.getByText(/teto de gasto do mês/)).toBeTruthy();
    const raise = screen.getAllByRole('button', { name: /Aumentar o teto/ });
    expect(raise).toHaveLength(1);
    fireEvent.click(raise[0] as HTMLElement);
    const patch = http.expectOne(`/api/v1/document-batches/${batch.id}`);
    expect(patch.request.body).toEqual({ capUsd: 1 });
    patch.flush({ ...batch, capUsd: 1 });
    http.match(URL).forEach((one) => one.flush({ items: [] }));
    await fixture.whenStable();
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('an inclusion at the largest ceiling cannot be raised further', async () => {
    const batch = { id: crypto.randomUUID(), capUsd: 5, spentUsd: 5 };
    await renderSection([upload({ heldBy: 'batch-cap', batch })]);
    expect(
      screen.queryByRole('button', { name: /Aumentar o teto/ }),
    ).toBeNull();
  });

  it('a failed item the app still has goes again; one it does not have is not offered', async () => {
    const failed = upload({
      name: 'a.pdf',
      state: 'failed',
      failure: 'gave-up',
      retriable: true,
    });
    const { http } = await renderSection([
      failed,
      upload({ name: 'b.pdf', state: 'failed', failure: 'empty' }),
    ]);
    const retry = screen.getAllByRole('button', { name: 'Tentar de novo' });
    expect(retry).toHaveLength(1);
    fireEvent.click(retry[0] as HTMLElement);
    const post = http.expectOne(`${URL}/${failed.id}/retry`);
    expect(post.request.method).toBe('POST');
  });

  it('takes an item out, except one the Mac works on; a refusal says why', async () => {
    const waiting = upload({ name: 'a.pdf' });
    const { http, fixture } = await renderSection([
      waiting,
      upload({ name: 'b.pdf', state: 'converting' }),
    ]);
    expect(
      screen.queryByRole('button', { name: 'Tirar b.pdf da lista' }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Tirar a.pdf da lista' }),
    );
    http.expectOne(`${URL}/${waiting.id}`).flush(
      {
        error: { code: 'MEDIA_CONFLICT', message: 'x', requestId: 'r' },
      },
      { status: 409, statusText: 'Conflict' },
    );
    await fixture.whenStable();
    expect(screen.getByText('Não consegui fazer isso')).toBeTruthy();
  });

  it('a folder of hundreds shows the first ones, and the rest one press away', async () => {
    const many = Array.from({ length: 45 }, (_, n) =>
      upload({ name: `${n}.pdf`, state: 'ready' }),
    );
    const { fixture } = await renderSection(many);
    expect(screen.getAllByRole('listitem')).toHaveLength(30);
    fireEvent.click(screen.getByRole('button', { name: 'Ver os outros 15' }));
    await fixture.whenStable();
    expect(screen.getAllByRole('listitem')).toHaveLength(45);
  });
});
