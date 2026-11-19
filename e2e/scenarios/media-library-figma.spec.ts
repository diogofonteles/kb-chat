import { readFileSync, writeFileSync } from 'node:fs';
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import {
  CSRF,
  WEB_ORIGIN,
  expect,
  fakeGoogle,
  signIn,
  test,
} from '../specs/fixtures.js';
import { makeMp3 } from '../specs/media-helpers.js';
import { longPressToSelect } from '../specs/v2-media-helpers.js';
import {
  EMPTY,
  HELENA_COUNT,
  HELENA_NAME,
  OWNER,
  RECORDING,
  TITLES,
  TOPIC,
  TOPIC_TITLE,
  TRACKS,
  figmaWorld,
  recentCollections,
  seedWorld,
  type World,
} from './figma-library-world.js';

/**
 * The states of the v2 · Mídia — Biblioteca e lista frames (media-library-*, media-upload-*,
 * media-list-*), at 1440×900 and 390×844, on the frames' own sample data
 * (figma-library-world.ts): the capture recipe of the Figma inventory check
 * (figma-recreation/tools/inventory/check.sh). It only reaches each state and saves it:
 * the behaviour is proven by e2e/specs/media-library-fidelity.spec.ts.
 *
 * In every frame "Entrevista sobre a Tábua de Esmeralda" plays at 0:22 (⏸, its bookmark
 * filled): each context starts it on its page and moves through the app (the router, not a
 * reload) so it keeps playing, and the clock is put back on 0:22 just before each shot.
 * Needs a fresh E2E server (the seed refuses a used one). `KBC_FIDELITY_SHOTS=<dir>` saves
 * `<state-id>[@mobile].png`.
 */

const shots = process.env['KBC_FIDELITY_SHOTS'];
const DESKTOP = { width: 1440, height: 900 } as const;
const PHONE = { width: 390, height: 844 } as const;
type Width = 'desktop' | 'phone';
const WIDTHS: readonly Width[] = ['desktop', 'phone'];
/** Where the interview is in every frame. */
const AT_SECONDS = 22;

test.describe.configure({ timeout: 300_000 });

/** The app's one media element (the engine's hidden `<audio data-media-engine>`). */
const MEDIA = '[data-media-engine]';

async function contextAt(
  browser: Browser,
  width: Width,
  email = OWNER,
): Promise<{ context: BrowserContext; page: Page }> {
  const phone = width === 'phone';
  const context = await browser.newContext({
    baseURL: WEB_ORIGIN,
    viewport: phone ? PHONE : DESKTOP,
    deviceScaleFactor: 1,
    hasTouch: phone,
    isMobile: phone,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  });
  await figmaWorld(context, world, { queue: email === OWNER });
  await recentCollections(context, world, email);
  const page = await context.newPage();
  await fakeGoogle(page);
  await signIn(page.request, email);
  return { context, page };
}

/** An in-app navigation (the router hears popstate): what plays keeps playing. */
async function go(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    history.pushState(history.state, '', to);
    dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  }, path);
  await page.waitForURL((url) => `${url.pathname}${url.search}` === path);
}

/** The interview plays from where it stopped (0:22), from its own page. */
async function playInterview(page: Page, world: World): Promise<void> {
  await page.goto(`/midia/${world.byCode['ES']}`);
  const play = page
    .locator('app-media-player, app-media-player-page, main')
    .getByRole('button', { name: 'Tocar', exact: true })
    .first();
  await play.click();
  await expect
    .poll(() =>
      page.evaluate(
        (selector) =>
          document.querySelector<HTMLMediaElement>(selector)?.paused === false,
        MEDIA,
      ),
    )
    .toBe(true);
}

/** Back on 0:22, still playing: the shot is taken within that second. */
async function holdAt(page: Page): Promise<void> {
  await page.evaluate(
    ([selector, at]) => {
      const media = document.querySelector<HTMLMediaElement>(selector);
      if (media && !media.paused) media.currentTime = at + 0.05;
    },
    [MEDIA, AT_SECONDS] as const,
  );
  await page.waitForTimeout(150);
}

async function shoot(page: Page, id: string, width: Width): Promise<void> {
  if (!shots) return;
  await page.addStyleTag({
    content:
      '*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}',
  });
  for (let i = 0; i < 2; i += 1) {
    await page.evaluate(() =>
      document.querySelectorAll('*').forEach((node) => {
        if (node.scrollTop > 0) node.scrollTop = 0;
      }),
    );
    await page.waitForTimeout(300);
  }
  await page.mouse.move(1, 1);
  await holdAt(page);
  await page.screenshot({
    path: `${shots}/${id}${width === 'phone' ? '@mobile' : ''}.png`,
  });
}

const rows = (page: Page) => page.locator('app-library-row');
const rowNamed = (page: Page, title: string) =>
  rows(page).filter({ hasText: title });
const filtersOf = (page: Page) => page.getByRole('group', { name: 'Filtros' });

/** The library as the frames have it: every collection, recent plays first, as a list. */
async function openLibrary(page: Page, world: World): Promise<void> {
  const reset = await page.request.put('/api/v1/media/preferences', {
    headers: { 'x-requested-with': 'kb-chat' },
    data: {
      librarySort: 'recently-played',
      libraryView: 'list',
      libraryFilters: {
        states: [],
        authors: [],
        topic: null,
        allTopics: true,
        subject: null,
      },
    },
  });
  expect(reset.status(), await reset.text()).toBe(200);
  await playInterview(page, world);
  await go(page, '/biblioteca');
  await expect(rows(page).first()).toBeVisible();
}

/** "Tocando agora" beside the list (desktop): the media-library and -grid frames. */
async function nowPlaying(page: Page, open: boolean): Promise<void> {
  const panel = page.getByRole('complementary', { name: 'Tocando agora' });
  if ((await panel.isVisible()) === open) return;
  await page
    .getByRole('button', { name: 'Tocando agora', exact: true })
    .click();
  await expect(panel).toBeVisible({ visible: open });
}

async function sortMenu(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: /^Ordenar:/ }).click();
  const menu = page.getByRole('menu', { name: 'Ordenar e ver como' });
  await expect(menu).toBeVisible();
  return menu;
}

let world: World;
test.beforeAll(async () => {
  test.setTimeout(300_000);
  world = await seedWorld();
});

test('the library: list, sort, grid, "Em andamento", authorship', async ({
  browser,
}) => {
  for (const width of WIDTHS) {
    const phone = width === 'phone';
    const { context, page } = await contextAt(browser, width);
    await openLibrary(page, world);
    if (!phone) await nowPlaying(page, true);
    await shoot(page, 'media-library', width);
    if (!phone) await nowPlaying(page, false);

    let menu = await sortMenu(page);
    await shoot(page, 'media-library-sort', width);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    if (phone)
      await page.getByRole('button', { name: 'Ver como grade' }).click();
    else {
      menu = await sortMenu(page);
      await menu.getByRole('menuitemradio', { name: 'Grade' }).click();
    }
    await expect(
      page.locator('app-library-card:not(.tile)').first(),
    ).toBeVisible();
    if (!phone) await nowPlaying(page, true);
    await shoot(page, 'media-library-grid', width);
    if (!phone) await nowPlaying(page, false);
    if (phone)
      await page.getByRole('button', { name: 'Ver como lista' }).click();
    else {
      menu = await sortMenu(page);
      await menu.getByRole('menuitemradio', { name: 'Lista' }).click();
    }
    await expect(rows(page).first()).toBeVisible();

    await filtersOf(page).getByRole('button', { name: 'Em andamento' }).click();
    await expect(rows(page)).toHaveCount(3);
    await shoot(page, 'media-library-chip', width);
    await filtersOf(page)
      .getByRole('button', { name: 'Todas', exact: true })
      .click();
    await expect(rows(page)).toHaveCount(TITLES.length);

    await filtersOf(page).getByRole('button', { name: 'Autoria' }).click();
    const authors = page.getByRole('menu', { name: 'Autoria' });
    await authors
      .getByRole('menuitemradio', { name: new RegExp(HELENA_NAME) })
      .click();
    await expect(rows(page)).toHaveCount(HELENA_COUNT);
    await shoot(page, 'media-library-author', width);
    await filtersOf(page)
      .getByRole('button', { name: /Tirar o filtro de autoria/ })
      .click();
    await expect(rows(page)).toHaveCount(TITLES.length);
    await context.close();
  }
});

test('the ⋯ of a row, the selection and the dialogs', async ({ browser }) => {
  const second = TITLES[1] ?? '';
  for (const width of WIDTHS) {
    const phone = width === 'phone';
    const { context, page } = await contextAt(browser, width);
    await openLibrary(page, world);
    const row = rowNamed(page, second);
    const more = row.getByRole('button', { name: `Mais ações para ${second}` });
    await row.hover();
    await more.click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await shoot(page, 'media-library-row-menu', width);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    const box = (title: string) =>
      rowNamed(page, title).getByRole('checkbox', {
        name: `Selecionar ${title}`,
      });
    if (phone) await longPressToSelect(page, row, box(second));
    else {
      await row.hover();
      await box(second).check();
    }
    await box(TITLES[2] ?? '').check();
    const bar = page.getByRole('region', { name: 'Seleção' });
    await expect(bar).toContainText('2 selecionadas');
    await shoot(page, 'media-library-selection', width);
    await bar.getByRole('button', { name: 'Cancelar seleção' }).click();
    await expect(bar).toHaveCount(0);

    await row.hover();
    await more.click();
    await page.getByRole('menuitem', { name: 'Editar informações' }).click();
    const edit = page.getByRole('dialog', { name: /Editar/ });
    const title = edit.getByRole('textbox', { name: 'Título' });
    await expect(title).toHaveValue(second);
    await shoot(page, 'media-library-edit', width);
    await title.fill('');
    await expect(edit.getByText('Dê um título ao áudio.')).toBeVisible();
    await edit.getByRole('combobox', { name: 'Acervo' }).selectOption(EMPTY);
    await expect(
      edit.getByText(/^Posições, marcadores e transcrição vão junto/),
    ).toBeVisible();
    await shoot(page, 'media-library-edit-errors', width);
    await edit.getByRole('button', { name: 'Cancelar' }).click();
    await expect(edit).toHaveCount(0);

    await row.hover();
    await more.click();
    await page.getByRole('menuitem', { name: 'Remover' }).click();
    const remove = page.getByRole('dialog', { name: `Remover "${second}"?` });
    await expect(remove).toBeVisible();
    await shoot(page, 'media-library-remove', width);
    await remove.getByRole('button', { name: 'Cancelar' }).click();
    await expect(remove).toHaveCount(0);
    await context.close();
  }
});

test('the search, with and without results, and a collection with nothing', async ({
  browser,
}) => {
  for (const width of WIDTHS) {
    const phone = width === 'phone';
    const { context, page } = await contextAt(browser, width);
    await openLibrary(page, world);
    await page
      .getByRole('button', {
        name: phone ? 'Abrir a busca' : 'Ir para a busca',
      })
      .click();
    const search = page.getByLabel('Buscar na biblioteca');
    await expect(search).toBeFocused();
    await search.fill('vegetal');
    await expect(
      page.getByRole('heading', { name: /resultados? para “vegetal”/ }),
    ).toBeVisible();
    await shoot(page, 'media-library-search', width);
    await search.fill('xilofone');
    await expect(
      page.getByText('Nada encontrado para “xilofone”'),
    ).toBeVisible();
    await shoot(page, 'media-library-search-empty', width);
    await page.getByRole('button', { name: 'Limpar busca' }).last().click();
    await expect(rows(page).first()).toBeVisible();

    // The library reads ?acervo= as it opens: out to the interview's page and back.
    await go(page, `/midia/${world.byCode['ES']}`);
    await go(page, `/biblioteca?acervo=${EMPTY}`);
    await expect(page.getByText('Nenhuma mídia neste acervo')).toBeVisible();
    await shoot(page, 'media-library-collection-empty', width);
    await context.close();
  }
});

test('a recording opens its tracks, and removing it names them', async ({
  browser,
}) => {
  for (const width of WIDTHS) {
    const { context, page } = await contextAt(browser, width);
    await openLibrary(page, world);
    const more = page.getByRole('button', {
      name: `Mais ações para ${RECORDING}`,
    });
    const recording = more.locator('xpath=ancestor::app-library-row[1]');
    const toggle = page.getByRole('button', { name: '3 faixas' });
    await toggle.scrollIntoViewIfNeeded();
    await toggle.click();
    const tracks = page.getByRole('list', { name: `Faixas de ${RECORDING}` });
    await expect(tracks.getByRole('listitem')).toHaveCount(TRACKS.length);
    await shoot(page, 'media-library-tracks', width);

    // The removal frame draws the recording closed, the page's sections back above the list.
    await toggle.click();
    await expect(tracks).toBeHidden();
    await recording.hover();
    await more.click();
    await page.getByRole('menuitem', { name: 'Remover' }).click();
    const remove = page.getByRole('dialog', {
      name: `Remover "${RECORDING}"?`,
    });
    await remove.getByRole('button', { name: 'Remover' }).click();
    await expect(remove.getByRole('alert')).toContainText(
      `Também remove 3 faixas: ${TRACKS.map((one) => one.title).join(', ')}`,
    );
    await shoot(page, 'media-library-remove-tracks', width);
    await remove.getByRole('button', { name: 'Cancelar' }).click();
    await expect(remove).toHaveCount(0);
    await context.close();
  }
});

test('"Enviar mídia": empty, chosen, repeated, not audio, sending', async ({
  browser,
}) => {
  // The frames' file: "Palestra sobre o mercúrio dos sábios.mp3", 0,3 MB (25 s at 96 kb/s).
  const lecture = {
    name: 'Palestra sobre o mercúrio dos sábios.mp3',
    mimeType: 'audio/mpeg',
    buffer: readFileSync(makeMp3('figma-mercurio', 25)),
  };
  for (const width of WIDTHS) {
    const { context, page } = await contextAt(browser, width);
    await openLibrary(page, world);
    await page.getByRole('button', { name: 'Enviar mídia' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Enviar áudio' });
    await expect(
      dialog
        .getByText(/mp3, m4a, wav, flac, ogg ou opus/)
        .and(page.locator(':visible')),
    ).toBeVisible();
    await shoot(page, 'media-upload', width);
    const input = dialog.locator('input[type="file"]');
    const takeOut = () =>
      dialog
        .getByRole('button', { name: /^Tirar/ })
        .first()
        .click();

    await input.setInputFiles(lecture);
    await expect(dialog.getByRole('textbox', { name: 'Título' })).toBeVisible();
    await shoot(page, 'media-upload-chosen', width);
    await takeOut();

    await input.setInputFiles({
      name: 'Conversa sobre os sete princípios.mp3',
      mimeType: 'audio/mpeg',
      buffer: readFileSync(world.repeated),
    });
    await dialog.getByRole('combobox', { name: 'Acervo' }).selectOption(TOPIC);
    await expect(dialog.getByText('Já está no acervo:')).toBeVisible();
    await shoot(page, 'media-upload-duplicate', width);
    await takeOut();

    await input.setInputFiles({
      name: 'apostila.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4'),
    });
    await expect(
      dialog.getByRole('alert').filter({ hasText: 'não é um áudio aceito' }),
    ).toBeVisible();
    await shoot(page, 'media-upload-bad-type', width);
    await takeOut();

    // Held at 0 %: the file's parts wait on the network.
    await page.route('**/api/v1/media/*/upload', (route) =>
      route.request().method() === 'PATCH' ? undefined : route.continue(),
    );
    await input.setInputFiles(lecture);
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /\/api\/v1\/topics\/[^/]+\/media$/.test(
          new URL(response.url()).pathname,
        ),
    );
    await dialog.getByRole('button', { name: 'Enviar', exact: true }).click();
    const { id } = (await (await created).json()) as { id: string };
    await expect(dialog.getByText(/Enviando/).first()).toBeVisible();
    await shoot(page, 'media-upload-sending', width);
    // The frames after this one have no such upload: the held one goes away.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    expect(
      (
        await page.request.delete(`/api/v1/media/${id}`, { headers: CSRF })
      ).status(),
    ).toBe(204);
    await context.close();
  }
});

test('an empty library, for who reads and for who sends', async ({
  browser,
}) => {
  for (const width of WIDTHS)
    for (const [email, id, title] of [
      [
        world.emptyReader,
        'media-library-empty-reader',
        'Ainda não há mídias para você',
      ],
      [
        world.emptyUploader,
        'media-library-empty-uploader',
        'Comece enviando um áudio',
      ],
    ] as const) {
      const { context, page } = await contextAt(browser, width, email);
      await page.goto('/biblioteca');
      await expect(page.getByText(title, { exact: true })).toBeVisible();
      await shoot(page, id, width);
      await context.close();
    }
});

test('/midia, the collection as an album for who has no library', async ({
  browser,
}) => {
  const rita = TITLES[3] ?? '';
  for (const width of WIDTHS) {
    const phone = width === 'phone';
    const { context, page } = await contextAt(browser, width, world.lister);
    await playInterview(page, world);
    await go(page, '/midia');
    await expect(page.getByRole('link', { name: rita })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: `Acervo — ${TOPIC_TITLE}` }),
    ).toBeAttached();
    await shoot(page, 'media-list', width);

    const more = page.getByRole('button', { name: `Mais ações para ${rita}` });
    await more.click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await shoot(page, 'media-list-menu', width);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    if (phone)
      await page.getByRole('button', { name: 'Filtrar por título' }).click();
    const filter = page.getByRole('searchbox', { name: 'Filtrar por título' });
    await filter.fill('xilofone');
    await expect(
      page.getByText('Nenhum áudio com “xilofone” no título'),
    ).toBeVisible();
    await shoot(page, 'media-list-filter-empty', width);
    await page.getByRole('button', { name: 'Limpar filtro' }).click();
    // The upload frame has no filter row on a phone: the 🔍 closes it again.
    if (phone)
      await page.getByRole('button', { name: 'Filtrar por título' }).click();

    await page.getByRole('button', { name: 'Enviar áudio' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Enviar áudio' });
    await expect(dialog).toBeVisible();
    await shoot(page, 'media-list-upload', width);
    await page.keyboard.press('Escape');
    await context.close();

    // A collection with nothing yet: who sees only Hermetismo cannot play the interview.
    const empty = await contextAt(browser, width, world.emptyLister);
    await empty.page.goto('/midia');
    await expect(
      empty.page.getByText('Ainda não há áudios neste acervo'),
    ).toBeVisible();
    await shoot(empty.page, 'media-list-empty', width);
    await empty.context.close();
  }
});

test.afterAll(() => {
  if (shots) writeFileSync(`${shots}/.done`, new Date().toISOString());
});
