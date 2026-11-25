import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import type { WebSearchResponse, WebSearchResult } from '@kb-chat/contracts';
import { ChatStore } from '@features/chat/chat-store.js';
import { fireEvent, render, screen, within } from '@testing-library/angular';
import { sessionAs } from '../../testing/media-fixtures.js';
import { WebSearchForm } from './web-search-form.js';
import { WebSearchRun } from './web-search-run.js';
import { WebSearchSection } from './web-search-section.js';

const AVAILABLE = '/api/v1/web-search/available';
const SEARCH = '/api/v1/topics/hermetismo/web-search';

const aResult = (fields: Partial<WebSearchResult> = {}): WebSearchResult => ({
  kind: 'text',
  url: 'https://www.exemplo.org/1',
  title: 'O Caibalion comentado',
  snippet: 'Um estudo dos sete princípios.',
  site: 'exemplo.org',
  author: null,
  already: null,
  ...fields,
});
const THREE: WebSearchResult[] = [
  aResult({ author: 'Hermes' }),
  aResult({
    kind: 'video',
    url: 'https://www.youtube.com/watch?v=aaaaaaaaaa1',
    title: 'Aula em vídeo',
    site: 'youtube.com',
  }),
  aResult({
    url: 'https://www.exemplo.org/3',
    title: 'Texto que já está lá',
    already: { document: { id: 'raw/tres.md', title: 'Texto três' } },
  }),
];
const aResponse = (
  fields: Partial<WebSearchResponse> = {},
): WebSearchResponse => ({
  results: THREE,
  partial: false,
  // The whole answer, unless a test goes on.
  exhausted: true,
  skipped: { already: 0, seen: 0 },
  creditsUsed: 6,
  creditsRemaining: null,
  low: false,
  ...fields,
});

interface Setup {
  readonly available?: { connected: boolean; low: boolean } | 'fails';
  readonly master?: boolean;
  readonly inputs?: {
    topic?: string;
    disabled?: boolean;
  };
}

async function open(setup: Setup = {}) {
  const chat = { open: vi.fn() };
  const view = await render(WebSearchSection, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([{ path: '**', children: [] }]),
      { provide: ChatStore, useValue: chat },
      sessionAs({
        master: setup.master ?? false,
        features: ['media', 'media-upload'],
      }),
    ],
    inputs: { topic: 'hermetismo', ...setup.inputs },
  });
  const http = TestBed.inject(HttpTestingController);
  // Not whenStable: it waits for the search on its way, whose state is what is looked at.
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve));
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve));
  };
  const available = http.expectOne(AVAILABLE);
  if (setup.available === 'fails')
    available.flush('', { status: 500, statusText: 'x' });
  else available.flush(setup.available ?? { connected: true, low: false });
  await settle();
  const run = TestBed.inject(WebSearchRun);
  return { ...view, http, settle, run, chat };
}

type Opened = Awaited<ReturnType<typeof open>>;

const subject = () => screen.getByLabelText<HTMLInputElement>('Assunto');
const sources = () =>
  screen.getByLabelText<HTMLInputElement>('Quantidade de fontes');
const authors = () =>
  screen.getByLabelText<HTMLInputElement>('Autores de referência (opcional)');
const chip = (name: string) => screen.getByRole('button', { name });
const searchButton = () => chip('Pesquisar');
const box = (name: string) =>
  screen.getByRole<HTMLInputElement>('checkbox', { name });
const type = (field: HTMLInputElement, value: string) =>
  fireEvent.input(field, { target: { value } });
const status = () =>
  screen
    .getAllByRole('status')
    .map((one) => one.textContent?.trim())
    .join(' ');

/** The addresses picked now, as the page reads them. */
const pickedNow = (opened: Opened): string[] =>
  opened.run.picksOf('hermetismo').map((one) => one.url);

/** A subject typed and "Pesquisar" pressed: the request that left. */
async function searched(opened: Opened, text = 'hermetismo') {
  type(subject(), text);
  await opened.settle();
  fireEvent.click(searchButton());
  await opened.settle();
  return opened.http.expectOne(SEARCH);
}

async function found(opened: Opened, response = aResponse()) {
  (await searched(opened)).flush(response);
  await opened.settle();
}

const refuse = (
  request: TestRequest,
  error: { status: number; code: string },
) =>
  request.flush(
    { error: { code: error.code, message: 'x' } },
    { status: error.status, statusText: 'x' },
  );

async function failed(opened: Opened, error: { status: number; code: string }) {
  refuse(await searched(opened), error);
  await opened.settle();
}

describe('WebSearchSection: the form (KBC-185)', () => {
  it('asks for a subject, 10 sources, every kind and no author, and tells masters what it takes', async () => {
    await open({ master: true });
    expect(subject().value).toBe('');
    expect(sources().value).toBe('10');
    for (const name of ['Texto', 'Áudio', 'Vídeo'])
      expect(chip(name).getAttribute('aria-pressed')).toBe('true');
    expect(
      screen.queryByRole('list', { name: 'Autores incluídos' }),
    ).toBeNull();
    expect(searchButton().getAttribute('aria-describedby')).toBe(
      'web-search-calls',
    );
    expect(screen.getByText('Cerca de 6 créditos do Firecrawl.')).toBeTruthy();
  });

  it('sends what was asked', async () => {
    const opened = await open();
    type(sources(), '4');
    fireEvent.click(chip('Áudio'));
    type(authors(), ' Manly  Hall ');
    fireEvent.keyDown(authors(), { key: 'Enter' });
    await opened.settle();
    const request = await searched(opened, '  os sete princípios ');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      query: 'os sete princípios',
      sources: 4,
      kinds: ['text', 'video'],
      authors: ['Manly Hall'],
      again: false,
    });
  });

  it('asks for at least 3 letters, with the focus on the subject, and sends nothing', async () => {
    const opened = await open();
    type(subject(), ' ab ');
    fireEvent.click(searchButton());
    await opened.settle();
    opened.http.expectNone(SEARCH);
    expect(screen.getByText('Escreva pelo menos 3 letras.')).toBeTruthy();
    expect(subject().getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(subject());
    type(subject(), 'abc');
    await opened.settle();
    expect(screen.queryByText('Escreva pelo menos 3 letras.')).toBeNull();
  });

  it.each(['0', '-3', '2.5', ''])('refuses %s sources', async (value) => {
    const opened = await open();
    type(sources(), value);
    type(subject(), 'hermetismo');
    await opened.settle();
    expect(
      screen.getByText('Use um número inteiro, a partir de 1.'),
    ).toBeTruthy();
    fireEvent.click(searchButton());
    await opened.settle();
    opened.http.expectNone(SEARCH);
    expect(document.activeElement).toBe(sources());
  });

  it('needs at least one kind', async () => {
    const opened = await open();
    for (const name of ['Texto', 'Áudio', 'Vídeo']) fireEvent.click(chip(name));
    type(subject(), 'hermetismo');
    await opened.settle();
    expect(screen.getByRole('alert').textContent).toContain(
      'Escolha pelo menos um tipo.',
    );
    expect(chip('Texto').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(searchButton());
    await opened.settle();
    opened.http.expectNone(SEARCH);
    fireEvent.click(chip('Vídeo'));
    await opened.settle();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('adds authors by Enter or "Adicionar", several at once by commas, and removes them, the focus never lost', async () => {
    const opened = await open();
    const add = async (name: string, how: 'enter' | 'button' = 'button') => {
      type(authors(), name);
      await opened.settle();
      if (how === 'enter') fireEvent.keyDown(authors(), { key: 'Enter' });
      else fireEvent.click(chip('Adicionar'));
      await opened.settle();
    };
    await add('Hermes', 'enter');
    opened.http.expectNone(SEARCH);
    expect(authors().value).toBe('');
    await add('HERMES');
    expect(screen.getByText('Este autor já está na lista.')).toBeTruthy();
    expect(authors().getAttribute('aria-invalid')).toBe('true');
    await add(' " ');
    expect(screen.getByText(/Escreva o nome do autor/)).toBeTruthy();
    // As the owner typed them on 2026-11-25: four names, not one.
    await add('Joseph Murphy, Helio Couto; Maria do Socorro, Americo Barbosa');
    expect(TestBed.inject(WebSearchForm).authors()).toEqual([
      'Hermes',
      'Joseph Murphy',
      'Helio Couto',
      'Maria do Socorro',
      'Americo Barbosa',
    ]);
    await add('Bia, hermes');
    expect(screen.getByText('Este autor já está na lista.')).toBeTruthy();
    expect(authors().value).toBe('Bia, hermes');
    await add('x'.repeat(81));
    expect(screen.getByText(/Separe os autores por vírgula/)).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Autores incluídos' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    fireEvent.click(chip('Remover Helio Couto'));
    await opened.settle();
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    expect(document.activeElement).toBe(authors());
  });

  it('searches with a name typed and not added yet', async () => {
    const opened = await open();
    type(authors(), 'Hermes');
    const request = await searched(opened);
    expect(request.request.body.authors).toEqual(['Hermes']);
    expect(chip('Remover Hermes')).toBeTruthy();
  });

  it('keeps what was asked while the app is open', async () => {
    const opened = await open();
    type(subject(), 'os sete princípios');
    type(sources(), '7');
    fireEvent.click(chip('Vídeo'));
    await opened.settle();
    const form = TestBed.inject(WebSearchForm);
    expect(form.subject()).toBe('os sete princípios');
    expect(form.sources()).toBe(7);
    expect(form.kinds()).toEqual(['text', 'audio']);
  });

  it('does nothing while the parent is busy', async () => {
    const opened = await open({ inputs: { disabled: true } });
    for (const field of [subject(), sources(), authors()])
      expect(field.disabled).toBe(true);
    expect((searchButton() as HTMLButtonElement).disabled).toBe(true);
    opened.http.expectNone(SEARCH);
  });
});

describe('WebSearchSection: what it answers', () => {
  it('shows it is searching, and makes one search for two presses', async () => {
    const opened = await open();
    type(subject(), 'hermetismo');
    await opened.settle();
    searchButton().click();
    searchButton().click();
    await opened.settle();
    const request = opened.http.expectOne(SEARCH);
    expect(status()).toContain('Procurando… 0 de 10.');
    expect(searchButton().getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(searchButton());
    await opened.settle();
    opened.http.expectNone(SEARCH);
    request.flush(aResponse());
    await opened.settle();
    expect(searchButton().getAttribute('aria-disabled')).toBeNull();
  });

  it('gives the candidates picked, but what the collection has, and says how many', async () => {
    const opened = await open();
    await found(opened);
    expect(status()).toContain('3 resultados.');
    const group = screen.getByRole('group', {
      name: 'Resultados para “hermetismo”',
    });
    const items = within(group).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    const first = items[0] as HTMLElement;
    expect(first.textContent).toContain('Texto');
    expect(first.textContent).toContain('Hermes');
    expect(first.textContent).toContain('Um estudo dos sete princípios.');
    const link = within(first).getByRole('link');
    expect(link.getAttribute('href')).toBe('https://www.exemplo.org/1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.textContent).toContain('exemplo.org');
    expect(items[1]?.textContent).toContain('Vídeo');
    expect(box('O Caibalion comentado').checked).toBe(true);
    expect(box('Aula em vídeo').checked).toBe(true);
    const there = box('Texto que já está lá');
    expect([there.checked, there.disabled]).toEqual([false, true]);
    expect(items[2]?.textContent).toContain('Já está no acervo');
    expect(
      document.getElementById(there.getAttribute('aria-describedby') ?? '')
        ?.textContent,
    ).toContain('Já está no acervo');
  });

  it('what is picked is for the page to include, in order', async () => {
    const opened = await open();
    await found(opened);
    expect(opened.run.picksOf('hermetismo')).toEqual([
      {
        url: 'https://www.exemplo.org/1',
        title: 'O Caibalion comentado',
        kind: 'text',
      },
      {
        url: 'https://www.youtube.com/watch?v=aaaaaaaaaa1',
        title: 'Aula em vídeo',
        kind: 'video',
      },
    ]);
    // Another collection's page has none of it.
    expect(opened.run.picksOf('alquimia')).toEqual([]);
  });

  it('what was included stays listed, cannot go twice, and what was left out stays out', async () => {
    const opened = await open();
    await found(opened);
    fireEvent.click(box('Aula em vídeo'));
    await opened.settle();
    opened.run.take(['https://www.exemplo.org/1']);
    await opened.settle();
    const went = box('O Caibalion comentado');
    expect([went.checked, went.disabled]).toEqual([false, true]);
    expect(screen.getByText('Incluído agora')).toBeTruthy();
    expect(box('Aula em vídeo').checked).toBe(false);
    expect(pickedNow(opened)).toEqual([]);
  });

  const one = (n: number) =>
    aResult({ url: `https://www.exemplo.org/n${n}`, title: `Texto ${n}` });
  const some = (from: number, many: number) =>
    Array.from({ length: many }, (_, at) => one(from + at));

  it('goes on until it has what was asked, showing each part as it comes', async () => {
    const opened = await open();
    type(sources(), '25');
    const going = { exhausted: false };
    const first = await searched(opened);
    expect(first.request.body.sources).toBe(10);
    first.flush(aResponse({ ...going, results: some(0, 10) }));
    await opened.settle();
    expect(status()).toContain('Procurando… 10 de 25.');
    expect(screen.getAllByRole('checkbox', { name: /^Texto/ })).toHaveLength(
      10,
    );
    const second = opened.http.expectOne(SEARCH);
    second.flush(aResponse({ ...going, results: some(10, 10) }));
    await opened.settle();
    const third = opened.http.expectOne(SEARCH);
    expect(third.request.body.sources).toBe(5);
    third.flush(aResponse({ ...going, results: some(20, 5) }));
    await opened.settle();
    opened.http.expectNone(SEARCH);
    expect(status()).toContain('25 resultados.');
    expect(pickedNow(opened)).toHaveLength(25);
  });

  it('"Buscar mais" brings as many more, keeping what is there and what was left out', async () => {
    const opened = await open();
    type(sources(), '5');
    await found(opened, aResponse({ exhausted: false, results: some(0, 5) }));
    fireEvent.click(box('Texto 0'));
    type(sources(), '7');
    await opened.settle();
    fireEvent.click(chip('Buscar mais 7'));
    await opened.settle();
    const more = opened.http.expectOne(SEARCH);
    expect(more.request.body).toMatchObject({
      query: 'hermetismo',
      sources: 7,
    });
    more.flush(aResponse({ exhausted: true, results: some(5, 3) }));
    await opened.settle();
    expect(screen.getAllByRole('checkbox', { name: /^Texto/ })).toHaveLength(8);
    expect(box('Texto 0').checked).toBe(false);
    expect(pickedNow(opened)).toHaveLength(7);
    // Nothing else is to be found: said, and not offered.
    expect(screen.getByText(/Não achei mais nada novo/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Buscar mais/ })).toBeNull();
  });

  it('can be stopped, with what came kept', async () => {
    const opened = await open();
    type(sources(), '30');
    const first = await searched(opened);
    first.flush(aResponse({ exhausted: false, results: some(0, 10) }));
    await opened.settle();
    const second = opened.http.expectOne(SEARCH);
    fireEvent.click(chip('Parar'));
    await opened.settle();
    expect(second.cancelled).toBe(true);
    expect(status()).toContain('10 resultados.');
    expect(chip('Buscar mais 30')).toBeTruthy();
    expect(document.activeElement).toBe(searchButton());
  });

  it('says what was left out, and brings it when asked', async () => {
    const opened = await open();
    await found(opened, aResponse({ skipped: { already: 4, seen: 1 } }));
    expect(
      screen.getByText(
        'Ficaram de fora: 4 que já estão no acervo e 1 que já apareceu antes.',
      ),
    ).toBeTruthy();
    fireEvent.click(
      box('Trazer também o que já apareceu antes ou já está no acervo'),
    );
    await opened.settle();
    const again = await searched(opened);
    expect(again.request.body.again).toBe(true);
    again.flush(aResponse());
    await opened.settle();
  });

  it('is not lost by leaving the page: a search is paid', async () => {
    const opened = await open();
    await found(opened);
    opened.fixture.destroy();
    expect(opened.run.of('hermetismo')?.results).toHaveLength(3);
  });

  it('picks and unpicks one, or all', async () => {
    const opened = await open();
    await found(opened);
    const all = box('Selecionar todos');
    expect([all.checked, all.indeterminate]).toEqual([true, false]);
    fireEvent.click(box('Aula em vídeo'));
    await opened.settle();
    expect([all.checked, all.indeterminate]).toEqual([false, true]);
    expect(pickedNow(opened)).toHaveLength(1);
    fireEvent.click(all);
    await opened.settle();
    expect(pickedNow(opened)).toHaveLength(2);
    fireEvent.click(all);
    await opened.settle();
    expect(box('O Caibalion comentado').checked).toBe(false);
    expect(pickedNow(opened)).toEqual([]);
  });

  it('cannot be changed while the parent is busy', async () => {
    const opened = await open();
    await found(opened);
    await opened.rerender({ inputs: { topic: 'hermetismo', disabled: true } });
    await opened.settle();
    expect(box('Aula em vídeo').disabled).toBe(true);
  });

  it('opens the document the collection already has', async () => {
    const opened = await open();
    const navigate = vi
      .spyOn(TestBed.inject(Router), 'navigateByUrl')
      .mockResolvedValue(true);
    await found(opened);
    fireEvent.click(chip('Abrir no acervo: Texto três'));
    expect(opened.chat.open).toHaveBeenCalledWith('hermetismo', {
      id: 'raw/tres.md',
      title: 'Texto três',
    });
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('does not name what is already there above the person’s level', async () => {
    const opened = await open();
    const hidden = aResult({ already: { document: null } });
    await found(opened, aResponse({ results: [hidden] }));
    expect(screen.getByText('Já está no acervo')).toBeTruthy();
    expect(screen.queryByText('Abrir no acervo')).toBeNull();
    expect(screen.queryByText('Selecionar todos')).toBeNull();
    expect(pickedNow(opened)).toEqual([]);
  });

  it('says nothing was found', async () => {
    const opened = await open();
    await found(opened, aResponse({ results: [] }));
    expect(status()).toContain('Nada encontrado para “hermetismo”.');
    expect(screen.getByText(/Tente outras palavras/)).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('says some searches did not answer, and asks again keeping what is there', async () => {
    const opened = await open();
    await found(opened, aResponse({ partial: true, exhausted: false }));
    expect(screen.getByRole('alert').textContent).toContain(
      'Algumas consultas não responderam',
    );
    expect(pickedNow(opened)).toHaveLength(2);
    fireEvent.click(chip('Tentar de novo'));
    await opened.settle();
    opened.http.expectOne(SEARCH).flush(aResponse({ results: [one(9)] }));
    await opened.settle();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(pickedNow(opened)).toHaveLength(3);
  });

  it('starts over in another collection, dropping the answer on its way', async () => {
    const opened = await open();
    const request = await searched(opened);
    await opened.rerender({ inputs: { topic: 'alquimia' } });
    await opened.settle();
    request.flush(aResponse());
    await opened.settle();
    expect(status()).not.toContain('resultados');
    expect(screen.queryByRole('group', { name: /Resultados/ })).toBeNull();
    expect(subject().value).toBe('hermetismo');
    fireEvent.click(searchButton());
    await opened.settle();
    opened.http
      .expectOne('/api/v1/topics/alquimia/web-search')
      .flush(aResponse());
  });
});

describe('WebSearchSection: credits', () => {
  it('tells masters what was used and what is left', async () => {
    const opened = await open({ master: true });
    await found(opened, aResponse({ creditsRemaining: 1_994 }));
    expect(status()).toContain('Usou 6 créditos. Restam 1.994.');
  });

  it('tells a master only what was used while the balance is not known', async () => {
    const opened = await open({ master: true });
    await found(opened, aResponse({ creditsUsed: 1 }));
    expect(status()).toContain('Usou 1 crédito.');
    expect(status()).not.toContain('Restam');
  });

  it('tells nobody else', async () => {
    const opened = await open();
    await found(opened, aResponse({ creditsRemaining: 994 }));
    expect(document.body.textContent).not.toMatch(/crédito|994/);
  });

  it('warns when few are left: a member asks a master, a master sees the balance', async () => {
    await open({ available: { connected: true, low: true } });
    expect(screen.getByText('Restam poucos créditos de pesquisa')).toBeTruthy();
    expect(screen.getByText('Avise um master.')).toBeTruthy();
    TestBed.resetTestingModule();
    document.body.innerHTML = '';
    await open({ available: { connected: true, low: true }, master: true });
    expect(
      screen
        .getByRole('link', { name: 'Ver o saldo nas Configurações' })
        .getAttribute('href'),
    ).toBe('/configuracoes/pesquisa-na-web');
  });

  it('warns after a search that leaves few', async () => {
    const opened = await open();
    await found(opened, aResponse({ low: true }));
    expect(screen.getByText('Restam poucos créditos de pesquisa')).toBeTruthy();
  });
});

describe('WebSearchSection: what stops it', () => {
  it('asks a member to ask a master when it is not connected, with no form', async () => {
    await open({ available: { connected: false, low: false } });
    expect(screen.getByRole('status').textContent).toContain(
      'Peça a um master para conectar a pesquisa na web.',
    );
    expect(screen.queryByLabelText('Assunto')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('sends a master to the settings when it is not connected', async () => {
    await open({ available: { connected: false, low: false }, master: true });
    expect(
      screen
        .getByRole('link', { name: 'Abrir Configurações' })
        .getAttribute('href'),
    ).toBe('/configuracoes/pesquisa-na-web');
  });

  it('lets one search when it is not known whether it is connected', async () => {
    await open({ available: 'fails' });
    expect(subject()).toBeTruthy();
  });

  it('says it is not connected when the key stops working, keeping the form', async () => {
    const opened = await open();
    await failed(opened, { status: 409, code: 'WEB_SEARCH_NOT_CONNECTED' });
    expect(screen.getByText('A pesquisa na web não está ligada')).toBeTruthy();
    expect(subject().value).toBe('hermetismo');
  });

  it('says the credits ended', async () => {
    const opened = await open();
    await failed(opened, { status: 402, code: 'WEB_SEARCH_NO_CREDITS' });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(
      'Os créditos da pesquisa na web acabaram',
    );
    expect(alert.textContent).toContain('Peça a um master para renovar.');
  });

  it.each([
    [429, 'RATE_LIMITED', 'Muitas pesquisas em pouco tempo'],
    [503, 'WEB_SEARCH_UNAVAILABLE', 'Não consegui falar com o Firecrawl.'],
    [500, 'INTERNAL', 'Algo deu errado do nosso lado.'],
  ])(
    'says why on %i %s, and searches the same again, the focus kept',
    async (code, name, text) => {
      const opened = await open();
      await failed(opened, { status: code, code: name });
      expect(screen.getByRole('alert').textContent).toContain(text);
      fireEvent.click(chip('Tentar de novo'));
      await opened.settle();
      const again = opened.http.expectOne(SEARCH);
      expect(again.request.body.query).toBe('hermetismo');
      expect(document.activeElement).toBe(searchButton());
      again.flush(aResponse());
      await opened.settle();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(status()).toContain('3 resultados');
    },
  );
});
