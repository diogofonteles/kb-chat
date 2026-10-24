import {
  HttpResponse,
  provideHttpClient,
  withInterceptors,
  type HttpInterceptorFn,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen, within } from '@testing-library/angular';
import { aDocument, aHit, aResponse, TOPICS } from '../../testing/fixtures.js';
import { NO_FILTERS } from './chat-message.js';
import { ChatPage } from './chat-page.js';
import { AnswersApi } from '@core/api/answers-api.js';
import { UsageLog } from '@core/usage/usage-log.js';
import {
  RESEARCH_RESTORER,
  type ResearchRestorer,
} from '@core/history/research-restorer.js';
import type { ResearchConversation } from '@kb-chat/contracts';
import { EMPTY, of } from 'rxjs';
import {
  FakeConversationsServer,
  aSearchConversation,
} from '../../testing/fake-conversations.js';

/** The page tests cover search and reading; the AI block gets a quiet stand-in. */
const FAKE_ANSWERS = {
  provide: AnswersApi,
  useValue: {
    estimate: () =>
      of({
        usd: 0.0005,
        model: 'stub/model',
        passages: 1,
        billing: 'per-token' as const,
      }),
    answer: () => EMPTY,
    spendToday: () => of({ usd: 0, capUsd: 1, configured: true }),
  },
};

const SEARCH_URL = '/api/v1/topics/hermetismo/searches';

/** Start suggestions per collection (KBC-006); tests that need them set `suggestions`. */
let suggestions: { concept: string; count: number }[] = [];
/** The local API's conversation history; each render starts with an empty one. */
let conversations = new FakeConversationsServer();
const fakeStartRequests: HttpInterceptorFn = (request, next) =>
  request.url.endsWith('/suggestions')
    ? of(new HttpResponse({ status: 200, body: { items: suggestions } }))
    : conversations.interceptor(request, next);
const usage = { track: vi.fn() };

async function renderPage(
  extraProviders: { provide: unknown; useValue: unknown }[] = [],
) {
  localStorage.clear();
  usage.track.mockClear();
  const view = await render(ChatPage, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(withInterceptors([fakeStartRequests])),
      provideHttpClientTesting(),
      FAKE_ANSWERS,
      { provide: UsageLog, useValue: usage },
      ...extraProviders,
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
    expect(request.request.body).toEqual({
      q: 'lei do ritmo',
      mode: 'all',
      filters: NO_FILTERS,
    });
    request.flush(aResponse());
    await view.fixture.whenStable();
    expect(screen.getByText(/^1 documento · Tudo · 0,6 s$/)).toBeTruthy();
    expect(
      document.querySelector('.page-announcement')?.textContent?.trim(),
    ).toBe('lei do ritmo: 1 documento encontrado.');
    expect(
      screen
        .getByRole('region', { name: 'Conversa' })
        .getAttribute('aria-live'),
    ).toBeNull();
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
    expect(panel.querySelector('.body h3')?.textContent).toBe('A LEI DO RITMO');
    expect(screen.getByText('O texto explora a Lei do Ritmo.')).toBeTruthy();
    fireEvent.keyDown(panel, { key: 'Escape' });
    await view.fixture.whenStable();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /A Lei do Ritmo/ }),
    );
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
      filters: NO_FILTERS,
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
    expect(
      within(screen.getByRole('region', { name: 'Conversa' })).getByText(
        'ritmo',
      ),
    ).toBeTruthy();
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

describe('ChatPage refining', () => {
  it('re-runs the same message with a chosen filter and loads more pages', async () => {
    const view = await renderPage();
    await ask('ritmo', view);
    view.http
      .expectOne(SEARCH_URL)
      .flush(aResponse([aHit()], { nextOffset: 10, total: 12 }));
    await view.fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: /Tipo de texto/ }));
    await view.fixture.whenStable();
    fireEvent.click(screen.getByRole('checkbox', { name: /Texto\/apostila/ }));
    await view.fixture.whenStable();
    // Chip changes are debounced (250 ms) so rapid clicks send one search.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const refined = view.http.expectOne(SEARCH_URL);
    expect(refined.request.body.filters.genres).toEqual(['article_or_essay']);
    refined.flush(aResponse([aHit()], { nextOffset: 10, total: 12 }));
    await view.fixture.whenStable();
    expect(screen.getAllByText('ritmo', { exact: false })).toBeTruthy();
    expect(document.querySelectorAll('app-result-message')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar mais' }));
    await view.fixture.whenStable();
    const more = view.http.expectOne(SEARCH_URL);
    expect(more.request.body).toMatchObject({
      offset: 10,
      filters: { genres: ['article_or_essay'] },
    });
    more.flush(
      aResponse([aHit({ id: 'b.md', title: 'Segundo' })], {
        nextOffset: null,
        total: 12,
      }),
    );
    await view.fixture.whenStable();
    expect(screen.getByRole('button', { name: /Segundo/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mostrar mais' })).toBeNull();
  });

  it('opens a copy of a grouped result', async () => {
    const view = await renderPage();
    await ask('ritmo', view);
    view.http.expectOne(SEARCH_URL).flush(
      aResponse([
        aHit({
          copies: [
            {
              id: 'raw/articles/a-lei-do-ritmo-2.md',
              title: 'A Lei do Ritmo',
            },
          ],
        }),
      ]),
    );
    await view.fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: '+1 cópia' }));
    await view.fixture.whenStable();
    fireEvent.click(
      screen.getByRole('button', { name: /a-lei-do-ritmo-2\.md/ }),
    );
    TestBed.tick();
    view.http
      .expectOne(
        '/api/v1/topics/hermetismo/documents/raw%2Farticles%2Fa-lei-do-ritmo-2.md',
      )
      .flush(aDocument());
    await view.fixture.whenStable();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('ChatPage default collection', () => {
  it('opens the KB_TOPIC collection when the API names one', async () => {
    const view = await render(ChatPage, {
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withInterceptors([fakeStartRequests])),
        provideHttpClientTesting(),
        FAKE_ANSWERS,
      ],
    });
    TestBed.inject(HttpTestingController)
      .expectOne('/api/v1/topics')
      .flush({ ...TOPICS, defaultSlug: 'alquimia' });
    await view.fixture.whenStable();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(
      'Alquimia',
    );
  });

  it('announces a failed search in the live region', async () => {
    const view = await renderPage();
    await ask('ritmo', view);
    view.http
      .expectOne(SEARCH_URL)
      .flush(
        { error: { code: 'RATE_LIMITED', message: 'x' } },
        { status: 429, statusText: 'Too Many' },
      );
    await view.fixture.whenStable();
    expect(document.querySelector('.page-announcement')?.textContent).toMatch(
      /Muitas buscas/,
    );
  });
});

describe('ChatPage without collections', () => {
  it('explains the empty vault and the offline server', async () => {
    const view = await render(ChatPage, {
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withInterceptors([fakeStartRequests])),
        provideHttpClientTesting(),
        FAKE_ANSWERS,
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/v1/topics').flush({ items: [], defaultSlug: null });
    await view.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toMatch(/Nenhum acervo/);
  });

  it('shows the offline message with a retry', async () => {
    const view = await render(ChatPage, {
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withInterceptors([fakeStartRequests])),
        provideHttpClientTesting(),
        FAKE_ANSWERS,
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

describe('ChatPage side panel (KBC-005)', () => {
  beforeEach(() => {
    conversations = new FakeConversationsServer();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.removeAttribute('data-theme');
  });

  it('starts a new conversation and focuses the question box (AC-1)', async () => {
    const view = await renderPage();
    await ask('lei do ritmo', view);
    view.http.expectOne(SEARCH_URL).flush(aResponse());
    await view.fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: /Nova conversa/ }));
    await view.fixture.whenStable();
    expect(screen.getByText('O que você quer estudar hoje?')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Sua pergunta'));
  });

  it('lists finished conversations and restores one by running it again (AC-2)', async () => {
    const view = await renderPage();
    await ask('lei do ritmo', view);
    view.http.expectOne(SEARCH_URL).flush(aResponse());
    await view.fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: /Nova conversa/ }));
    await ask('caibalion', view);
    view.http.expectOne(SEARCH_URL).flush(aResponse());
    await view.fixture.whenStable();
    const history = screen.getByRole('navigation', { name: /Histórico/ });
    const items = history.querySelectorAll('button');
    expect([...items].map((b) => b.textContent)).toEqual([
      expect.stringContaining('caibalion'),
      expect.stringContaining('lei do ritmo'),
    ]);
    expect(items[0]?.getAttribute('aria-current')).toBe('true');
    fireEvent.click(items[1] as HTMLElement);
    await view.fixture.whenStable();
    const rerun = view.http.expectOne(SEARCH_URL);
    expect(rerun.request.body.q).toBe('lei do ritmo');
    rerun.flush(aResponse());
    await view.fixture.whenStable();
    expect(
      screen.queryByText('caibalion', { selector: '.question-text, p' }),
    ).toBeNull();
    expect(
      history.querySelector('[aria-current="true"]')?.textContent,
    ).toContain('lei do ritmo');
  });

  it('switches the collection into a new conversation with an inline notice (AC-5)', async () => {
    const view = await renderPage();
    await ask('lei do ritmo', view);
    view.http.expectOne(SEARCH_URL).flush(aResponse());
    await view.fixture.whenStable();
    fireEvent.change(screen.getByLabelText('Acervo'), {
      target: { value: 'alquimia' },
    });
    await view.fixture.whenStable();
    expect(screen.getByRole('status').textContent).toContain(
      'Nova conversa em Alquimia',
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(
      '1 documento',
    );
    await ask('pedra', view);
    expect(
      view.http.expectOne('/api/v1/topics/alquimia/searches').request.body.q,
    ).toBe('pedra');
    expect(screen.queryByText('Nova conversa em Alquimia')).toBeNull();
  });

  it('shows today’s AI spend and applies the chosen theme (AC-8, FR-4)', async () => {
    const view = await renderPage();
    expect(screen.getByText(/^US\$\s0,00 de US\$\s1,00$/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Tema'), {
      target: { value: 'esoteric' },
    });
    await view.fixture.whenStable();
    expect(document.documentElement.dataset['theme']).toBe('esoteric');
    expect(localStorage.getItem('kb-chat.theme')).toBe('esoteric');
    fireEvent.change(screen.getByLabelText('Tema'), {
      target: { value: 'auto' },
    });
    await view.fixture.whenStable();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('says the history is unavailable when the API fails, and search still works', async () => {
    conversations.failWith = 0;
    const view = await renderPage();
    expect(screen.getByText('Histórico indisponível no momento.')).toBeTruthy();
    conversations.failWith = null;
    await ask('lei do ritmo', view);
    view.http.expectOne(SEARCH_URL).flush(aResponse());
    await view.fixture.whenStable();
    expect(screen.getByText(/^1 documento · Tudo/)).toBeTruthy();
  });

  it('lists conversations saved before, of both kinds, with their label', async () => {
    const search = aSearchConversation({
      title: 'lei do ritmo',
      updatedAt: '2026-10-24T10:00:00.000Z',
    });
    const research = aResearchConversation('quais são os princípios');
    for (const saved of [search, research])
      conversations.saved.set(saved.id, saved);
    await renderPage();
    const history = screen.getByRole('navigation', { name: 'Histórico' });
    expect(screen.getByText('neste computador')).toBeTruthy();
    const items = within(history).getAllByRole('button');
    expect(
      items.map((b) => b.textContent?.replace(/\s+/g, ' ').trim()),
    ).toEqual([
      'quais são os princípios IA · Hermetismo',
      'lei do ritmo Busca · Hermetismo',
    ]);
  });

  it('hands a research conversation to the research view without searching (KBC-008 FR-6)', async () => {
    const research = aResearchConversation('quais são os princípios');
    conversations.saved.set(research.id, research);
    const restorer: ResearchRestorer = { restore: vi.fn() };
    const view = await renderPage([
      { provide: RESEARCH_RESTORER, useValue: restorer },
    ]);
    fireEvent.click(
      screen.getByRole('button', { name: /quais são os princípios/ }),
    );
    await view.fixture.whenStable();
    expect(restorer.restore).toHaveBeenCalledWith(research);
    view.http.expectNone(SEARCH_URL);
  });

  it('says so when a conversation cannot be opened', async () => {
    const search = aSearchConversation({ title: 'lei do ritmo' });
    conversations.saved.set(search.id, search);
    const view = await renderPage();
    conversations.saved.delete(search.id);
    fireEvent.click(screen.getByRole('button', { name: /lei do ritmo/ }));
    await view.fixture.whenStable();
    expect(
      screen.getByText('Não consegui abrir essa conversa. Tente de novo.'),
    ).toBeTruthy();
    view.http.expectNone(SEARCH_URL);
  });
});

function aResearchConversation(title: string): ResearchConversation {
  return {
    kind: 'research',
    id: crypto.randomUUID(),
    topic: 'hermetismo',
    title,
    createdAt: '2026-10-24T11:00:00.000Z',
    updatedAt: '2026-10-24T11:00:00.000Z',
    turns: [
      {
        question: title,
        answer: 'Mentalismo, correspondência…',
        sources: [],
        steps: 3,
        usd: 0.01,
        model: 'stub/model',
        interrupted: false,
        at: '2026-10-24T11:00:00.000Z',
      },
    ],
  };
}

describe('ChatPage start suggestions and usage log (KBC-006)', () => {
  afterEach(() => {
    suggestions = [];
  });

  it('offers the largest subjects and searches one with its filter on (AC-1, AC-2)', async () => {
    suggestions = [
      { concept: 'Cabala', count: 120 },
      { concept: 'Alquimia', count: 80 },
    ];
    const view = await renderPage();
    const group = screen.getByRole('group', { name: 'Comece por um assunto:' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((b) => b.textContent?.trim())).toEqual([
      'Cabala',
      'Alquimia',
    ]);
    fireEvent.click(buttons[0] as HTMLElement);
    await view.fixture.whenStable();
    const request = view.http.expectOne(SEARCH_URL);
    expect(request.request.body).toEqual({
      q: 'Cabala',
      mode: 'all',
      filters: { ...NO_FILTERS, concepts: ['Cabala'] },
    });
  });

  it('hides the suggestions when the collection has none', async () => {
    await renderPage();
    expect(
      screen.queryByRole('group', { name: 'Comece por um assunto:' }),
    ).toBeNull();
  });

  it('logs the search and the opened result with its position (AC-3)', async () => {
    const view = await renderPage();
    await ask('lei do ritmo', view);
    view.http
      .expectOne(SEARCH_URL)
      .flush(aResponse([aHit(), aHit({ id: 'b.md', title: 'Segundo' })]));
    await view.fixture.whenStable();
    expect(usage.track).toHaveBeenCalledWith({
      type: 'search',
      origin: 'typed',
      question: 'lei do ritmo',
      mode: 'all',
      filterCount: 0,
      total: 2,
      tookMs: 640,
    });
    fireEvent.click(screen.getByRole('button', { name: /Segundo/ }));
    expect(usage.track).toHaveBeenLastCalledWith({
      type: 'open_doc',
      position: 2,
    });
  });
});
