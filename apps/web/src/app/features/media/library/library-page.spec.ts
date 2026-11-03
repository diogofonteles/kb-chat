import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
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
  ...aMediaItem({
    id: mediaId(n),
    title: `Palestra ${n}`,
    durationMs: 900_000,
  }),
  kind: 'audio',
  lastPlayedAt: null,
  ...overrides,
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
  const view = await render(LibraryPage, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      chatStoreOn(),
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
  return { ...view, http, settle, tick, start, open, media };
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
    put.flush({ applied: [mediaId(1), mediaId(2)] });
    await tick();
    http.expectOne(FIRST).flush(aPage([anItem(3)]));
    http.expectOne(HOME).flush(aHome());
    await settle();
    expect(screen.getByRole('status').textContent).toContain(
      '2 mídias marcadas como ouvidas.',
    );
    expect(screen.queryByRole('region', { name: 'Seleção' })).toBeNull();
  });

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
