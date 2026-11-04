import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import {
  provideZonelessChangeDetection,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, provideRouter } from '@angular/router';
import {
  DEFAULT_LIBRARY_PREFERENCES,
  type Feature,
  type LibraryHome,
  type LibraryItem,
  type LibraryPage as LibraryAnswer,
  type ListeningPreferences,
} from '@kb-chat/contracts';
import { fireEvent, render, screen, within } from '@testing-library/angular';
import {
  MEDIA_ELEMENT_FACTORY,
  MediaEngine,
} from '@core/media/media-engine.js';
import { ChatStore } from '@features/chat/chat-store.js';
import { ViewStore } from '@features/chat/view-store.js';
import {
  fakeMediaElement,
  type FakeMedia,
} from '../../../testing/fake-media-element.js';
import {
  aMediaItem,
  chatStoreOn,
  mediaId,
  sessionAs,
} from '../../../testing/media-fixtures.js';
import { LibraryPage, SEARCH_DEBOUNCE_MS } from './library-page.js';

const PREFS = '/api/v1/media/preferences';
const HOME = '/api/v1/media/library/home';
const FIRST = '/api/v1/media/library?sort=recently-played';

const anItem = (
  n: number,
  overrides: Partial<LibraryItem> = {},
): LibraryItem => ({
  tracks: [],
  ...aMediaItem({
    id: mediaId(n),
    title: `Palestra ${n}`,
    durationMs: 900_000,
  }),
  kind: 'audio',
  lastPlayedAt: null,
  ...overrides,
});

/** The API's answer to a mark, heard or not. */
const marked = (ids: readonly string[], played = true) => ({
  applied: ids,
  marks: ids.map((id) => ({
    id,
    completedAt: played ? '2026-11-03T12:00:00.000Z' : null,
    positionUpdatedAt: '2026-11-03T12:00:00.000Z',
  })),
});

const aPage = (
  items: LibraryItem[],
  overrides: Partial<LibraryAnswer> = {},
): LibraryAnswer => ({
  items,
  nextCursor: null,
  total: items.length,
  totalDurationMs: items.reduce((sum, item) => sum + (item.durationMs ?? 0), 0),
  facets: {
    states: ['in-progress', 'unheard'],
    authors: [{ slug: 'mestre-laercio', name: 'Mestre Laércio', main: true }],
    otherAuthors: true,
    topics: ['hermetismo'],
  },
  ...overrides,
});

const aHome = (overrides: Partial<LibraryHome> = {}): LibraryHome => ({
  continueListening: [],
  recentlyPlayed: [],
  recentsClearedAt: null,
  ...overrides,
});

const PREFERENCES: ListeningPreferences = {
  speed: 1,
  showRemaining: true,
  skipBackSec: 15,
  skipForwardSec: 30,
  skipSilences: false,
  wordHighlight: true,
  ...DEFAULT_LIBRARY_PREFERENCES,
};

async function renderLibrary(
  options: {
    features?: Feature[];
    master?: boolean;
    acervo?: string;
  } = {},
) {
  const media: FakeMedia = fakeMediaElement();
  const chatStore = chatStoreOn();
  const chat = {
    ask: vi.fn(),
    selectTopic: vi.fn(),
  };
  const views = { select: vi.fn() };
  const view = await render(LibraryPage, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { ...chatStore, useValue: { ...chatStore.useValue, ...chat } },
      { provide: ViewStore, useValue: views },
      sessionAs({
        features: options.features ?? ['media', 'media-library'],
        master: options.master,
      }),
      { provide: MEDIA_ELEMENT_FACTORY, useValue: () => media.element },
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: {
            queryParamMap: new Map(
              options.acervo ? [['acervo', options.acervo]] : [],
            ),
          },
        },
      },
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  const settle = () => view.fixture.whenStable();
  /** Runs effects and change detection, so a resource sends its request (no waiting). */
  const tick = async () => {
    // A resource's answer lands after the current task; then effects send the next request.
    await new Promise((resolve) => setTimeout(resolve));
    TestBed.tick();
  };
  /** The account's choices and home, as the server answers. */
  const start = async (
    home: LibraryHome = aHome(),
    preferences = PREFERENCES,
  ) => {
    http.expectOne(PREFS).flush(preferences);
    http.expectOne(HOME).flush(home);
    await tick();
  };
  /** Choices, home and the first page answered, the screen settled. */
  const open = async (
    page: LibraryAnswer,
    home: LibraryHome = aHome(),
    preferences = PREFERENCES,
  ) => {
    await start(home, preferences);
    http
      .expectOne((request) => request.url.startsWith('/api/v1/media/library?'))
      .flush(page);
    await settle();
  };
  return { ...view, http, settle, tick, start, open, media, chat, views };
}

/** Longer than the search's pause, so the typed words are asked. */
const pause = () =>
  new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 50));

describe('LibraryPage (T16, KBC-051)', () => {
  it('shows skeletons first, then "Continuar ouvindo" with where to resume (AC-3)', async () => {
    const { open } = await renderLibrary();
    expect(screen.getByRole('list', { name: 'Carregando…' })).toBeTruthy();
    const playing = [
      anItem(1, {
        title: 'Mais recente',
        positionMs: 1_390_000,
        durationMs: 3_600_000,
      }),
      anItem(2, { title: 'Outra aula', positionMs: 302_000 }),
    ];
    await open(
      aPage([...playing, anItem(3)]),
      aHome({ continueListening: playing }),
    );

    const strip = screen.getByRole('region', { name: 'Continuar ouvindo' });
    const cards = within(strip).getAllByRole('listitem');
    expect(
      cards.map((card) => within(card).getByRole('link').textContent?.trim()),
    ).toEqual(['Mais recente', 'Outra aula']);
    expect(
      within(cards[0] as HTMLElement).getByText('Continuar de 23:10'),
    ).toBeTruthy();
    expect(
      within(cards[1] as HTMLElement).getByText('Continuar de 5:02'),
    ).toBeTruthy();
    expect(
      within(cards[0] as HTMLElement).getByRole('button', {
        name: 'Tocar Mais recente',
      }),
    ).toBeTruthy();
    expect(screen.getByText('3 mídias · 2 h')).toBeTruthy();
  });

  it('hides "Continuar ouvindo" when nothing is in progress', async () => {
    const { open } = await renderLibrary();
    await open(aPage([anItem(1)]));
    expect(
      screen.queryByRole('region', { name: 'Continuar ouvindo' }),
    ).toBeNull();
  });

  it('plays at once from the saved position with ▶ (AC-4)', async () => {
    const { open, media, settle } = await renderLibrary();
    const item = anItem(1, { positionMs: 1_390_000, durationMs: 3_600_000 });
    await open(aPage([item]), aHome({ continueListening: [item] }));
    const strip = screen.getByRole('region', { name: 'Continuar ouvindo' });
    fireEvent.click(
      within(strip).getByRole('button', { name: 'Tocar Palestra 1' }),
    );
    await settle();
    const engine = TestBed.inject(MediaEngine);
    expect(engine.source()?.id).toBe(item.id);
    expect(media.calls).toContain('play');
  });

  it('asks again with the pressed chip and the author, says it in aria-pressed and announces the count (AC-6, AC-14)', async () => {
    const { open, http, settle, tick } = await renderLibrary();
    await open(
      aPage([anItem(1), anItem(2, { author: null })], {
        facets: {
          states: ['in-progress', 'unheard'],
          authors: [
            { slug: 'mestre-laercio', name: 'Mestre Laércio', main: true },
          ],
          otherAuthors: true,
          topics: ['hermetismo'],
        },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Em andamento' }));
    await tick();
    http
      .expectOne('/api/v1/media/library?state=in-progress&sort=recently-played')
      .flush(aPage([anItem(1, { positionMs: 5 })]));
    await settle();
    fireEvent.change(screen.getByLabelText('Autoria'), {
      target: { value: 'mestre-laercio' },
    });
    await tick();
    http
      .expectOne(
        '/api/v1/media/library?state=in-progress&author=mestre-laercio&sort=recently-played',
      )
      .flush(
        aPage([anItem(1, { positionMs: 5 }), anItem(4, { positionMs: 5 })]),
      );
    // Saves go one after the other: the second leaves once the first is answered.
    http.expectOne({ method: 'PUT', url: PREFS }).flush(PREFERENCES);
    await tick();
    const saves = http.match(
      (request) => request.method === 'PUT' && request.url === PREFS,
    );
    expect(saves.at(-1)?.request.body).toEqual({
      libraryFilters: {
        states: ['in-progress'],
        authors: ['mestre-laercio'],
        topic: null,
      },
    });
    saves.forEach((save) => save.flush(PREFERENCES));
    await settle();
    expect(
      screen
        .getByRole('button', { name: 'Em andamento' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    const count = screen.getByText('2 mídias · 30 min');
    expect(count.getAttribute('aria-live')).toBe('polite');
  });

  it('shows no kind chips: the library is audio only for now (owner, 2026-11-03)', async () => {
    const { open } = await renderLibrary();
    await open(aPage([anItem(1)]));
    expect(screen.queryByRole('button', { name: 'Vídeo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Áudio' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Não ouvidas' })).toBeTruthy();
  });

  it('says what was searched when nothing matches, with "Limpar busca" (AC-12)', async () => {
    const { open, http, settle, tick } = await renderLibrary();
    await open(aPage([anItem(1)]));
    fireEvent.input(screen.getByLabelText('Buscar na biblioteca'), {
      target: { value: 'conselheira' },
    });
    await pause();
    await tick();
    http
      .expectOne('/api/v1/media/library?q=conselheira&sort=recently-played')
      .flush(aPage([], { total: 0, totalDurationMs: 0 }));
    await settle();
    expect(
      screen.getByText(
        "Nenhuma mídia com 'conselheira' no título ou no autor.",
      ),
    ).toBeTruthy();
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Limpar busca' })[0] as HTMLElement,
    );
    await pause();
    await tick();
    http.expectOne(FIRST).flush(aPage([anItem(1)]));
    await settle();
    expect(screen.getByRole('link', { name: 'Palestra 1' })).toBeTruthy();
  });

  it('offers "Limpar filtros" when the filters leave nothing', async () => {
    const { open } = await renderLibrary();
    await open(aPage([], { total: 0 }), aHome(), {
      ...PREFERENCES,
      libraryFilters: {
        states: ['heard'],
        authors: [],
        topic: null,
      },
    });
    expect(screen.getByText('Nenhuma mídia com estes filtros.')).toBeTruthy();
    expect(
      screen.getAllByRole('button', { name: 'Limpar filtros' }).length,
    ).toBeGreaterThan(0);
  });

  it('tells an empty library apart for who sends and who only listens', async () => {
    const empty = aPage([], {
      total: 0,
      facets: { states: [], authors: [], otherAuthors: false, topics: [] },
    });
    const reader = await renderLibrary();
    await reader.open(empty);
    expect(
      screen.getByText('Ainda não há mídias nos acervos liberados para você.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Enviar mídia' })).toBeNull();
    reader.fixture.destroy();
    TestBed.resetTestingModule();

    const sender = await renderLibrary({
      features: ['media', 'media-library', 'media-upload'],
    });
    await sender.open(empty);
    expect(
      screen.getByText('Ainda não há mídias nos seus acervos.'),
    ).toBeTruthy();
    expect(
      screen.getAllByRole('button', { name: 'Enviar mídia' }),
    ).toHaveLength(2);
  });

  it('says the library could not load and tries again', async () => {
    const { http, settle, start, tick } = await renderLibrary();
    await start();
    http.expectOne(FIRST).flush(null, { status: 500, statusText: 'x' });
    await settle();
    expect(screen.getByRole('alert').textContent).toContain(
      'Não consegui carregar a Biblioteca.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await tick();
    http.expectOne(FIRST).flush(aPage([anItem(1)]));
    http.expectOne(HOME).flush(aHome());
    await settle();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('brings what takes the focus fully into view, but never moves the page under a press (WCAG 2.4.11)', async () => {
    const { open } = await renderLibrary();
    await open(aPage([anItem(1)]));
    const link = screen.getByRole('link', { name: 'Palestra 1' });
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

  it('marks the selected media as heard and says so (AC-7)', async () => {
    const { open, http, settle, tick } = await renderLibrary();
    await open(aPage([anItem(1, { positionMs: 5_000 }), anItem(2), anItem(3)]));
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Selecionar Palestra 1' }),
    );
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Selecionar Palestra 2' }),
    );
    await settle();
    const bar = screen.getByRole('region', { name: 'Seleção' });
    expect(within(bar).getByText('2 selecionadas')).toBeTruthy();
    fireEvent.click(
      within(bar).getByRole('button', { name: 'Marcar como ouvida' }),
    );
    const put = http.expectOne('/api/v1/media/played');
    expect(put.request.body).toEqual({
      ids: [mediaId(1), mediaId(2)],
      played: true,
    });
    put.flush(marked([mediaId(1), mediaId(2)]));
    await tick();
    http.expectNone(FIRST);
    http.expectOne(HOME).flush(aHome());
    await settle();
    expect(screen.getByRole('status').textContent).toContain(
      '2 mídias marcadas como ouvidas.',
    );
    expect(screen.queryByRole('region', { name: 'Seleção' })).toBeNull();
  });

  const manyItems = (count: number) =>
    Array.from({ length: count }, (_, n) => anItem(n + 1));
  const idsFrom = (start: number, end: number) =>
    Array.from({ length: end - start + 1 }, (_, n) => mediaId(start + n));

  // These two render 250 rows, past the API's batch of 200: 1.6 s here with coverage, 7 to 9 s
  // on a CI runner beside the other test files. The limit is the runner's, no product budget.
  const BULK_TEST_MS = 20_000;

  it(
    'marks more than the API takes at once in batches of 200, from "Selecionar todas" (FR-3)',
    async () => {
      const { open, http, settle, tick } = await renderLibrary();
      await open(aPage(manyItems(250)));
      fireEvent.click(screen.getByLabelText('Selecionar todas as 250'));
      await settle();
      fireEvent.click(screen.getByText('Marcar como ouvida'));

      const first = http.expectOne('/api/v1/media/played');
      expect(first.request.body).toEqual({
        ids: idsFrom(1, 200),
        played: true,
      });
      first.flush(marked(idsFrom(1, 200)));
      const second = http.expectOne('/api/v1/media/played');
      expect(second.request.body).toEqual({
        ids: idsFrom(201, 250),
        played: true,
      });
      second.flush(marked(idsFrom(201, 250)));
      await tick();
      http.expectOne(HOME).flush(aHome());
      await settle();

      expect(
        screen.getByRole('status', { hidden: true }).textContent,
      ).toContain('250 mídias marcadas como ouvidas.');
      expect(
        screen.queryByRole('region', { name: 'Seleção', hidden: true }),
      ).toBeNull();
    },
    BULK_TEST_MS,
  );

  it(
    'says how many were marked and keeps the rest selected when a later batch fails (FR-3)',
    async () => {
      const { open, http, settle, tick } = await renderLibrary();
      await open(aPage(manyItems(250)));
      fireEvent.click(screen.getByLabelText('Selecionar todas as 250'));
      await settle();
      fireEvent.click(screen.getByText('Marcar como ouvida'));

      http.expectOne('/api/v1/media/played').flush(marked(idsFrom(1, 200)));
      http
        .expectOne('/api/v1/media/played')
        .flush(null, { status: 500, statusText: 'x' });
      await tick();
      http.expectOne(HOME).flush(aHome());
      await settle();

      const bar = screen.getByRole('region', { name: 'Seleção', hidden: true });
      expect(within(bar).getByRole('alert').textContent).toContain(
        '200 mídias marcadas como ouvidas. Faltaram 50: tente de novo.',
      );
      expect(within(bar).getByText('50 selecionadas')).toBeTruthy();
    },
    BULK_TEST_MS,
  );

  it('marks one heard media as not heard from its ⋯ (AC-8)', async () => {
    const { open, http, settle } = await renderLibrary();
    await open(aPage([anItem(1, { completedAt: '2026-11-01T00:00:00.000Z' })]));
    expect(screen.getByText('✓ Ouvida')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Mais ações para Palestra 1' }),
    );
    await settle();
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Marcar como não ouvida' }),
    );
    const put = http.expectOne('/api/v1/media/played');
    expect(put.request.body).toEqual({ ids: [mediaId(1)], played: false });
  });

  it('puts the state back and says what failed when marking fails', async () => {
    const { open, http, settle } = await renderLibrary();
    await open(aPage([anItem(1)]));
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Selecionar Palestra 1' }),
    );
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Marcar como ouvida' }));
    http
      .expectOne('/api/v1/media/played')
      .flush(null, { status: 500, statusText: 'x' });
    await settle();
    expect(screen.getByRole('alert').textContent).toContain(
      'Não consegui marcar como ouvida. Tente de novo.',
    );
    expect(
      (
        screen.getByRole('checkbox', {
          name: 'Selecionar Palestra 1',
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  it('clears the recents after an inline confirmation (AC-9)', async () => {
    const { open, http, settle, tick } = await renderLibrary();
    const played = anItem(1, { lastPlayedAt: '2026-11-01T10:00:00.000Z' });
    await open(aPage([played]), aHome({ recentlyPlayed: [played] }));
    fireEvent.click(screen.getByRole('button', { name: 'Limpar recentes' }));
    await settle();
    expect(
      screen.getByText(
        'Limpar as mídias ouvidas recentemente? Suas posições, favoritas e marcadores continuam.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Limpar' }));
    http
      .expectOne({ method: 'DELETE', url: '/api/v1/media/library/recents' })
      .flush(null);
    await tick();
    http
      .expectOne(HOME)
      .flush(aHome({ recentsClearedAt: '2026-11-03T10:00:00.000Z' }));
    await settle();
    expect(screen.getByText('Nada ouvido desde que você limpou.')).toBeTruthy();
  });

  it('switches to the grid and keeps the choice in the account (AC-10)', async () => {
    const { open, http, tick } = await renderLibrary();
    await open(aPage([anItem(1)]));
    fireEvent.click(screen.getByRole('button', { name: 'Ver em grade' }));
    await tick();
    const save = http.expectOne({ method: 'PUT', url: PREFS });
    expect(save.request.body).toEqual({ libraryView: 'grid' });
    save.flush({ ...PREFERENCES, libraryView: 'grid' });
    await tick();
    // The view is not part of the question: nothing is asked again.
    http.verify();
    expect(
      screen
        .getByRole('button', { name: 'Ver em grade' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.queryByRole('checkbox', { name: 'Selecionar Palestra 1' }),
    ).toBeNull();
    expect(screen.getByRole('link', { name: 'Palestra 1' })).toBeTruthy();
  });

  it('opens in the grid and by duration as the account says (AC-10)', async () => {
    const { http, settle, start } = await renderLibrary();
    await start(aHome(), {
      ...PREFERENCES,
      librarySort: 'duration',
      libraryView: 'grid',
    });
    http
      .expectOne('/api/v1/media/library?sort=duration')
      .flush(aPage([anItem(1)]));
    await settle();
    expect(
      screen.getByRole('button', { name: 'Ordenar: Duração' }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'Ver em grade' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('starts filtered by the collection it came from (/midia, FR-7)', async () => {
    const { http, settle, start } = await renderLibrary({ acervo: 'alquimia' });
    await start();
    http
      .expectOne('/api/v1/media/library?topic=alquimia&sort=recently-played')
      .flush(aPage([anItem(1, { topic: 'alquimia' })]));
    await settle();
    expect(screen.getByRole('link', { name: 'Palestra 1' })).toBeTruthy();
  });

  it('loads the next page with "Mostrar mais"', async () => {
    const { open, http, settle } = await renderLibrary();
    await open(aPage([anItem(1)], { nextCursor: '50', total: 2 }));
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar mais' }));
    http
      .expectOne('/api/v1/media/library?sort=recently-played&cursor=50')
      .flush(aPage([anItem(2)], { total: 2 }));
    await settle();
    expect(screen.getByRole('link', { name: 'Palestra 2' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mostrar mais' })).toBeNull();
  });

  it('cancels the next page on its way when a chip changes the list (NG-22)', async () => {
    const { open, http, settle, tick } = await renderLibrary();
    await open(aPage([anItem(1)], { nextCursor: '50', total: 2 }));
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar mais' }));
    await tick();
    const stale = http.expectOne(
      '/api/v1/media/library?sort=recently-played&cursor=50',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Em andamento' }));
    await tick();

    expect(stale.cancelled).toBe(true);
    http
      .expectOne('/api/v1/media/library?state=in-progress&sort=recently-played')
      .flush(aPage([anItem(7)], { nextCursor: null, total: 1 }));
    await settle();
    expect(screen.getByRole('link', { name: 'Palestra 7' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Palestra 2' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mostrar mais' })).toBeNull();
  });

  it('asks again and drops the next page on its way when a state filter may take rows away (NG-22)', async () => {
    const { open, http, settle, tick } = await renderLibrary();
    const url = '/api/v1/media/library?state=unheard&sort=recently-played';
    await open(
      aPage([anItem(1), anItem(3)], { nextCursor: '50', total: 3 }),
      aHome(),
      {
        ...PREFERENCES,
        libraryFilters: { states: ['unheard'], authors: [], topic: null },
      },
    );
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Selecionar Palestra 1' }),
    );
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar mais' }));
    await tick();
    const stale = http.expectOne(`${url}&cursor=50`);
    fireEvent.click(screen.getByRole('button', { name: 'Marcar como ouvida' }));
    http.expectOne('/api/v1/media/played').flush(marked([mediaId(1)]));
    await tick();
    http.expectOne(url).flush(aPage([anItem(3)], { total: 1 }));
    http.expectOne(HOME).flush(aHome());
    await settle();

    expect(stale.cancelled).toBe(true);
    expect(screen.queryByRole('link', { name: 'Palestra 1' })).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Todas', level: 3 }),
    );
  });

  it('keeps a row of a later page in place when marked from its ⋯, list and cursor included (AC-14)', async () => {
    const { open, http, settle, tick } = await renderLibrary();
    await open(aPage([anItem(1)], { nextCursor: '50', total: 3 }));
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar mais' }));
    await tick();
    http
      .expectOne('/api/v1/media/library?sort=recently-played&cursor=50')
      .flush(aPage([anItem(2)], { nextCursor: '100', total: 3 }));
    await settle();
    const menu = screen.getByRole('button', {
      name: 'Mais ações para Palestra 2',
    });
    fireEvent.click(menu);
    await settle();
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Marcar como ouvida' }),
    );
    http.expectOne('/api/v1/media/played').flush(marked([mediaId(2)]));
    await tick();
    http.expectOne(HOME).flush(aHome());
    http.expectNone(FIRST);
    await settle();

    expect(screen.getByRole('link', { name: 'Palestra 1' })).toBeTruthy();
    const row = screen
      .getByRole('link', { name: 'Palestra 2' })
      .closest('app-library-row') as HTMLElement;
    expect(within(row).getByText('✓ Ouvida')).toBeTruthy();
    expect(row.contains(document.activeElement)).toBe(true);
    expect(screen.getByRole('button', { name: 'Mostrar mais' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain(
      '1 mídia marcada como ouvida.',
    );
  });

  it('says nothing changed when no media could be marked, and asks for the list again', async () => {
    const { open, http, settle, tick } = await renderLibrary();
    await open(aPage([anItem(1)]));
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Selecionar Palestra 1' }),
    );
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Marcar como ouvida' }));
    http.expectOne('/api/v1/media/played').flush(marked([]));
    await tick();
    http.expectOne(FIRST).flush(aPage([]));
    http.expectOne(HOME).flush(aHome());
    await settle();
    expect(screen.getByRole('status').textContent).toContain(
      'Nada mudou: estas mídias não estão mais disponíveis.',
    );
  });

  it('says so when the next page fails, and "Mostrar mais" tries again', async () => {
    const { open, http, settle, tick } = await renderLibrary();
    await open(aPage([anItem(1)], { nextCursor: '50', total: 2 }));
    const url = '/api/v1/media/library?sort=recently-played&cursor=50';
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar mais' }));
    await tick();
    http.expectOne(url).flush(null, { status: 500, statusText: 'x' });
    await settle();
    expect(screen.getByRole('alert')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Mostrar mais' }));
    await tick();
    http.expectOne(url).flush(aPage([anItem(2)], { total: 2 }));
    await settle();
    expect(screen.getByRole('link', { name: 'Palestra 2' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  describe('focus after a button leaves with its action (AC-14, WCAG 2.4.3)', () => {
    const allHeading = () =>
      screen.getByRole('heading', { name: 'Todas', level: 3 });

    it('goes to the search box after "Limpar busca"', async () => {
      const { open, settle } = await renderLibrary();
      await open(aPage([anItem(1)]));
      fireEvent.input(screen.getByLabelText('Buscar na biblioteca'), {
        target: { value: 'conselheira' },
      });
      await settle();
      const clear = screen.getByRole('button', { name: 'Limpar busca' });
      clear.focus();
      fireEvent.click(clear);
      await settle();
      expect(document.activeElement).toBe(
        screen.getByLabelText('Buscar na biblioteca'),
      );
    });

    it('goes to "Todas" after "Limpar filtros"', async () => {
      const { open, http, settle, tick } = await renderLibrary();
      await open(aPage([], { total: 0 }), aHome(), {
        ...PREFERENCES,
        libraryFilters: { states: ['heard'], authors: [], topic: null },
      });
      const clear = screen.getAllByRole('button', {
        name: 'Limpar filtros',
      })[0] as HTMLElement;
      clear.focus();
      fireEvent.click(clear);
      await tick();
      http.expectOne(FIRST).flush(aPage([anItem(1)]));
      await settle();
      expect(document.activeElement).toBe(allHeading());
    });

    it('moves through "Limpar recentes": into the confirmation, back, and to the section', async () => {
      const { open, http, settle } = await renderLibrary();
      const played = anItem(1, { lastPlayedAt: '2026-11-01T10:00:00.000Z' });
      await open(aPage([played]), aHome({ recentlyPlayed: [played] }));

      fireEvent.click(screen.getByRole('button', { name: 'Limpar recentes' }));
      await settle();
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Cancelar' }),
      );

      fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
      await settle();
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Limpar recentes' }),
      );

      fireEvent.click(screen.getByRole('button', { name: 'Limpar recentes' }));
      await settle();
      fireEvent.click(screen.getByRole('button', { name: 'Limpar' }));
      await settle();
      http
        .expectOne({ method: 'DELETE', url: '/api/v1/media/library/recents' })
        .flush(null);
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Ouvidas recentemente' }),
      );
    });

    it('goes to "Selecionar todas" after "Cancelar seleção"', async () => {
      const { open, settle } = await renderLibrary();
      await open(aPage([anItem(1), anItem(2)]));
      fireEvent.click(
        screen.getByRole('checkbox', { name: 'Selecionar Palestra 1' }),
      );
      await settle();
      fireEvent.click(screen.getByRole('button', { name: 'Cancelar seleção' }));
      await settle();
      expect(document.activeElement).toBe(
        screen.getByRole('checkbox', { name: 'Selecionar todas as 2' }),
      );
    });

    it('goes to "Todas" after "Marcar como ouvida"', async () => {
      const { open, http, settle, tick } = await renderLibrary();
      await open(aPage([anItem(1), anItem(2)]));
      fireEvent.click(
        screen.getByRole('checkbox', { name: 'Selecionar Palestra 1' }),
      );
      await settle();
      fireEvent.click(
        screen.getByRole('button', { name: 'Marcar como ouvida' }),
      );
      http.expectOne('/api/v1/media/played').flush(marked([mediaId(1)]));
      await tick();
      http.expectOne(HOME).flush(aHome());
      await settle();
      expect(document.activeElement).toBe(allHeading());
    });
  });

  describe('"Buscar na fala" (AC-12, FR-6)', () => {
    const noResult = async (
      options: Parameters<typeof renderLibrary>[0] = {},
      preferences = PREFERENCES,
    ) => {
      const library = await renderLibrary(options);
      await library.open(aPage([anItem(1)]), aHome(), preferences);
      fireEvent.input(screen.getByLabelText('Buscar na biblioteca'), {
        target: { value: ' conselheira ' },
      });
      await pause();
      await library.tick();
      library.http
        .expectOne(
          (request) =>
            request.url.startsWith('/api/v1/media/library?') &&
            request.url.includes('q=conselheira'),
        )
        .flush(aPage([], { total: 0, totalDurationMs: 0 }));
      await library.settle();
      return library;
    };

    it('opens the media search with the word, only in what was said', async () => {
      const { chat, views, settle } = await noResult({
        features: ['search', 'media', 'media-library'],
      });

      fireEvent.click(screen.getByRole('button', { name: 'Buscar na fala' }));
      await settle();

      expect(views.select).toHaveBeenCalledWith('search');
      expect(chat.ask).toHaveBeenCalledWith('conselheira', {
        kinds: ['audio'],
      });
      expect(TestBed.inject(Router).url).toBe('/');
    });

    it('searches the collection of the Acervo filter when one is on', async () => {
      const { chat } = await noResult(
        { features: ['search', 'media', 'media-library'] },
        {
          ...PREFERENCES,
          libraryFilters: { states: [], authors: [], topic: 'alquimia' },
        },
      );

      fireEvent.click(screen.getByRole('button', { name: 'Buscar na fala' }));

      expect(chat.selectTopic).toHaveBeenCalledWith('alquimia');
    });

    it('is not offered to who cannot search', async () => {
      await noResult({ features: ['media', 'media-library'] });
      expect(
        screen.queryByRole('button', { name: 'Buscar na fala' }),
      ).toBeNull();
    });
  });

  describe('a collection the person lost (BR-7, AC-5)', () => {
    it('leaves a saved filter aside, shows all the rest and keeps it in the account', async () => {
      const { http, settle, start } = await renderLibrary();
      await start(aHome(), {
        ...PREFERENCES,
        libraryFilters: { states: [], authors: [], topic: 'perdido' },
      });
      http.expectOne(FIRST).flush(aPage([anItem(1)]));
      await settle();

      expect(screen.getByRole('link', { name: 'Palestra 1' })).toBeTruthy();
      expect(
        screen.queryByRole('button', { name: 'Limpar filtros' }),
      ).toBeNull();
      http.expectNone(PREFS);
    });

    it('keeps it in the account when a chip, the order or "Limpar filtros" write', async () => {
      const { http, settle, start, tick } = await renderLibrary();
      await start(aHome(), {
        ...PREFERENCES,
        libraryFilters: { states: [], authors: [], topic: 'perdido' },
      });
      http.expectOne(FIRST).flush(aPage([anItem(1)]));
      await settle();

      fireEvent.click(screen.getByRole('button', { name: 'Em andamento' }));
      await tick();
      const chipSave = http.expectOne({ method: 'PUT', url: PREFS });
      expect(chipSave.request.body).toEqual({
        libraryFilters: {
          states: ['in-progress'],
          authors: [],
          topic: 'perdido',
        },
      });
      chipSave.flush(PREFERENCES);
      http
        .expectOne(
          '/api/v1/media/library?state=in-progress&sort=recently-played',
        )
        .flush(aPage([anItem(1)]));
      await settle();

      fireEvent.click(screen.getByRole('button', { name: 'Ver em grade' }));
      http.expectOne({ method: 'PUT', url: PREFS }).flush(PREFERENCES);
      await settle();
      fireEvent.click(
        screen.getAllByRole('button', {
          name: 'Limpar filtros',
        })[0] as HTMLElement,
      );
      await tick();
      expect(
        http.expectOne({ method: 'PUT', url: PREFS }).request.body,
      ).toEqual({
        libraryFilters: { states: [], authors: [], topic: 'perdido' },
      });
    });

    it('leaves aside a collection arrived with in the address', async () => {
      const { http, settle, start } = await renderLibrary({
        acervo: 'perdido',
      });
      await start();
      http.expectOne(FIRST).flush(aPage([anItem(1)]));
      await settle();
      expect(screen.getByRole('link', { name: 'Palestra 1' })).toBeTruthy();
    });

    it('waits for the collections before judging a saved filter', async () => {
      const { http, tick, start } = await renderLibrary();
      const chat = TestBed.inject(ChatStore);
      const known = chat.topicsKnown as WritableSignal<boolean>;
      known.set(false);
      await start();
      await tick();
      http.expectNone(FIRST);

      known.set(true);
      await tick();
      http.expectOne(FIRST).flush(aPage([anItem(1)]));
    });
  });

  it('says so when the choice cannot reach the account (AC-10)', async () => {
    const { open, http, settle } = await renderLibrary();
    await open(aPage([anItem(1)]));
    fireEvent.click(screen.getByRole('button', { name: 'Ver em grade' }));
    http
      .expectOne({ method: 'PUT', url: PREFS })
      .flush(null, { status: 500, statusText: 'x' });
    await settle();
    expect(screen.getByRole('alert').textContent).toContain(
      'Não consegui guardar esta escolha na sua conta.',
    );
  });

  it('shows a media still converting with its status and no ▶ (AC-13)', async () => {
    const { open } = await renderLibrary();
    await open(
      aPage([
        anItem(1, { status: 'processing', progress: 40, durationMs: null }),
      ]),
    );
    expect(screen.getByText('Convertendo… 40%')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Tocar Palestra 1' }),
    ).toBeNull();
    expect(screen.queryByRole('link', { name: 'Palestra 1' })).toBeNull();
  });

  it('lets a master remove a media after confirming', async () => {
    const { open, http, settle, tick } = await renderLibrary({ master: true });
    await open(aPage([anItem(1)]));
    fireEvent.click(
      screen.getByRole('button', { name: 'Mais ações para Palestra 1' }),
    );
    await settle();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remover' }));
    await settle();
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Remover',
      }),
    );
    http
      .expectOne({ method: 'DELETE', url: `/api/v1/media/${mediaId(1)}` })
      .flush(null);
    await tick();
    http.expectOne(FIRST).flush(aPage([]));
    http.expectOne(HOME).flush(aHome());
    await settle();
    expect(screen.getByRole('status').textContent).toContain(
      'Palestra 1 foi removido.',
    );
  });
});

describe('LibraryPage: "Editar informações" (KBC-050)', () => {
  const edit = async (item: LibraryItem, settle: () => Promise<unknown>) => {
    fireEvent.click(
      screen.getByRole('button', { name: `Mais ações para ${item.title}` }),
    );
    await settle();
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Editar informações' }),
    );
    await settle();
  };

  it('is offered only for what the person may edit', async () => {
    const { open, settle } = await renderLibrary();
    await open(aPage([anItem(1)]));
    fireEvent.click(
      screen.getByRole('button', { name: 'Mais ações para Palestra 1' }),
    );
    await settle();
    expect(
      screen.queryByRole('menuitem', { name: 'Editar informações' }),
    ).toBeNull();
  });

  it('a new title changes the row in place, without asking for the list again', async () => {
    const { open, http, settle, tick } = await renderLibrary();
    const item = { ...anItem(1), canEdit: true };
    await open(aPage([item]));
    await edit(item, settle);
    fireEvent.input(screen.getByLabelText('Título'), {
      target: { value: 'Novo título' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    http
      .expectOne(`/api/v1/media/${mediaId(1)}`)
      .flush({ ...item, title: 'Novo título' });
    await tick();
    http.expectOne(HOME).flush(aHome());
    await settle();
    http.expectNone(FIRST);
    expect(screen.getByRole('link', { name: 'Novo título' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain(
      'Informações salvas',
    );
  });

  it('AC-2: a move asks again, says where it went and links the collection', async () => {
    const { open, http, settle, tick } = await renderLibrary();
    const item = { ...anItem(1), canEdit: true, author: null };
    await open(aPage([item]));
    await edit(item, settle);
    fireEvent.change(screen.getByLabelText('Acervo'), {
      target: { value: 'alquimia' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    http
      .expectOne(`/api/v1/media/${mediaId(1)}`)
      .flush({ ...item, topic: 'alquimia' });
    await tick();
    http.expectOne(FIRST).flush(aPage([{ ...item, topic: 'alquimia' }]));
    http.expectOne(HOME).flush(aHome());
    await settle();
    expect(screen.getByRole('status').textContent).toContain(
      'Palestra 1 foi movido para o acervo Alquimia.',
    );
    const link = screen.getByRole<HTMLAnchorElement>('link', {
      name: 'Ver o acervo',
    });
    expect(link.getAttribute('href')).toBe('/biblioteca?acervo=alquimia');
  });

  it('a new author asks again too', async () => {
    const { open, http, settle, tick } = await renderLibrary();
    const item = { ...anItem(1), canEdit: true };
    await open(aPage([item]));
    await edit(item, settle);
    fireEvent.input(screen.getByLabelText('Autor'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    http
      .expectOne(`/api/v1/media/${mediaId(1)}`)
      .flush({ ...item, author: null });
    await tick();
    http.expectOne(FIRST).flush(aPage([{ ...item, author: null }]));
    http.expectOne(HOME).flush(aHome());
    await settle();
    expect(screen.getByRole('status').textContent).toContain(
      'Informações salvas',
    );
  });
});
