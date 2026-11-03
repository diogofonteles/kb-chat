import AxeBuilder from '@axe-core/playwright';
import type { Browser, Page, Route } from '@playwright/test';
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

test('NFR-2: 2 000 media scroll to the end, and a chip updates the list within 500 ms (INP ≤ 200 ms)', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { page } = await libraryListener(browser);
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
  await page.addInitScript(() => {
    const longest = { value: 0 };
    Object.assign(window, { longestInteraction: longest });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // Event Timing: an entry with an interaction id is one of the person's inputs.
        const timing = entry as PerformanceEntry & { interactionId?: number };
        if (timing.interactionId)
          longest.value = Math.max(longest.value, timing.duration);
      }
    }).observe({
      type: 'event',
      buffered: true,
      durationThreshold: 16,
    } as PerformanceObserverInit);
  });
  await openLibrary(page);
  await expect(all(page).getByText(/^2000 mídias/)).toBeVisible();

  const scroller = page.locator('app-library-page');
  const more = all(page).getByRole('button', { name: 'Mostrar mais' });
  const rows = all(page).getByRole('listitem');
  // Scrolling near the end loads the next page by itself (40 pages of 50).
  for (let round = 0; round < 45 && (await more.count()) > 0; round++) {
    const before = await rows.count();
    await scroller.evaluate((element) =>
      element.scrollTo(0, element.scrollHeight),
    );
    await expect.poll(() => rows.count()).toBeGreaterThan(before);
  }
  await expect(more).toHaveCount(0);
  await expect(rows).toHaveCount(MANY);
  await expect(
    all(page).getByRole('link', { name: 'Palestra sintética 1999' }),
  ).toBeAttached();

  await scroller.evaluate((element) => element.scrollTo(0, 0));
  const chip = all(page).getByRole('button', { name: 'Em andamento' });
  const started = Date.now();
  await chip.click();
  await expect(all(page).getByText(/^667 mídias/)).toBeVisible();
  expect(Date.now() - started).toBeLessThanOrEqual(500);

  const inp = await page.evaluate(
    () =>
      (window as unknown as { longestInteraction: { value: number } })
        .longestInteraction.value,
  );
  expect(inp).toBeLessThanOrEqual(200);
  await page.context().close();
});
