import AxeBuilder from '@axe-core/playwright';
import type { Browser, Locator, Page, Route } from '@playwright/test';
import {
  CSRF,
  expect,
  invite,
  ownerApi,
  pageAs,
  pageWith,
  test,
  uniqueEmail,
} from './fixtures.js';
import {
  audioState,
  uniqueTag,
  uploadReady,
  useTheme,
  type UploadedMedia,
} from './media-helpers.js';

/** KBC-051 (screens.md T16): the media library home. */

const LIBRARY = ['search', 'media', 'media-library'];
const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;
const viewportOf = () => test.info().project.use.viewport ?? null;

/** A new person with the library on hermetismo: their positions are theirs alone. */
async function libraryListener(
  browser: Browser,
  features: readonly string[] = LIBRARY,
): Promise<{ page: Page; email: string }> {
  const email = uniqueEmail('biblioteca');
  const owner = await ownerApi();
  await invite(owner, email, { topics: ['hermetismo'], features });
  await owner.dispose();
  return { page: await pageAs(browser, email, viewportOf()), email };
}

/** "Biblioteca" in the sidebar, or in the phone's menu. */
async function openLibrary(page: Page) {
  await page.goto('/');
  if (!desktop(page))
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('link', { name: 'Biblioteca' }).click();
  await expect(
    page.getByRole('heading', { name: 'Biblioteca', level: 2 }),
  ).toBeVisible();
}

/** "Todas" narrowed to this test's media by the search (other tests upload too). */
async function searchFor(page: Page, words: string) {
  // Wait for the answer to the search: a new question clears the selection.
  const answered = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === '/api/v1/media/library' &&
      url.searchParams.get('q') === words.trim()
    );
  });
  await page.getByLabel('Buscar na biblioteca').fill(words);
  await answered;
}

const all = (page: Page) => page.getByRole('region', { name: 'Todas' });
const libraryStatus = (page: Page) =>
  page.locator('app-library-page').getByRole('status');
const strip = (page: Page) =>
  page.getByRole('region', { name: 'Continuar ouvindo' });
const mini = (page: Page) => page.getByRole('region', { name: 'Mini-player' });

/** The person's player saved this position (as the player does while playing). */
async function savePosition(page: Page, media: UploadedMedia, ms: number) {
  const saved = await page.request.put(`/api/v1/media/${media.id}/progress`, {
    data: { positionMs: ms, basedOn: null },
    headers: CSRF,
  });
  expect(saved.status(), await saved.text()).toBe(200);
}

const seriousViolations = async (page: Page) =>
  (await new AxeBuilder({ page }).analyze()).violations.filter((violation) =>
    ['serious', 'critical'].includes(violation.impact ?? ''),
  );

let tag: string;
let lectures: UploadedMedia[];

test.beforeAll(async () => {
  tag = uniqueTag();
  const owner = await ownerApi();
  lectures = [];
  for (const n of [1, 2, 3, 4])
    lectures.push(
      await uploadReady(owner, {
        title: `Biblioteca ${tag} aula ${n}`,
        seconds: 20,
      }),
    );
  await owner.dispose();
});

const lecture = (n: number): UploadedMedia => {
  const found = lectures[n - 1];
  if (!found) throw new Error(`no lecture ${n}`);
  return found;
};

test('AC-1: with the library, the sidebar shows Biblioteca and /midia leads to it', async ({
  browser,
}) => {
  const { page } = await libraryListener(browser);
  await openLibrary(page);
  await expect(page).toHaveURL(/\/biblioteca/);
  if (!desktop(page))
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Mídia' })).toHaveCount(0);
  await page.goto('/midia');
  await expect(page).toHaveURL(/\/biblioteca\?acervo=hermetismo$/);
  await expect(
    page.getByRole('heading', { name: 'Biblioteca', level: 2 }),
  ).toBeVisible();
  await page.context().close();
});

test('AC-2: with only "Ouvir mídia", the person keeps Mídia and the library is refused', async ({
  browser,
}) => {
  const { page } = await libraryListener(browser, ['search', 'media']);
  await page.goto('/');
  if (!desktop(page))
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Mídia' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Biblioteca' })).toHaveCount(0);
  await page.goto('/biblioteca');
  await expect(page).toHaveURL(/\/$/);
  expect((await page.request.get('/api/v1/media/library')).status()).toBe(403);
  await page.context().close();
});

test('AC-3, AC-4: "Continuar ouvindo" lists the latest first, and ▶ resumes at once in the mini-player', async ({
  browser,
}) => {
  const { page } = await libraryListener(browser);
  await savePosition(page, lecture(1), 4_000);
  await savePosition(page, lecture(2), 8_000);
  await savePosition(page, lecture(3), 12_000);
  await savePosition(page, lecture(4), 19_900); // 95%: heard, not to continue
  await openLibrary(page);
  const cards = strip(page).getByRole('listitem');
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText(lecture(3).title);
  await expect(cards.nth(0)).toContainText('Continuar de 0:12');
  await expect(cards.nth(1)).toContainText(lecture(2).title);
  await expect(cards.nth(2)).toContainText(lecture(1).title);
  await expect(strip(page)).not.toContainText(lecture(4).title);

  await cards
    .nth(0)
    .getByRole('button', { name: `Tocar ${lecture(3).title}` })
    .click();
  await expect(mini(page)).toBeVisible();
  await expect.poll(async () => (await audioState(page)).paused).toBe(false);
  // The saved position is applied once the media's length is known (±1 s, AC-4).
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeGreaterThanOrEqual(11);
  expect((await audioState(page)).currentTime).toBeLessThanOrEqual(14);
  await page.context().close();
});

test('AC-6, AC-12: chips and search narrow "Todas" and say how many', async ({
  browser,
}) => {
  const { page } = await libraryListener(browser);
  await savePosition(page, lecture(1), 4_000);
  await savePosition(page, lecture(2), 6_000);
  await openLibrary(page);
  await searchFor(page, tag);
  await expect(all(page).getByText(/^4 mídias/)).toBeVisible();
  // Audio only for now (owner, 2026-11-03): no kind chips.
  await expect(all(page).getByRole('button', { name: 'Vídeo' })).toHaveCount(0);
  const inProgress = all(page).getByRole('button', { name: 'Em andamento' });
  await inProgress.click();
  await expect(inProgress).toHaveAttribute('aria-pressed', 'true');
  await expect(all(page).getByText(/^2 mídias/)).toBeVisible();
  await expect(
    all(page).getByRole('link', { name: lecture(3).title }),
  ).toHaveCount(0);
  await inProgress.click();

  await searchFor(page, `conselheira ${tag}`);
  await expect(
    all(page).getByText(
      `Nenhuma mídia com 'conselheira ${tag}' no título ou no autor.`,
    ),
  ).toBeVisible();
  await all(page).getByRole('button', { name: 'Limpar busca' }).click();
  await expect(page.getByLabel('Buscar na biblioteca')).toHaveValue('');
  await expect(page.getByLabel('Buscar na biblioteca')).toBeFocused();
  await page.context().close();
});

test('AC-12: "Buscar na fala" opens the search with the word, only in what was said', async ({
  browser,
}) => {
  const { page } = await libraryListener(browser);
  await openLibrary(page);
  const words = `conselheira ${tag}`;
  await searchFor(page, words);
  const searched = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && request.url().endsWith('/searches'),
  );
  await all(page).getByRole('button', { name: 'Buscar na fala' }).click();

  const body = (await searched).postDataJSON() as {
    q: string;
    kinds: string[];
  };
  expect(body).toMatchObject({ q: words, kinds: ['audio'] });
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('main').getByText(words).first()).toBeVisible();
  if (desktop(page))
    await expect(page.getByLabel('Sua pergunta')).toBeFocused();
  await page.context().close();
});

test('AC-7, AC-8: two selected media are marked heard, then one goes back to not heard', async ({
  browser,
}) => {
  const { page } = await libraryListener(browser);
  await savePosition(page, lecture(1), 5_000);
  await openLibrary(page);
  await expect(strip(page).getByRole('listitem')).toHaveCount(1);
  await searchFor(page, tag);
  await expect(all(page).getByText(/^4 mídias/)).toBeVisible();
  await all(page)
    .getByRole('checkbox', { name: `Selecionar ${lecture(1).title}` })
    .check();
  await all(page)
    .getByRole('checkbox', { name: `Selecionar ${lecture(2).title}` })
    .check();
  const bar = page.getByRole('region', { name: 'Seleção' });
  await expect(bar).toContainText('2 selecionadas');
  await bar.getByRole('button', { name: 'Marcar como ouvida' }).click();
  await expect(
    page.locator('app-library-page').getByRole('status'),
  ).toContainText('2 mídias marcadas como ouvidas.');
  await expect(strip(page)).toHaveCount(0);
  const first = all(page)
    .getByRole('listitem')
    .filter({ hasText: lecture(1).title });
  await expect(first).toContainText('✓ Ouvida');

  // Heard: the player offers no "Continuar de".
  await page.goto(`/midia/${lecture(1).id}`);
  await expect(
    page.getByRole('heading', { name: lecture(1).title }),
  ).toBeVisible();
  await expect(page.getByText(/Continuar de/)).toHaveCount(0);

  await page.goto('/biblioteca');
  await searchFor(page, tag);
  await all(page)
    .getByRole('button', { name: `Mais ações para ${lecture(1).title}` })
    .click();
  await page.getByRole('menuitem', { name: 'Marcar como não ouvida' }).click();
  await expect(first).not.toContainText('Ouvida');
  const item = (await (
    await page.request.get(`/api/v1/media/${lecture(1).id}`)
  ).json()) as { positionMs: number; completedAt: string | null };
  expect(item).toMatchObject({ positionMs: 0, completedAt: null });
  await page.context().close();
});

test('FR-3: a press on the selection bar acts, also with the page short of its end', async ({
  browser,
}) => {
  const { page } = await libraryListener(browser);
  await openLibrary(page);
  await searchFor(page, tag);
  await expect(all(page).getByText(/^4 mídias/)).toBeVisible();
  await all(page)
    .getByRole('checkbox', { name: `Selecionar ${lecture(3).title}` })
    .check();
  await all(page)
    .getByRole('checkbox', { name: `Selecionar ${lecture(4).title}` })
    .check();
  // The page can still scroll, so a scroll on the press would take the bar from the pointer.
  await page.setViewportSize({
    width: viewportOf()?.width ?? 1440,
    height: 500,
  });
  await page
    .locator('app-library-page')
    .evaluate((element) =>
      element.scrollTo(0, element.scrollHeight - element.clientHeight - 60),
    );
  const box = await page
    .getByRole('region', { name: 'Seleção' })
    .getByRole('button', { name: 'Marcar como ouvida' })
    .boundingBox();
  if (!box) throw new Error('no button on the selection bar');
  // A person's press lasts a few frames: the release lands where the press did.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(resolve)),
  );
  await page.mouse.up();
  await expect(libraryStatus(page)).toContainText(
    '2 mídias marcadas como ouvidas.',
  );
  await page.context().close();
});

test('MA-01: a press anywhere on a row opens the media, its controls keep their own', async ({
  browser,
}) => {
  const { page } = await libraryListener(browser);
  await savePosition(page, lecture(3), 4_000); // the row draws its position bar
  await openLibrary(page);
  await searchFor(page, tag);
  await expect(all(page).getByText(/^4 mídias/)).toBeVisible();
  const row = all(page)
    .getByRole('listitem')
    .filter({ hasText: lecture(3).title });
  const selection = page.getByRole('region', { name: 'Seleção' });
  await row.getByRole('checkbox').check();
  await expect(selection).toBeVisible();
  await row.getByRole('checkbox').uncheck();
  await expect(selection).toBeHidden();
  await expect(page).toHaveURL(/\/biblioteca/);

  await row
    .getByRole('button', { name: `Mais ações para ${lecture(3).title}` })
    .click();
  const menuItem = page.getByRole('menuitem', { name: 'Marcar como ouvida' });
  await expect(menuItem).toBeVisible();
  await expect(page).toHaveURL(/\/biblioteca/);
  await page.keyboard.press('Escape');
  await expect(menuItem).toBeHidden();

  // Aimed through the link, relative to it: the row may still move, and Playwright checks
  // the target at the moment of the press. What the row draws over it is no target.
  const link = row.getByRole('link', { name: lecture(3).title });
  const [area, meta] = await Promise.all([
    link.boundingBox(),
    row.getByText('Hermetismo').boundingBox(),
  ]);
  if (!area || !meta) throw new Error('no row to press');
  for (const position of [
    { x: meta.x - area.x + 4, y: meta.y - area.y + meta.height / 2 },
    { x: area.width / 2, y: 4 },
    { x: area.width / 2, y: area.height - 1 }, // on the position bar
  ]) {
    await link.click({ position });
    await expect(page).toHaveURL(new RegExp(`/midia/${lecture(3).id}`));
    await page.goBack();
    await searchFor(page, tag);
    await expect(all(page).getByText(/^4 mídias/)).toBeVisible();
  }

  await row.getByRole('button', { name: `Tocar ${lecture(3).title}` }).click();
  await expect(mini(page)).toBeVisible();
  await expect(page).toHaveURL(/\/biblioteca/);
  await page.context().close();
});

test('MA-01: a row keeps its size when it takes the focus', async ({
  browser,
}) => {
  const { page } = await libraryListener(browser);
  await openLibrary(page);
  await searchFor(page, tag);
  await expect(all(page).getByText(/^4 mídias/)).toBeVisible();
  const row = all(page)
    .getByRole('listitem')
    .filter({ hasText: lecture(3).title });
  const before = await row.boundingBox();
  await row.getByRole('link', { name: lecture(3).title }).focus();
  // The row laying out anew under a press moved the page and lost the click on WebKit.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  expect((await row.boundingBox())?.height).toBe(before?.height);
  await page.context().close();
});

test('AC-9: "Limpar recentes" empties the recents and keeps "Continuar ouvindo"', async ({
  browser,
}) => {
  const { page } = await libraryListener(browser);
  for (const n of [1, 2, 3, 4]) await savePosition(page, lecture(n), 3_000);
  await openLibrary(page);
  const recents = page.getByRole('region', { name: 'Ouvidas recentemente' });
  await expect(recents.getByRole('listitem')).toHaveCount(4);
  await recents.getByRole('button', { name: 'Limpar recentes' }).click();
  await expect(recents).toContainText(
    'Limpar as mídias ouvidas recentemente? Suas posições, favoritas e marcadores continuam.',
  );
  await recents.getByRole('button', { name: 'Limpar', exact: true }).click();
  await expect(recents).toContainText('Nada ouvido desde que você limpou.');
  await expect(
    recents.getByRole('button', { name: 'Ouvidas recentemente' }),
  ).toBeFocused();
  await expect(strip(page).getByRole('listitem')).toHaveCount(4);
  await page.context().close();
});

test('AC-10: the order and the grid follow the account to another browser', async ({
  browser,
}) => {
  const { page, email } = await libraryListener(browser);
  await openLibrary(page);
  await searchFor(page, tag);
  await page
    .getByRole('button', { name: 'Ordenar: Ouvidas recentemente' })
    .click();
  await page.getByRole('menuitemradio', { name: /Duração/ }).click();
  await page.getByRole('button', { name: 'Ver em grade' }).click();
  await expect(
    page.getByRole('button', { name: 'Ver em grade' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(
      async () =>
        (
          (await (
            await page.request.get('/api/v1/media/preferences')
          ).json()) as {
            libraryView: string;
          }
        ).libraryView,
    )
    .toBe('grid');

  const other = await pageWith(browser, email, { viewport: viewportOf() });
  await openLibrary(other);
  await expect(
    other.getByRole('button', { name: 'Ordenar: Duração' }),
  ).toBeVisible();
  await expect(
    other.getByRole('button', { name: 'Ver em grade' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await other.context().close();
  await page.context().close();
});

test('AC-14: chips, order, selection and opening work by keyboard, and the count is announced', async ({
  browser,
}) => {
  const { page } = await libraryListener(browser);
  await savePosition(page, lecture(2), 6_000);
  await openLibrary(page);
  await searchFor(page, tag);
  const count = all(page).locator('[aria-live="polite"]');
  await expect(count).toHaveText(/^4 mídias/);

  const chip = all(page).getByRole('button', { name: 'Em andamento' });
  await chip.focus();
  await page.keyboard.press('Enter');
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect(count).toHaveText(/^1 mídia\b/);
  await page.keyboard.press('Space');
  await expect(count).toHaveText(/^4 mídias/);

  await page
    .getByRole('button', { name: 'Ordenar: Ouvidas recentemente' })
    .focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('button', { name: 'Ordenar: Adicionadas recentemente' }),
  ).toBeFocused();

  const box = all(page).getByRole('checkbox', {
    name: `Selecionar ${lecture(3).title}`,
  });
  await box.focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('region', { name: 'Seleção' })).toContainText(
    '1 selecionada',
  );
  await page.getByRole('button', { name: 'Cancelar seleção' }).focus();
  await page.keyboard.press('Enter');
  await expect(
    all(page).getByRole('checkbox', { name: /^Selecionar todas/ }),
  ).toBeFocused();

  await box.focus();
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Marcar como ouvida' }).focus();
  await page.keyboard.press('Enter');
  await expect(libraryStatus(page)).toContainText(
    '1 mídia marcada como ouvida.',
  );
  await expect(
    page.getByRole('heading', { name: 'Todas', level: 3 }),
  ).toBeFocused();

  await all(page)
    .getByRole('link', { name: lecture(3).title })
    .focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: lecture(3).title }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: '← Biblioteca' })).toBeVisible();
  await page.context().close();
});

for (const theme of ['light', 'dark', 'esoteric'] as const) {
  test(`AC-14: the library passes axe in the ${theme} theme, in list and grid`, async ({
    browser,
  }) => {
    const { page } = await libraryListener(browser);
    await savePosition(page, lecture(1), 5_000);
    await savePosition(page, lecture(2), 19_900);
    await useTheme(page, theme);
    await openLibrary(page);
    await expect(strip(page).getByRole('listitem')).toHaveCount(1);
    await searchFor(page, tag);
    await expect(all(page).getByText(/^4 mídias/)).toBeVisible();
    await all(page)
      .getByRole('checkbox', { name: `Selecionar ${lecture(3).title}` })
      .check();
    expect(await seriousViolations(page)).toEqual([]);
    await page.getByRole('button', { name: 'Ver em grade' }).click();
    await expect(all(page).getByRole('checkbox')).toHaveCount(0);
    expect(await seriousViolations(page)).toEqual([]);
    await page.context().close();
  });
}

/* ---------- NFR-2: 2 000 media, served by an intercepted API ---------- */

const MANY = 2_000;

/** A synthetic library item (the contract's shape); every third one in progress. */
function synthetic(n: number) {
  const inProgress = n % 3 === 0;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    topic: 'hermetismo',
    title: `Palestra sintética ${String(n).padStart(4, '0')}`,
    author: null,
    status: 'ready',
    progress: null,
    failure: null,
    durationMs: 3_600_000,
    bytes: 1,
    createdAt: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(),
    canRetry: false,
    canEdit: false,
    positionMs: inProgress ? 60_000 : 0,
    completedAt: null,
    positionUpdatedAt: inProgress ? '2026-11-01T10:00:00.000Z' : null,
    transcription: {
      status: 'none',
      confidence: null,
      version: null,
      transcriber: 'none',
      transcriberOffSince: null,
    },
    kind: 'audio',
    lastPlayedAt: null,
  };
}

const SYNTHETIC = Array.from({ length: MANY }, (_, n) => synthetic(n));

async function serveMany(route: Route) {
  const url = new URL(route.request().url());
  const state = url.searchParams.get('state');
  const items =
    state === 'in-progress'
      ? SYNTHETIC.filter((item) => item.positionMs > 0)
      : SYNTHETIC;
  const start = Number(url.searchParams.get('cursor') ?? 0);
  const end = start + 50;
  await route.fulfill({
    json: {
      items: items.slice(start, end),
      nextCursor: end < items.length ? String(end) : null,
      total: items.length,
      totalDurationMs: items.length * 3_600_000,
      facets: {
        states: ['in-progress', 'unheard'],
        authors: [],
        otherAuthors: true,
        topics: ['hermetismo'],
      },
    },
  });
}

/** Every library answer comes from here; what the home shows does not matter. */
async function serveManyMedia(page: Page) {
  await page.route('**/api/v1/media/library?**', serveMany);
  await page.route('**/api/v1/media/library/home', (route) =>
    route.fulfill({
      json: {
        continueListening: [],
        recentlyPlayed: [],
        recentsClearedAt: null,
      },
    }),
  );
}

/** Scrolling near the end loads the next page by itself: `pages` pages of 50. */
async function scrollToTheEnd(page: Page, pages: number) {
  const scroller = page.locator('app-library-page');
  const more = all(page).getByRole('button', { name: 'Mostrar mais' });
  const rows = all(page).getByRole('listitem');
  for (let round = 0; round < pages && (await more.count()) > 0; round++) {
    const before = await rows.count();
    await scroller.evaluate((element) =>
      element.scrollTo(0, element.scrollHeight),
    );
    await expect.poll(() => rows.count()).toBeGreaterThan(before);
  }
}

test('FR-3: "Selecionar todas" marks more than the API takes at once, in batches', async ({
  browser,
}) => {
  const { page } = await libraryListener(browser);
  await serveManyMedia(page);
  const batches: number[] = [];
  await page.route('**/api/v1/media/played', async (route) => {
    const { ids } = route.request().postDataJSON() as { ids: string[] };
    batches.push(ids.length);
    const at = '2026-11-03T12:00:00.000Z';
    await route.fulfill({
      json: {
        applied: ids,
        marks: ids.map((id) => ({
          id,
          completedAt: at,
          positionUpdatedAt: at,
        })),
      },
    });
  });
  await openLibrary(page);
  await expect(all(page).getByText(/^2000 mídias/)).toBeVisible();
  await scrollToTheEnd(page, 5);
  const loaded = await all(page).getByRole('listitem').count();
  expect(loaded).toBeGreaterThan(200);
  await all(page)
    .getByRole('checkbox', { name: `Selecionar todas as ${loaded}` })
    .check();
  await page.getByRole('button', { name: 'Marcar como ouvida' }).click();
  await expect(libraryStatus(page)).toContainText(
    `${loaded} mídias marcadas como ouvidas.`,
  );
  expect(batches).toEqual([200, loaded - 200]);
  await page.context().close();
});

/** Window fields of the probe below, as the page sees them. */
interface ListProbe {
  lastInputAt: number;
  latencies: number[];
  frameGaps: number[];
  recording: boolean;
}

/**
 * Times the page itself, the same way in every browser: WebKit has no Event Timing, so INP
 * cannot be read there. From the input to the first task after the next frame, which is
 * what INP measures, less the time the input waited to be handled. A background of frames shows whether scrolling stalls.
 */
function installListProbe() {
  const probe: ListProbe = {
    lastInputAt: 0,
    latencies: [],
    frameGaps: [],
    recording: false,
  };
  Object.assign(window, { listProbe: probe });
  addEventListener(
    'click',
    () => {
      // Not event.timeStamp: under WebKit's automation it has another origin.
      const startedAt = performance.now();
      probe.lastInputAt = startedAt;
      requestAnimationFrame(() => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          probe.latencies.push(performance.now() - startedAt);
          channel.port1.close();
        };
        channel.port2.postMessage(null);
      });
    },
    true,
  );
  let last = 0;
  const onFrame = (now: number) => {
    if (probe.recording && last > 0) probe.frameGaps.push(now - last);
    last = now;
    requestAnimationFrame(onFrame);
  };
  requestAnimationFrame(onFrame);
}

const probeOf = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { listProbe: ListProbe }).listProbe,
  );

/** The middle value: one stall of the shared machine does not decide the measure. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Infinity;
}

/** The p95 of a run of samples. */
function p95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Infinity;
}

/** From the last click to the moment the count reads `text`, timed inside the page. */
async function clickUntilCount(page: Page, chip: Locator, text: string) {
  const changed = all(page)
    .locator('[aria-live="polite"]')
    .evaluate(
      (count, expected) =>
        new Promise<number>((resolve) => {
          const observer = new MutationObserver(() => {
            if (!count.textContent?.trim().startsWith(expected)) return;
            observer.disconnect();
            const { listProbe } = window as unknown as {
              listProbe: ListProbe;
            };
            resolve(performance.now() - listProbe.lastInputAt);
          });
          observer.observe(count, {
            childList: true,
            subtree: true,
            characterData: true,
          });
        }),
      text,
    );
  await chip.click();
  return changed;
}

/**
 * Real presses of the mouse, one answered before the next. Through the locator each press
 * would first resolve the role and the name over all 2 000 rows, on the thread being timed.
 */
async function pressOften(page: Page, target: Locator, presses: number) {
  const box = await target.boundingBox();
  if (!box) throw new Error('nothing to press');
  for (let turn = 0; turn < presses; turn++) {
    const { latencies } = await probeOf(page);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect
      .poll(async () => (await probeOf(page)).latencies.length)
      .toBeGreaterThan(latencies.length);
  }
}

test('NFR-2: 2 000 media scroll by wheel without stalling, react within 200 ms, and a chip updates the list within 500 ms', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(240_000);
  const { page } = await libraryListener(browser);
  await serveManyMedia(page);
  await page.addInitScript(installListProbe);
  await openLibrary(page);
  await expect(all(page).getByText(/^2000 mídias/)).toBeVisible();

  const rows = all(page).getByRole('listitem');
  await scrollToTheEnd(page, 45);
  await expect(rows).toHaveCount(MANY);
  await expect(
    all(page).getByRole('link', { name: 'Palestra sintética 1999' }),
  ).toBeAttached();

  // A real wheel over the 2 000 rows, watched frame by frame.
  const scroller = page.locator('app-library-page');
  await scroller.evaluate((element) => element.scrollTo(0, 0));
  await rows.first().hover();
  await page.evaluate(() => {
    (window as unknown as { listProbe: ListProbe }).listProbe.recording = true;
  });
  for (let turn = 0; turn < 30; turn++) {
    await page.mouse.wheel(0, 900);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(resolve)),
    );
  }
  await page.evaluate(() => {
    (window as unknown as { listProbe: ListProbe }).listProbe.recording = false;
  });
  expect(
    await scroller.evaluate((element) => element.scrollTop),
  ).toBeGreaterThan(10_000);

  // Deep in the list, what is pressed is what was aimed at, and its ⋯ menu shows whole.
  const deepBox = all(page).getByRole('checkbox', {
    name: 'Selecionar Palestra sintética 1200',
  });
  await deepBox.click();
  await expect(deepBox).toBeChecked();
  await expect(page.getByRole('region', { name: 'Seleção' })).toContainText(
    '1 selecionada',
  );
  await deepBox.uncheck();
  const deepMenu = all(page).getByRole('button', {
    name: 'Mais ações para Palestra sintética 1200',
  });
  await deepMenu.click();
  const heard = page.getByRole('menuitem', { name: 'Marcar como ouvida' });
  await expect(heard).toBeInViewport({ ratio: 1 });
  // Containment would clip it: the option itself answers at its own center.
  expect(
    await heard.evaluate((option) => {
      const { x, y, width, height } = option.getBoundingClientRect();
      return (
        document
          .elementFromPoint(x + width / 2, y + height / 2)
          ?.closest('[role="menuitem"]') === option
      );
    }),
  ).toBe(true);
  await page.keyboard.press('Escape');
  await expect(deepMenu).toBeFocused();

  // A real input on the 2 000 rows: all of them answer to the selection.
  await scroller.evaluate((element) => element.scrollTo(0, 0));
  const box = all(page).getByRole('checkbox', {
    name: 'Selecionar Palestra sintética 0000',
  });
  await pressOften(page, box, 7);
  const { latencies, frameGaps } = await probeOf(page);
  await box.uncheck();

  const chip = all(page).getByRole('button', { name: 'Em andamento' });
  const toUpdate = await clickUntilCount(page, chip, '667 mídias');

  console.info(
    `NFR-2 ${test.info().project.name}: input median ${median(latencies).toFixed(0)} ms, worst ${Math.max(...latencies).toFixed(0)} ms; ` +
      `frame p95 ${p95(frameGaps).toFixed(0)} ms, worst ${Math.max(...frameGaps).toFixed(0)} ms (${frameGaps.length} frames); chip ${toUpdate.toFixed(0)} ms`,
  );
  expect(latencies.length).toBeGreaterThanOrEqual(7);
  expect(Math.min(...latencies)).toBeGreaterThan(0);
  expect(median(latencies)).toBeLessThanOrEqual(200);
  expect(frameGaps.length).toBeGreaterThanOrEqual(20);
  // Linux WebKit paints in software: on a CI runner a static page of 300 paragraphs has the
  // same gaps as this list, so there the number says nothing about it and is only reported.
  if (!(process.env['CI'] && browserName === 'webkit'))
    expect(p95(frameGaps)).toBeLessThanOrEqual(100);
  expect(toUpdate).toBeLessThanOrEqual(500);
  await page.context().close();
});
