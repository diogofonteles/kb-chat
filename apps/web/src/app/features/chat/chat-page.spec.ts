import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import { aDocument, aHit, aResponse, TOPICS } from '../../testing/fixtures.js';
import { ChatPage } from './chat-page.js';

const SEARCH_URL = '/api/v1/topics/hermetismo/searches';

async function renderPage() {
  localStorage.clear();
  const view = await render(ChatPage, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  http.expectOne('/api/v1/topics').flush(TOPICS);
  await view.fixture.whenStable();
  return { ...view, http };
}

async function ask(
  question: string,
  view: Awaited<ReturnType<typeof renderPage>>,
) {
  fireEvent.input(screen.getByLabelText('Sua pergunta'), {
    target: { value: question },
  });
  await view.fixture.whenStable();
  fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
  await view.fixture.whenStable();
}

describe('ChatPage', () => {
  it('greets with the current collection and its size', async () => {
    await renderPage();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(
      'Hermetismo',
    );
    expect(screen.getByText(/4\.235 documentos/)).toBeTruthy();
    expect(screen.getByText('O que você quer estudar hoje?')).toBeTruthy();
  });

  it('asks, shows a searching state and then the result cards', async () => {
    const view = await renderPage();
    await ask('lei do ritmo', view);
    expect(screen.getByText('lei do ritmo')).toBeTruthy();
    expect(screen.getByText(/Buscando em Hermetismo/)).toBeTruthy();
    const request = view.http.expectOne(SEARCH_URL);
    expect(request.request.body).toEqual({ q: 'lei do ritmo', mode: 'all' });
    request.flush(aResponse());
    await view.fixture.whenStable();
    expect(screen.getByText('1 documento')).toBeTruthy();
    expect(screen.getByText(/0,6 s/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /A Lei do Ritmo/ })).toBeTruthy();
    expect(
      screen.getByText('Texto/apostila · Aprofundado · Central'),
    ).toBeTruthy();
    expect(screen.getByText(/\(\+1\)/)).toBeTruthy();
  });

  it('sends with Enter, keeps Shift+Enter for a new line and remembers the mode', async () => {
    const view = await renderPage();
    fireEvent.change(screen.getByLabelText('Como buscar'), {
      target: { value: 'exact' },
    });
    const field = screen.getByLabelText('Sua pergunta');
    fireEvent.input(field, { target: { value: 'ritmo' } });
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
    view.http.expectNone(SEARCH_URL);
    fireEvent.keyDown(field, { key: 'Enter' });
    await view.fixture.whenStable();
    expect(view.http.expectOne(SEARCH_URL).request.body.mode).toBe('exact');
    expect(localStorage.getItem('kb-chat.search-mode')).toBe('exact');
  });

  it('opens the document panel and closes it with Escape', async () => {
    const view = await renderPage();
    await ask('ritmo', view);
    view.http.expectOne(SEARCH_URL).flush(aResponse());
    await view.fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: /A Lei do Ritmo/ }));
    // The panel's httpResource keeps the app unstable until flushed: render synchronously.
    TestBed.tick();
    view.http
      .expectOne(
        '/api/v1/topics/hermetismo/documents/raw%2Farticles%2Fa-lei-do-ritmo.md',
      )
      .flush(aDocument());
    await view.fixture.whenStable();
    const panel = screen.getByRole('dialog');
    expect(panel.querySelector('h1')?.textContent).toBe('A LEI DO RITMO');
    expect(screen.getByText('O texto explora a Lei do Ritmo.')).toBeTruthy();
    fireEvent.keyDown(panel, { key: 'Escape' });
    await view.fixture.whenStable();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the not-found message when the document is gone', async () => {
    const view = await renderPage();
    await ask('ritmo', view);
    view.http.expectOne(SEARCH_URL).flush(aResponse());
    await view.fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: /A Lei do Ritmo/ }));
    // The panel's httpResource keeps the app unstable until flushed: render synchronously.
    TestBed.tick();
    view.http
      .expectOne(() => true)
      .flush(
        { error: { code: 'DOCUMENT_NOT_FOUND', message: 'x' } },
        { status: 404, statusText: 'Not Found' },
      );
    await view.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toMatch(
      /não está mais no acervo/,
    );
  });

  it('offers a semantic search when nothing is found', async () => {
    const view = await renderPage();
    await ask('xyzzy', view);
    view.http.expectOne(SEARCH_URL).flush(aResponse([]));
    await view.fixture.whenStable();
    expect(screen.getByText('Nada encontrado para "xyzzy".')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Buscar por significado' }),
    );
    await view.fixture.whenStable();
    expect(view.http.expectOne(SEARCH_URL).request.body).toEqual({
      q: 'xyzzy',
      mode: 'semantic',
    });
  });

  it('keeps the question on an error and retries it', async () => {
    const view = await renderPage();
    await ask('ritmo', view);
    view.http
      .expectOne(SEARCH_URL)
      .flush(
        { error: { code: 'SEARCH_UNAVAILABLE', message: 'x' } },
        { status: 503, statusText: 'Unavailable' },
      );
    await view.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toMatch(/indisponível/);
    expect(screen.getByText('ritmo')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await view.fixture.whenStable();
    view.http
      .expectOne(SEARCH_URL)
      .flush(aResponse([aHit({ title: 'Outro' })]));
    await view.fixture.whenStable();
    expect(screen.getByRole('button', { name: /Outro/ })).toBeTruthy();
  });

  it('focuses the question box with the slash key', async () => {
    await renderPage();
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(screen.getByLabelText('Sua pergunta'));
  });

  it('clears the question with the clear button', async () => {
    const view = await renderPage();
    fireEvent.input(screen.getByLabelText('Sua pergunta'), {
      target: { value: 'ritmo' },
    });
    await view.fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Limpar pergunta' }));
    await view.fixture.whenStable();
    expect(
      (screen.getByLabelText('Sua pergunta') as HTMLTextAreaElement).value,
    ).toBe('');
    expect(
      (screen.getByRole('button', { name: 'Buscar' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe('ChatPage without collections', () => {
  it('explains the empty vault and the offline server', async () => {
    const view = await render(ChatPage, {
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/v1/topics').flush({ items: [] });
    await view.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toMatch(/Nenhum acervo/);
  });

  it('shows the offline message with a retry', async () => {
    const view = await render(ChatPage, {
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    http
      .expectOne('/api/v1/topics')
      .error(new ProgressEvent('error'), { status: 0 });
    await view.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toMatch(/servidor de busca/);
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    TestBed.tick();
    http.expectOne('/api/v1/topics').flush(TOPICS);
    await view.fixture.whenStable();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
