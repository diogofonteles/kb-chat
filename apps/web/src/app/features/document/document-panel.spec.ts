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

  it('returns to the top and focuses the new title when the document changes', async () => {
    const view = await renderPanel();
    view.http.expectOne(URL).flush(aDocument());
    await view.fixture.whenStable();
    const host = view.fixture.nativeElement as HTMLElement;
    host.scrollTop = 500;
    screen.getByRole('button', { name: 'Fechar documento' }).focus();
    view.fixture.componentRef.setInput('documentId', 'b.md');
    TestBed.tick();
    view.http
      .expectOne('/api/v1/topics/hermetismo/documents/b.md')
      .flush(aDocument({ id: 'b.md', title: 'Outro documento' }));
    await view.fixture.whenStable();
    expect(host.scrollTop).toBe(0);
    expect(document.activeElement?.id).toBe('document-title');
    expect(
      screen.getByRole('heading', { name: 'Outro documento' }),
    ).toBeTruthy();
  });
});

describe('DocumentPanel reading tools (KBC-003)', () => {
  async function renderWith(
    inputs: Record<string, unknown>,
    doc = aDocument(),
  ) {
    const outputs = {
      navigated: vi.fn(),
      conceptSelected: vi.fn(),
      back: vi.fn(),
    };
    const view = await render(DocumentPanel, {
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
      inputs: { topic: 'hermetismo', documentId: 'a.md', ...inputs },
      on: outputs,
    });
    const http = TestBed.inject(HttpTestingController);
    http.expectOne(URL).flush(doc);
    await view.fixture.whenStable();
    return { ...view, http, ...outputs };
  }

  const body =
    'A NATUREZA SÉTUPLA\n\nA natureza é sétupla.\n\nOutro parágrafo sobre a natureza.';

  it('highlights the question terms and steps through the occurrences (AC-1, AC-2)', async () => {
    const view = await renderWith(
      { highlight: 'o que é a natureza?' },
      aDocument({ body }),
    );
    const marks = view.container.querySelectorAll('mark');
    expect(marks).toHaveLength(3);
    expect(screen.getByText('1 de 3 ocorrências')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Próxima ocorrência' }));
    fireEvent.click(screen.getByRole('button', { name: 'Próxima ocorrência' }));
    await view.fixture.whenStable();
    expect(screen.getByText('3 de 3 ocorrências')).toBeTruthy();
    expect(marks[2]?.classList.contains('current')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Próxima ocorrência' }));
    await view.fixture.whenStable();
    expect(screen.getByText('1 de 3 ocorrências')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Ocorrência anterior' }),
    );
    await view.fixture.whenStable();
    expect(screen.getByText('3 de 3 ocorrências')).toBeTruthy();
  });

  it('copies the paragraph of the current occurrence (AC-9)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const view = await renderWith(
      { highlight: 'sétupla' },
      aDocument({ body }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copiar trecho' }));
    await view.fixture.whenStable();
    expect(writeText).toHaveBeenCalledWith('A NATUREZA SÉTUPLA');
    expect(await screen.findByRole('button', { name: 'Copiado' })).toBeTruthy();
  });

  it('shows the transcription badge, the Obsidian link and the concept criterion (AC-8)', async () => {
    await renderWith(
      {},
      aDocument({ origin: 'audio', criterion: 'Documentos sobre a Cabala.' }),
    );
    expect(screen.getByText(/Transcrição automática de áudio/)).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Abrir no Obsidian' })
        .getAttribute('href'),
    ).toMatch(/^obsidian:\/\/open\?vault=/);
    expect(screen.getByText('Documentos sobre a Cabala.')).toBeTruthy();
  });

  it('shows the OCR badge', async () => {
    await renderWith({}, aDocument({ origin: 'ocr' }));
    expect(screen.getByText(/Texto extraído de imagem \(OCR\)/)).toBeTruthy();
  });

  it('emits a subject to filter the conversation (AC-7) and offers "Voltar" when it can', async () => {
    const view = await renderWith({ canGoBack: true });
    fireEvent.click(
      screen.getByRole('button', { name: 'Filtrar a conversa por Cabala' }),
    );
    expect(view.conceptSelected).toHaveBeenCalledWith('Cabala');
    fireEvent.click(screen.getByRole('button', { name: '← Voltar' }));
    expect(view.back).toHaveBeenCalledOnce();
  });

  it('opens a "Veja também" link in the panel and hides empty groups (AC-6, AC-10)', async () => {
    const view = await renderWith({});
    expect(screen.getByRole('heading', { name: 'Veja também' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Relacionados' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cabala' }));
    expect(view.navigated).toHaveBeenCalledWith({
      id: 'wiki/concepts/Cabala.md',
      title: 'Cabala',
    });
  });

  it('loads more references with "Ver todos" (AC-5)', async () => {
    const refs = Array.from({ length: 5 }, (_, i) => ({
      id: `d${i}.md`,
      title: `Doc ${i}`,
    }));
    const empty = { items: [], total: 0 };
    const seeAlso = {
      ...aDocument().seeAlso,
      exampleOf: empty,
      examples: { items: refs, total: 8 },
    };
    const view = await renderWith({}, aDocument({ concepts: [], seeAlso }));
    fireEvent.click(screen.getByRole('button', { name: 'Ver todos (8)' }));
    view.http
      .expectOne(
        (req) =>
          req.url ===
          '/api/v1/topics/hermetismo/documents/a.md/relations/examples',
      )
      .flush({
        items: [{ id: 'd5.md', title: 'Doc 5' }],
        total: 8,
        nextOffset: null,
      });
    await view.fixture.whenStable();
    expect(screen.getByRole('button', { name: 'Doc 5' })).toBeTruthy();
  });

  it('does not show the see-also section without relations', async () => {
    const empty = { items: [], total: 0 };
    const seeAlso = {
      exampleOf: empty,
      extends: empty,
      related: empty,
      examples: empty,
      extendedBy: empty,
      relatedFrom: empty,
    };
    await renderWith({}, aDocument({ seeAlso }));
    expect(screen.queryByRole('heading', { name: 'Veja também' })).toBeNull();
  });
});
