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
  createdAt: '2026-11-16T10:00:00.000Z',
  updatedAt: '2026-11-16T10:00:00.000Z',
  ...fields,
});

async function renderSection(items: DocumentUpload[]) {
  const opened = vi.fn();
  const view = await render(DocumentUploadsSection, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      DocumentUploadsStore,
      { provide: MEDIA_POLL_MS, useValue: 20 },
    ],
    inputs: { titles: new Map([['hermetismo', 'Hermetismo']]) },
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
});
