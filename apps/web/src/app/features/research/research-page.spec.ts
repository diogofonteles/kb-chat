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
import type { ResearchEvent } from '@kb-chat/contracts';
import { fireEvent, render, screen } from '@testing-library/angular';
import { ResearchApi } from '@core/api/research-api.js';
import { UsageLog } from '@core/usage/usage-log.js';
import { ChatPage } from '@features/chat/chat-page.js';
import { Subject, of } from 'rxjs';
import { aDocument, aResponse, TOPICS } from '../../testing/fixtures.js';
import { FakeConversationsServer } from '../../testing/fake-conversations.js';

const SEARCH_URL = '/api/v1/topics/hermetismo/searches';
const SOURCE = { n: 1, id: 'raw/articles/a-lei-do-ritmo.md', title: 'Ritmo' };

/** The local API's conversation history; each render starts with an empty one. */
let conversations = new FakeConversationsServer();
const fakeStart: HttpInterceptorFn = (request, next) =>
  request.url.endsWith('/suggestions')
    ? of(
        new HttpResponse({
          status: 200,
          body: { items: [{ concept: 'Cabala', count: 3 }] },
        }),
      )
    : conversations.interceptor(request, next);

async function renderPage({ configured = true } = {}) {
  localStorage.clear();
  conversations = new FakeConversationsServer();
  const streams: Subject<ResearchEvent>[] = [];
  const api = {
    research: vi.fn(() => {
      const stream = new Subject<ResearchEvent>();
      streams.push(stream);
      return stream;
    }),
    spendToday: () => of({ usd: 0, capUsd: 1, configured }),
  };
  const view = await render(ChatPage, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(withInterceptors([fakeStart])),
      provideHttpClientTesting(),
      { provide: ResearchApi, useValue: api },
      { provide: UsageLog, useValue: { track: vi.fn() } },
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  http.expectOne('/api/v1/topics').flush(TOPICS);
  await view.fixture.whenStable();
  return { ...view, http, api, streams };
}

type Page = Awaited<ReturnType<typeof renderPage>>;

async function send(page: Page, question: string, button: string) {
  fireEvent.input(screen.getByLabelText('Sua pergunta'), {
    target: { value: question },
  });
  await page.fixture.whenStable();
  fireEvent.click(screen.getByRole('button', { name: button }));
  await page.fixture.whenStable();
}

async function answer(page: Page, index: number, text: string) {
  const stream = page.streams[index] as Subject<ResearchEvent>;
  stream.next({ type: 'sources', sources: [SOURCE] });
  stream.next({ type: 'token', text });
  stream.next({
    type: 'done',
    usd: 0.001,
    billing: 'per-token',
    model: 'm',
    interrupted: false,
    steps: 2,
  });
  stream.complete();
  await page.fixture.whenStable();
}

async function switchTo(page: Page, name: string) {
  fireEvent.click(screen.getByRole('radio', { name }));
  await page.fixture.whenStable();
}

describe('ChatPage research view (KBC-008)', () => {
  it('starts in the research view: greeting, no search mode, the agent answers', async () => {
    const page = await renderPage();
    expect(
      (
        screen.getByRole('radio', {
          name: /Pesquisa com IA/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      screen.getByText('O que você quer pesquisar no acervo?'),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Como buscar')).toBeNull();
    expect(
      screen.getByLabelText('Sua pergunta').getAttribute('placeholder'),
    ).toBe('Pergunte qualquer coisa sobre o acervo…');
    await send(page, 'o que é o ritmo?', 'Perguntar');
    await answer(page, 0, 'Segundo o acervo, tudo flui [1].');
    expect(screen.getByText(/tudo flui/)).toBeTruthy();
    expect(screen.getByText('Resposta da IA pronta.')).toBeTruthy();
    // BR-6: the research view never shows search cards, and never searched.
    expect(page.container.querySelector('app-result-card')).toBeNull();
    page.http.expectNone(SEARCH_URL);
  });

  it('saves the answered research in the history, labelled as IA (FR-6)', async () => {
    const page = await renderPage();
    await send(page, 'o que é o ritmo?', 'Perguntar');
    await answer(page, 0, 'Tudo flui [1].');
    const [saved, ...others] = [...conversations.saved.values()];
    expect(others).toEqual([]);
    expect(saved).toMatchObject({
      kind: 'research',
      topic: 'hermetismo',
      turns: [{ question: 'o que é o ritmo?', answer: 'Tudo flui [1].' }],
    });
    const history = screen.getByRole('navigation', { name: 'Histórico' });
    expect(history.textContent?.replace(/\s+/g, ' ')).toContain(
      'o que é o ritmo? IA · Hermetismo',
    );
    // The research conversation on screen is the current one in the history.
    expect(
      history.querySelector('[aria-current="true"]')?.textContent,
    ).toContain('o que é o ritmo?');
  });

  it('opens the cited document in the panel (AC-3)', async () => {
    const page = await renderPage();
    await send(page, 'o que é o ritmo?', 'Perguntar');
    await answer(page, 0, 'Tudo flui [1].');
    fireEvent.click(screen.getByRole('link', { name: 'Fonte 1: Ritmo' }));
    TestBed.tick();
    page.http
      .expectOne(
        '/api/v1/topics/hermetismo/documents/raw%2Farticles%2Fa-lei-do-ritmo.md',
      )
      .flush(aDocument());
    await page.fixture.whenStable();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('keeps each view’s conversation when switching back and forth (AC-5, AC-6)', async () => {
    const page = await renderPage();
    await send(page, 'o que é o ritmo?', 'Perguntar');
    await answer(page, 0, 'Tudo flui [1].');
    await switchTo(page, 'Buscar documentos');
    expect(screen.getByLabelText('Como buscar')).toBeTruthy();
    await send(page, 'ritmo', 'Buscar');
    page.http.expectOne(SEARCH_URL).flush(aResponse());
    await page.fixture.whenStable();
    expect(page.api.research).toHaveBeenCalledOnce();
    expect(page.container.querySelector('app-result-card')).toBeTruthy();
    expect(screen.queryByText(/Tudo flui/)).toBeNull();
    await switchTo(page, 'Pesquisa com IA');
    expect(screen.getByText(/Tudo flui/)).toBeTruthy();
    await switchTo(page, 'Buscar documentos');
    expect(page.container.querySelector('app-result-card')).toBeTruthy();
    expect(localStorage.getItem('kb-chat.view')).toBe('search');
  });

  it('starts a new conversation only in the current view', async () => {
    const page = await renderPage();
    await switchTo(page, 'Buscar documentos');
    await send(page, 'ritmo', 'Buscar');
    page.http.expectOne(SEARCH_URL).flush(aResponse());
    await switchTo(page, 'Pesquisa com IA');
    await send(page, 'o que é o ritmo?', 'Perguntar');
    await answer(page, 0, 'Tudo flui [1].');
    fireEvent.click(screen.getByRole('button', { name: /Nova conversa/ }));
    await page.fixture.whenStable();
    expect(screen.queryByText(/Tudo flui/)).toBeNull();
    await switchTo(page, 'Buscar documentos');
    expect(page.container.querySelector('app-result-card')).toBeTruthy();
  });

  it('asks a start suggestion as a research question', async () => {
    const page = await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Cabala' }));
    await page.fixture.whenStable();
    expect(page.api.research).toHaveBeenCalledWith('hermetismo', {
      question: 'O que o acervo diz sobre Cabala?',
      history: [],
    });
  });

  it('moves focus to the question box after "Parar"', async () => {
    const page = await renderPage();
    await send(page, 'o que é o ritmo?', 'Perguntar');
    fireEvent.click(screen.getByRole('button', { name: 'Parar' }));
    await page.fixture.whenStable();
    expect(page.streams[0]?.observed).toBe(false);
    expect(document.activeElement).toBe(screen.getByLabelText('Sua pergunta'));
  });

  it('without a provider, opens the search view with research disabled and explained', async () => {
    await renderPage({ configured: false });
    const research = screen.getByRole('radio', {
      name: /Pesquisa com IA/,
    }) as HTMLInputElement;
    expect(research.disabled).toBe(true);
    expect(
      screen.getByText(
        'Configure um provedor de IA em ⚙ Configurações para pesquisar com IA.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('O que você quer estudar hoje?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Buscar' })).toBeTruthy();
  });
});
