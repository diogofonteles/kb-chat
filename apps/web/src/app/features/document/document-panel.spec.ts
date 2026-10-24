import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import { aDocument } from '../../testing/fixtures.js';
import { DocumentPanel } from './document-panel.js';

const URL = '/api/v1/topics/hermetismo/documents/a.md';

async function renderPanel() {
  const closed = vi.fn();
  const view = await render(DocumentPanel, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
    inputs: {
      topic: 'hermetismo',
      documentId: 'a.md',
      fallbackTitle: 'Título do cartão',
    },
    on: { closed },
  });
  return { ...view, closed, http: TestBed.inject(HttpTestingController) };
}

describe('DocumentPanel', () => {
  it('shows the card title while loading and focuses it', async () => {
    const view = await renderPanel();
    expect(
      screen.getByRole('heading', { name: 'Título do cartão' }),
    ).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/Carregando/);
    expect(document.activeElement?.id).toBe('document-title');
    view.http.expectOne(URL).flush(aDocument());
  });

  it('renders a document without summary or subjects', async () => {
    const view = await renderPanel();
    view.http.expectOne(URL).flush(
      aDocument({
        summary: null,
        concepts: [],
        genre: null,
        depth: null,
        relevance: null,
      }),
    );
    await view.fixture.whenStable();
    expect(screen.queryByText('Resumo')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Assuntos' })).toBeNull();
    expect(
      screen.getByRole('heading', { name: 'A Lei do Ritmo' }),
    ).toBeTruthy();
  });

  it('closes from the back button', async () => {
    const view = await renderPanel();
    view.http.expectOne(URL).flush(aDocument());
    await view.fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Fechar documento' }));
    expect(view.closed).toHaveBeenCalledOnce();
  });
});
