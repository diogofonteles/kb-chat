import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import type { DocumentRemoval } from '@kb-chat/contracts';
import { RemoveDocumentDialog } from './remove-document-dialog.js';

const ID = '11111111-1111-4111-8111-111111111111';
const REMOVAL: DocumentRemoval = {
  id: ID,
  topic: 'hermetismo',
  collection: 'Hermetismo',
  document: { id: 'raw/livro.md', title: 'O Livro' },
  state: 'removing',
  detail: null,
  by: 'Dono',
  removedAt: '2026-11-25T12:00:00.000Z',
};
const URL = '/api/v1/topics/hermetismo/documents/raw%2Flivro.md/removal';

async function opened() {
  const removed = vi.fn();
  const view = await render(RemoveDocumentDialog, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
    inputs: {
      topic: 'hermetismo',
      documentId: 'raw/livro.md',
      title: 'O Livro',
      collection: 'Hermetismo',
    },
    on: { removed },
  });
  view.fixture.componentInstance.open();
  await view.fixture.whenStable();
  return { ...view, removed, http: TestBed.inject(HttpTestingController) };
}

const press = (name: string) =>
  fireEvent.click(screen.getByRole('button', { name, hidden: true }));

describe('RemoveDocumentDialog (KBC-187)', () => {
  it('names the document and the collection, and says nothing is deleted', async () => {
    const { http } = await opened();
    expect(
      screen.getByText(/“O Livro” sai do acervo Hermetismo agora/),
    ).toBeTruthy();
    expect(screen.getByText(/Nada é apagado/)).toBeTruthy();
    press('Cancelar');
    http.expectNone(URL);
  });

  it('removes it, says where it can come back from, and tells who opened it', async () => {
    const { http, fixture, removed } = await opened();
    press('Remover do acervo');
    http.expectOne({ method: 'POST', url: URL }).flush(REMOVAL);
    await fixture.whenStable();
    expect(
      screen.getByText(/“O Livro” saiu do acervo Hermetismo/),
    ).toBeTruthy();
    expect(removed).not.toHaveBeenCalled();
    press('Concluir');
    await fixture.whenStable();
    expect(removed).toHaveBeenCalledOnce();
  });

  it('brings it back right there, as if it never left', async () => {
    const { http, fixture, removed } = await opened();
    press('Remover do acervo');
    http.expectOne(URL).flush(REMOVAL);
    await fixture.whenStable();
    press('Trazer de volta');
    http
      .expectOne({
        method: 'POST',
        url: `/api/v1/document-removals/${ID}/restore`,
      })
      .flush({ removal: null });
    await fixture.whenStable();
    expect(removed).not.toHaveBeenCalled();
  });

  it('says why it did not happen, and may be asked again', async () => {
    const { http, fixture } = await opened();
    press('Remover do acervo');
    http
      .expectOne(URL)
      .flush(
        { error: { code: 'DOCUMENT_NOT_FOUND', message: 'x' } },
        { status: 404, statusText: 'Not Found' },
      );
    await fixture.whenStable();
    expect(
      screen.getByRole('alert', { hidden: true }).textContent,
    ).toBeTruthy();
    press('Remover do acervo');
    http.expectOne(URL).flush(REMOVAL);
  });
});
