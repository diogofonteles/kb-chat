import { readFileSync, writeFileSync } from 'node:fs';
import type {
  APIRequestContext,
  Browser,
  BrowserContext,
  Locator,
  Page,
} from '@playwright/test';
import {
  CSRF,
  OWNER_EMAIL,
  WEB_ORIGIN,
  expect,
  fakeGoogle,
  ownerApi,
  signIn,
  test,
} from './fixtures.js';
import { makeMp3, uniqueTag } from './media-helpers.js';

/**
 * KBC-128 fidelity: the library and a collection's album page put in the states of the
 * v2 · Mídia — Biblioteca e lista frames, at 1440×900 and 390×844, and used for real — the
 * page scrolls with the wheel, the keyboard and a finger (owner, 2026-11-17: after the v2
 * merge no long page could be scrolled), every control in sight answers, every menu and
 * sheet opens whole and closes. `KBC_FIDELITY_SHOTS=<dir>` saves each state as
 * `<state-id>.png` (desktop) and `<state-id>@mobile.png`, for the side-by-side with the
 * Figma frames. Each test runs both widths in its own contexts, so the WebKit project
 * (`KBC_E2E_WEBKIT=1`) covers the phone width too.
 */

const shots = process.env['KBC_FIDELITY_SHOTS'];
const DESKTOP = { width: 1440, height: 900 } as const;
const PHONE = { width: 390, height: 844 } as const;
type Width = 'desktop' | 'phone';
const WIDTHS: readonly Width[] = ['desktop', 'phone'];

const LIBRARY_FEATURES = [
  'search',
  'media',
  'media-library',
  'media-upload',
  'media-edit',
];

/** Runs in the two Chrome-or-WebKit projects only once: the phone project would repeat it. */
const skipRepeats = () =>
  test.skip(
    test.info().project.name === 'media-mobile',
    'Each test drives both widths itself (media-desktop and media-webkit).',
  );

async function contextAt(
  browser: Browser,
  width: Width,
  email = OWNER_EMAIL,
): Promise<{ context: BrowserContext; page: Page }> {
  const phone = width === 'phone';
  const isWebkit = browser.browserType().name() === 'webkit';
  const context = await browser.newContext({
    baseURL: WEB_ORIGIN,
    viewport: phone ? PHONE : DESKTOP,
    deviceScaleFactor: 1,
    hasTouch: phone,
    // WebKit's desktop build has no mobile emulation; the width is what the app reads.
    isMobile: phone && !isWebkit,
  });
  const page = await context.newPage();
  await fakeGoogle(page);
  await signIn(page.request, email);
  return { context, page };
}

async function shoot(page: Page, id: string, width: Width): Promise<void> {
  if (!shots) return;
  // Caret and transitions off: the same frame each time.
  await page.addStyleTag({
    content:
      '*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}',
  });
  // The frames show the top of the page.
  await page.evaluate(() =>
    document.querySelectorAll('*').forEach((node) => {
      if (node.scrollTop > 0) node.scrollTop = 0;
    }),
  );
  await page.mouse.move(1, 1);
  await page.waitForTimeout(150);
  await page.screenshot({
    path: `${shots}/${id}${width === 'phone' ? '@mobile' : ''}.png`,
  });
}

/* ---------------------------------------------------------------- data */

interface Seeded {
  readonly topic: string;
  readonly topicTitle: string;
  readonly empty: string;
  readonly ids: Record<string, string>;
}

const TITLES = [
  'Entrevista sobre a Tábua de Esmeralda',
  'Palestra de abertura do ciclo',
  'Conversa sobre os sete princípios',
  'Relato da Rita sobre o encontro',
  'Leitura comentada do Caibalion',
  'Aula para preparar',
  'Roda de perguntas para validar',
  'Gravação ruidosa do encontro',
  'Perguntas e respostas de 2019',
  'Aula sobre o mercúrio dos sábios',
  'Conversa sobre a Lei do Ritmo',
  'Leitura da Tábua em voz alta',
] as const;
const HELENA = new Set([0, 1, 2, 4, 8, 11]);

async function upload(
  api: APIRequestContext,
  topic: string,
  title: string,
  author: string | null,
  seconds: number,
  bytes?: Buffer,
): Promise<string> {
  const body =
    bytes ?? readFileSync(makeMp3(title.replace(/\W+/g, '-'), seconds));
  const created = await api.post(`/api/v1/topics/${topic}/media`, {
    data: { title, author, fileName: 'aula.mp3', bytes: body.length },
    headers: CSRF,
  });
  expect(created.status(), await created.text()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const sent = await api.put(`/api/v1/media/${id}/file`, {
    data: body,
    headers: { ...CSRF, 'content-type': 'application/octet-stream' },
  });
  expect(sent.status(), await sent.text()).toBe(200);
  return id;
}

async function settled(api: APIRequestContext, id: string): Promise<void> {
  await expect
    .poll(
      async () =>
        (
          (await (await api.get(`/api/v1/media/${id}`)).json()) as {
            status: string;
          }
        ).status,
      { timeout: 120_000 },
    )
    .toMatch(/^(ready|failed)$/);
}

/** Once per worker: a collection with the frames' media, one failed, and an empty one. */
let seeded: Seeded | null = null;
async function seed(): Promise<Seeded> {
  if (seeded) return seeded;
  const owner = await ownerApi();
  const tag = uniqueTag().slice(-5);
  const topicTitle = `Alquimia Prática ${tag}`;
  const made = await owner.post('/api/v1/topics', {
    headers: CSRF,
    data: { title: topicTitle },
  });
  expect(made.status(), await made.text()).toBe(201);
  const topic = ((await made.json()) as { slug: string }).slug;
  const emptyMade = await owner.post('/api/v1/topics', {
    headers: CSRF,
    data: { title: `Hermetismo ${tag}` },
  });
  const empty = ((await emptyMade.json()) as { slug: string }).slug;
  const author = await owner.post(
    `/api/v1/topics/${encodeURIComponent(topic)}/authors`,
    { headers: CSRF, data: { name: 'Irmã Helena Prado' } },
  );
  expect(author.status(), await author.text()).toBeLessThan(300);
  const helena = ((await author.json()) as { slug: string }).slug;
  const ids: Record<string, string> = {};
  ids['Arquivo corrompido da reunião'] = await upload(
    owner,
    topic,
    'Arquivo corrompido da reunião',
    null,
    0,
    Buffer.from('not an audio file at all, only words'.repeat(40)),
  );
  // Oldest first: "Adicionadas recentemente" puts the first title on top.
  for (const [index, title] of [...TITLES].reverse().entries()) {
    const n = TITLES.length - 1 - index;
    ids[title] = await upload(
      owner,
      topic,
      title,
      HELENA.has(n) ? helena : null,
      [6, 3, 2, 2, 2, 4, 4, 2, 5, 3, 3, 2][n] ?? 3,
    );
  }
  for (const id of Object.values(ids)) await settled(owner, id);
  await owner.dispose();
  seeded = { topic, topicTitle, empty, ids };
  return seeded;
}

/** Where each of the first three stopped, as the player saves it (Continuar ouvindo). */
async function inProgress(page: Page, data: Seeded): Promise<void> {
  for (const [title, ms] of [
    [TITLES[2], 900],
    [TITLES[1], 1_300],
    [TITLES[0], 2_200],
  ] as const) {
    const saved = await page.request.put(
      `/api/v1/media/${data.ids[title]}/progress`,
      { data: { positionMs: ms, basedOn: null }, headers: CSRF },
    );
    expect(saved.status(), await saved.text()).toBe(200);
  }
}

/** "Precisa da sua atenção": one to validate, one failed (the frame's two cards). */
async function attention(page: Page, data: Seeded): Promise<void> {
  const line = (title: string, over: Record<string, unknown>) => ({
    mediaId: data.ids[title],
    title,
    topic: data.topic,
    phase: 'attention',
    stage: 'transcribe',
    state: 'waiting',
    percent: null,
    cuts: null,
    windows: null,
    failure: null,
    blockedBy: null,
    position: null,
    nextStage: null,
    waitsForTranscriber: false,
    canUseGroq: false,
    durationMs: 4_000,
    action: null,
    retryStage: null,
    step: 2,
    ...over,
  });
  await page.route('**/api/v1/media/processing', (route) =>
    route.fulfill({
      json: {
        items: [
          line('Aula para preparar', { action: 'validate', stage: 'tracks' }),
          line('Arquivo corrompido da reunião', {
            state: 'failed',
            failure: 'work',
            stage: 'convert',
          }),
          line('Roda de perguntas para validar', {
            phase: 'next',
            state: 'queued',
            waitsForTranscriber: true,
          }),
        ],
        active: 0,
        transcriber: 'off',
        transcriberOffSince: null,
      },
    }),
  );
}

async function openLibrary(page: Page, data: Seeded): Promise<void> {
  // The frames' choices: the recent plays first, as a list, nothing filtered.
  const reset = await page.request.put('/api/v1/media/preferences', {
    headers: CSRF,
    data: {
      librarySort: 'recently-played',
      libraryView: 'list',
      libraryFilters: {
        states: [],
        authors: [],
        topic: data.topic,
        allTopics: false,
        subject: null,
      },
    },
  });
  expect(reset.status(), await reset.text()).toBe(200);
  await page.goto(`/biblioteca?acervo=${data.topic}`);
  await expect(
    page.getByRole('heading', { name: 'Biblioteca', level: 2 }),
  ).toBeAttached();
  await expect(page.locator('app-library-row').first()).toBeVisible();
}

const rows = (page: Page) => page.locator('app-library-row');
const rowNamed = (page: Page, title: string) =>
  rows(page).filter({ hasText: title });

/** Plays the first title and, on a desktop, opens "Tocando agora" beside the list. */
async function playFirst(page: Page, width: Width): Promise<void> {
  const row = rowNamed(page, TITLES[0]);
  await row.hover();
  await row.getByRole('button', { name: `Tocar ${TITLES[0]}` }).click();
  await expect(page.locator('app-library-row.playing')).toHaveCount(1);
  if (width === 'desktop') {
    await page.getByRole('button', { name: 'Tocando agora' }).first().click();
    await expect(
      page.getByRole('complementary', { name: 'Tocando agora' }),
    ).toBeVisible();
  }
  // Paused, so the frame stays still; the source and the panel stay.
  await page.evaluate(() =>
    document.querySelectorAll('audio,video').forEach((media) => {
      (media as HTMLMediaElement).pause();
    }),
  );
}

/* ------------------------------------------------- scrolling, for real */

/** The element that scrolls the page's content (the nearest scroller of `inside`). */
async function scrollerOf(inside: Locator): Promise<Locator> {
  const handle = await inside.evaluateHandle((node) => {
    let at: HTMLElement | null = node as HTMLElement;
    while (at) {
      const style = getComputedStyle(at);
      if (
        /(auto|scroll)/.test(style.overflowY) &&
        at.scrollHeight > at.clientHeight + 1
      )
        return at;
      at = at.parentElement;
    }
    return document.scrollingElement as HTMLElement;
  });
  const element = handle.asElement();
  if (!element) throw new Error('no scroller');
  await element.evaluate((node) => node.setAttribute('data-test-scroller', ''));
  return inside.page().locator('[data-test-scroller]');
}

const scrollTopOf = (scroller: Locator) =>
  scroller.evaluate((node) => node.scrollTop);

/** The wheel, the keyboard and (Chromium) a finger each move the list, and back up. */
async function expectScrolls(
  page: Page,
  scroller: Locator,
  width: Width,
  browserName: string,
): Promise<void> {
  const box = await scroller.boundingBox();
  if (!box) throw new Error('scroller not on screen');
  const reachable = await scroller.evaluate(
    (node) => node.scrollHeight - node.clientHeight,
  );
  expect(reachable, 'the content is longer than its box').toBeGreaterThan(100);
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(box.height / 2, 300);

  // The wheel.
  await scroller.evaluate((node) => node.scrollTo({ top: 0 }));
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, 600);
  await expect.poll(() => scrollTopOf(scroller)).toBeGreaterThan(100);

  // The keyboard: End and Home on the scroller itself (focus on its content).
  await scroller.evaluate((node) => node.scrollTo({ top: 0 }));
  await scroller.evaluate((node) => {
    node.setAttribute('tabindex', '-1');
    node.focus();
  });
  await page.keyboard.press('End');
  await expect.poll(() => scrollTopOf(scroller)).toBeGreaterThan(100);
  await page.keyboard.press('Home');
  await expect.poll(() => scrollTopOf(scroller)).toBeLessThan(5);
  await page.keyboard.press('PageDown');
  await expect.poll(() => scrollTopOf(scroller)).toBeGreaterThan(100);
  await scroller.evaluate((node) => node.removeAttribute('tabindex'));

  // A finger (Chromium speaks touch through CDP; WebKit has no synthetic swipe).
  if (width === 'phone' && browserName === 'chromium') {
    await scroller.evaluate((node) => node.scrollTo({ top: 0 }));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.synthesizeScrollGesture', {
      x: Math.round(x),
      y: Math.round(y),
      yDistance: -400,
      gestureSourceType: 'touch',
      speed: 1200,
    });
    await expect.poll(() => scrollTopOf(scroller)).toBeGreaterThan(100);
    await cdp.detach();
  }
  await scroller.evaluate((node) => node.scrollTo({ top: 0 }));
}

/** The box whole on the screen and on top at its centre (owner rule 1: never clipped). */
async function expectWholeOnTop(page: Page, overlay: Locator): Promise<void> {
  await expect(overlay).toBeVisible();
  const box = await overlay.boundingBox();
  const view = page.viewportSize();
  if (!box || !view) throw new Error('no box');
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height + 0.5);
  const own = await overlay.evaluate((node, at) => {
    const top = document.elementFromPoint(at.x, at.y);
    return !!top && node.contains(top);
  }, { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 40) });
  expect(own).toBe(true);
}

/* ---------------------------------------------------------------- tests */

test.describe.configure({ mode: 'default', timeout: 240_000 });

test('the library lists, plays and scrolls at both widths (media-library, -grid, -chip, -sort)', async ({
  browser,
  browserName,
}) => {
  skipRepeats();
  const data = await seed();
  for (const width of WIDTHS) {
    const { context, page } = await contextAt(browser, width);
    await attention(page, data);
    await inProgress(page, data);
    await openLibrary(page, data);
    const phone = width === 'phone';

    // The frame's regions, in its order.
    if (phone) {
      await expect(
        page.locator('header.topbar').getByRole('heading', { name: 'Biblioteca' }),
      ).toBeVisible();
      await expect(
        page.getByRole('link', { name: /itens precisam de atenção/ }),
      ).toBeVisible();
    } else {
      await expect(page.getByText('Tudo para ouvir')).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'Precisa da sua atenção' }),
      ).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'Continuar ouvindo' }),
      ).toBeVisible();
      for (const name of [
        'Tocar em ordem aleatória',
        'Enviar mídia',
        'Convidar pessoas',
        'Mais ações da Biblioteca',
        'Ir para a busca',
      ])
        await expect(page.getByRole('button', { name }).or(page.getByRole('link', { name }))).toBeVisible();
    }
    for (const name of ['Todas', 'Não ouvidas', 'Em andamento'])
      await expect(
        page.getByRole('group', { name: 'Filtros' }).getByRole('button', { name, exact: true }),
      ).toBeVisible();

    // It scrolls.
    const scroller = await scrollerOf(rows(page).first());
    await expectScrolls(page, scroller, width, browserName);

    await playFirst(page, width);
    await shoot(page, 'media-library', width);
    if (!phone) {
      // The right panel narrows the list: no "Continuar ouvindo", no Acervo column.
      await expect(page.getByRole('heading', { name: 'Continuar ouvindo' })).toBeHidden();
      await page.getByRole('button', { name: 'Tocando agora' }).first().click();
      await expect(page.getByRole('heading', { name: 'Continuar ouvindo' })).toBeVisible();
    }

    // "Ordenar e ver como": opens whole, a sheet on a phone; Escape closes it.
    await page.getByRole('button', { name: /^Ordenar:/ }).click();
    const sort = page.getByRole('menu', { name: 'Ordenar e ver como' });
    await expectWholeOnTop(page, sort);
    await shoot(page, 'media-library-sort', width);
    await sort.getByRole('menuitemradio', { name: 'Título A–Z' }).click();
    await expect(sort).toHaveCount(0);
    await expect(rows(page).first()).toContainText('Arquivo corrompido');
    await page.getByRole('button', { name: /^Ordenar:/ }).click();
    await page.getByRole('menuitemradio', { name: 'Ouvidas recentemente' }).click();
    await expect(rows(page).first()).toContainText(TITLES[0]);

    // The grid, and back.
    if (phone) await page.getByRole('button', { name: 'Ver como grade' }).click();
    else {
      await page.getByRole('button', { name: /^Ordenar:/ }).click();
      await page.getByRole('menuitemradio', { name: 'Grade' }).click();
    }
    await expect(page.locator('app-library-card:not(.tile)').first()).toBeVisible();
    if (!phone) await page.getByRole('button', { name: 'Tocando agora' }).first().click();
    await shoot(page, 'media-library-grid', width);
    if (!phone) await page.getByRole('button', { name: 'Tocando agora' }).first().click();
    if (phone) await page.getByRole('button', { name: 'Ver como lista' }).click();
    else {
      await page.getByRole('button', { name: /^Ordenar:/ }).click();
      await page.getByRole('menuitemradio', { name: 'Lista' }).click();
    }
    await expect(rows(page).first()).toBeVisible();

    // "Em andamento": only the three heard in part; "Todas" brings the rest back.
    const filters = page.getByRole('group', { name: 'Filtros' });
    await filters.getByRole('button', { name: 'Em andamento' }).click();
    await expect(rows(page)).toHaveCount(3);
    await shoot(page, 'media-library-chip', width);
    await filters.getByRole('button', { name: 'Todas', exact: true }).click();
    await expect(rows(page)).not.toHaveCount(3);

    // "Autoria ▾": a menu of the authors; the chosen one becomes a chip with ✕.
    await filters.getByRole('button', { name: 'Autoria' }).click();
    const authors = page.getByRole('menu', { name: 'Autoria' });
    await expectWholeOnTop(page, authors);
    await authors.getByRole('menuitemradio', { name: /Irmã Helena Prado/ }).click();
    await expect(rows(page)).toHaveCount(HELENA.size);
    await shoot(page, 'media-library-author', width);
    await filters.getByRole('button', { name: /Tirar o filtro de autoria/ }).click();
    await expect(rows(page)).toHaveCount(TITLES.length + 1);
    await context.close();
  }
});

test('the ⋯ of a row, the selection and the dialogs (row-menu, selection, edit, remove)', async ({
  browser,
}) => {
  skipRepeats();
  const data = await seed();
  for (const width of WIDTHS) {
    const { context, page } = await contextAt(browser, width);
    await openLibrary(page, data);
    const phone = width === 'phone';
    const row = rowNamed(page, TITLES[1]);
    const more = row.getByRole('button', { name: `Mais ações para ${TITLES[1]}` });
    await row.hover();
    await more.click();
    const menu = page.getByRole('menu');
    await expectWholeOnTop(page, menu);
    await expect(menu.getByRole('menuitem')).toHaveText(
      phone
        ? ['Marcar como ouvida', 'Selecionar', 'Editar informações', 'Compartilhar', 'Remover']
        : ['Tocar agora', 'Marcar como ouvida', 'Editar informações', 'Copiar link', 'Remover'],
    );
    await shoot(page, 'media-library-row-menu', width);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(more).toBeFocused();

    // A selection of two: the box on a desktop, "Selecionar" in the ⋯ on a phone.
    if (phone) {
      await more.click();
      await page.getByRole('menuitem', { name: 'Selecionar' }).click();
    } else {
      await row.hover();
      await row.getByRole('checkbox', { name: `Selecionar ${TITLES[1]}` }).check();
    }
    await rowNamed(page, TITLES[2])
      .getByRole('checkbox', { name: `Selecionar ${TITLES[2]}` })
      .check();
    const bar = page.getByRole('region', { name: 'Seleção' });
    await expect(bar).toContainText('2 selecionadas');
    await expectWholeOnTop(page, bar);
    await shoot(page, 'media-library-selection', width);
    await bar.getByRole('button', { name: 'Cancelar seleção' }).click();
    await expect(bar).toHaveCount(0);

    // Editar informações, and its error.
    await row.hover();
    await more.click();
    await page.getByRole('menuitem', { name: 'Editar informações' }).click();
    const edit = page.getByRole('dialog', { name: /Editar/ });
    await expectWholeOnTop(page, edit);
    const title = edit.getByRole('textbox', { name: 'Título' });
    await expect(title).toHaveValue(TITLES[1]);
    await shoot(page, 'media-library-edit', width);
    await title.fill('');
    await edit.getByRole('button', { name: 'Salvar' }).click();
    await expect(edit.getByText('Dê um título ao áudio.')).toBeVisible();
    await shoot(page, 'media-library-edit-errors', width);
    await edit.getByRole('button', { name: 'Cancelar' }).click();
    await expect(edit).toHaveCount(0);

    // Remover asks first; Cancelar keeps it.
    await row.hover();
    await more.click();
    await page.getByRole('menuitem', { name: 'Remover' }).click();
    const remove = page.getByRole('dialog', { name: `Remover "${TITLES[1]}"?` });
    await expectWholeOnTop(page, remove);
    await shoot(page, 'media-library-remove', width);
    await remove.getByRole('button', { name: 'Cancelar' }).click();
    await expect(remove).toHaveCount(0);
    await expect(row).toHaveCount(1);
    await context.close();
  }
});

test('the search, with and without results, and the empty library (search, search-empty, empty-*)', async ({
  browser,
}) => {
  skipRepeats();
  const data = await seed();
  for (const width of WIDTHS) {
    const { context, page } = await contextAt(browser, width);
    await openLibrary(page, data);
    const phone = width === 'phone';
    if (phone) await page.getByRole('button', { name: 'Abrir a busca' }).click();
    else await page.getByRole('button', { name: 'Ir para a busca' }).click();
    const search = page.getByLabel('Buscar na biblioteca');
    await expect(search).toBeFocused();
    await search.pressSequentially('Tábua', { delay: 20 });
    await expect(page.getByRole('heading', { name: /resultados? para “Tábua”/ })).toBeVisible();
    await expect(
      page.locator('app-library-search-results').getByRole('listitem'),
    ).not.toHaveCount(0);
    await shoot(page, 'media-library-search', width);
    await search.fill('xilofone');
    await expect(page.getByText('Nada encontrado para “xilofone”')).toBeVisible();
    await shoot(page, 'media-library-search-empty', width);
    await page.getByRole('button', { name: 'Limpar busca' }).last().click();
    await expect(rows(page).first()).toBeVisible();

    // A collection with nothing: "Ver todos os acervos" is the way out.
    await page.goto(`/biblioteca?acervo=${data.empty}`);
    await expect(page.getByText('Nenhuma mídia neste acervo')).toBeVisible();
    await shoot(page, 'media-library-collection-empty', width);
    await page.getByRole('button', { name: 'Ver todos os acervos' }).click();
    await expect(rows(page).first()).toBeVisible();
    await context.close();
  }
});

test('/midia is the collection as an album (media-list)', async ({ browser }) => {
  skipRepeats();
  const data = await seed();
  for (const width of WIDTHS) {
    const { context, page } = await contextAt(browser, width);
    await page.goto(`/biblioteca?acervo=${data.topic}`);
    await expect(rows(page).first()).toBeVisible();
    await page.goto('/midia');
    await expect(page.getByRole('link', { name: TITLES[0] }).first()).toBeVisible();
    const scroller = await scrollerOf(page.getByRole('link', { name: TITLES[0] }).first());
    await expect
      .poll(() => scroller.evaluate((node) => node.scrollHeight > node.clientHeight))
      .toBe(true);
    await page.mouse.move(700, 600);
    await page.mouse.wheel(0, 500);
    await expect.poll(() => scrollTopOf(scroller)).toBeGreaterThan(50);
    await scroller.evaluate((node) => node.scrollTo({ top: 0 }));
    await shoot(page, 'media-list', width);
    await context.close();
  }
});

test.afterAll(() => {
  if (shots) writeFileSync(`${shots}/.done`, new Date().toISOString());
});
