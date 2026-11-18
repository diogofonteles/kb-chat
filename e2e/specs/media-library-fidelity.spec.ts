import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { request } from '@playwright/test';
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
  invite,
  ownerApi,
  signIn,
  test,
  uniqueEmail,
} from './fixtures.js';
import { makeMp3, uniqueTag } from './media-helpers.js';
import { approve, audioWithTracks } from './tracks-helpers.js';
import { longPressToSelect } from './v2-media-helpers.js';

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

/** Runs in the two Chrome-or-WebKit projects only once: the phone project would repeat it. */
const skipRepeats = () =>
  test.skip(
    test.info().project.name === 'media-mobile',
    'Each test drives both widths itself (media-desktop and media-webkit).',
  );

/**
 * Who drives the library: a master of this run's own, not the owner — the library's filters
 * and view are kept in the account, and other specs running beside this one as the owner
 * would open a library filtered here.
 */
let driver = OWNER_EMAIL;

async function contextAt(
  browser: Browser,
  width: Width,
  email = driver,
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
  // The frames show the top of the page (twice: a finger's fling may still be moving it).
  for (let i = 0; i < 2; i += 1) {
    await page.evaluate(() =>
      document.querySelectorAll('*').forEach((node) => {
        if (node.scrollTop > 0) node.scrollTop = 0;
      }),
    );
    await page.waitForTimeout(400);
  }
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
  /** The bytes of "Conversa sobre os sete princípios": sent again, it is a repeated file. */
  readonly repeated: string;
  /** The recording cut in three tracks (media-library-tracks, -remove-tracks). */
  readonly recording: string;
  /** Who has "Ouvir mídia" without the library: /midia is their album page (media-list). */
  readonly lister: string;
  /** The same, on the empty collection (media-list-empty). */
  readonly emptyLister: string;
  /** The library on the empty collection only, reading / sending (media-library-empty-*). */
  readonly emptyReader: string;
  readonly emptyUploader: string;
}

const RECORDING = 'Perguntas e respostas de 2019';

const TITLES = [
  'Entrevista sobre a Tábua de Esmeralda',
  'Palestra de abertura do ciclo',
  'Conversa sobre os sete princípios',
  'Relato da Rita sobre o encontro',
  'Leitura comentada do Caibalion',
  'Aula para preparar',
  'Roda de perguntas para validar',
  'Gravação ruidosa do encontro',
  'Perguntas sobre o vegetal',
  'Aula sobre o mercúrio dos sábios',
  'Conversa sobre a Lei do Ritmo',
  'Leitura da Tábua em voz alta',
] as const;
const HELENA = new Set([0, 1, 2, 4, 8, 11]);
/** The title the lister sends himself (media-list-menu: his ⋯ edits it). */
const LISTER_SENT = 3;

interface Upload {
  readonly topic: string;
  readonly title: string;
  readonly author: string | null;
  readonly seconds: number;
  readonly bytes?: Buffer;
}

async function upload(
  api: APIRequestContext,
  { topic, title, author, seconds, bytes }: Upload,
): Promise<string> {
  const body =
    bytes ?? readFileSync(makeMp3(title.replace(/\W+/g, '-'), seconds));
  const created = await api.post(`/api/v1/topics/${topic}/media`, {
    data: {
      title,
      author,
      fileName: 'aula.mp3',
      bytes: body.length,
      // Its hash, as the browser sends it: the same file again is a repeated one (BR-2).
      sha256: createHash('sha256').update(body).digest('hex'),
    },
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

/** Each of these controls is in sight, a button or a link by its name. */
async function expectControls(
  page: Page,
  names: readonly string[],
): Promise<void> {
  for (const name of names)
    await expect(
      page
        .getByRole('button', { name })
        .or(page.getByRole('link', { name }))
        .first(),
    ).toBeVisible();
}

/** Each chip of the filters' row, by its exact name. */
async function expectChips(
  page: Page,
  names: readonly string[],
): Promise<void> {
  for (const name of names)
    await expect(
      page
        .getByRole('group', { name: 'Filtros' })
        .getByRole('button', { name, exact: true }),
    ).toBeVisible();
}

/** A send held at 0 % says so, and "Cancelar envio" stops it (media-upload-sending). */
async function expectHeldSend(
  page: Page,
  {
    dialog,
    input,
    send,
    width,
  }: {
    readonly dialog: Locator;
    readonly input: Locator;
    readonly send: Locator;
    readonly width: Width;
  },
): Promise<void> {
  await page.route('**/api/v1/media/*/upload', (route) =>
    route.request().method() === 'PATCH' ? undefined : route.continue(),
  );
  await input.setInputFiles(makeMp3(`Envio parado ${uniqueTag()}`, 4));
  await send.click();
  await expect(dialog.getByText(/Enviando/).first()).toBeVisible();
  await shoot(page, 'media-upload-sending', width);
  await page.unroute('**/api/v1/media/*/upload');
  await dialog
    .getByRole('button', { name: /Cancelar envio/ })
    .first()
    .click();
  if (await dialog.isVisible())
    await dialog
      .getByRole('button', { name: /^Cancelar|Fechar/ })
      .first()
      .click();
  await expect(dialog).toHaveCount(0);
}

/** Who sends gets "Enviar mídia", and its dialog opens whole; who only listens, none. */
async function expectUploadEntry(page: Page, sends: boolean): Promise<void> {
  if (!sends) {
    await expect(
      page.getByRole('button', { name: 'Enviar mídia' }),
    ).toHaveCount(0);
    return;
  }
  await page
    .getByRole('main')
    .getByRole('button', { name: 'Enviar mídia' })
    .last()
    .click();
  const dialog = page.getByRole('dialog', { name: 'Enviar áudio' });
  await expectWholeOnTop(page, dialog);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
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
  const person = async (
    label: string,
    topics: string[],
    features: string[],
  ) => {
    const email = uniqueEmail(label);
    await invite(owner, email, { topics, features });
    return email;
  };
  const master = uniqueEmail('mestre-biblioteca');
  await invite(owner, master, { role: 'master' });
  // Past the first-run wizard, as "Pular" leaves it (settings saved with nothing in them).
  const masterApi = await request.newContext({ baseURL: WEB_ORIGIN });
  await signIn(masterApi, master);
  const skipped = await masterApi.put('/api/v1/settings', {
    data: {},
    headers: CSRF,
  });
  expect(skipped.status(), await skipped.text()).toBe(200);
  await masterApi.dispose();
  driver = master;
  const listing = ['search', 'media', 'media-upload', 'media-edit'];
  const lister = await person('lista', [topic], listing);
  // The lister sends "Relato da Rita…" himself: on /midia its ⋯ offers "Editar informações"
  // (who sent it may edit it, KBC-050 FR-2; media-list-menu).
  const listerApi = await request.newContext({ baseURL: WEB_ORIGIN });
  await signIn(listerApi, lister);
  const ids: Record<string, string> = {};
  const repeated = makeMp3(`repetida-${tag}`, 20);
  ids['Arquivo corrompido da reunião'] = await upload(owner, {
    topic,
    title: 'Arquivo corrompido da reunião',
    author: null,
    seconds: 0,
    bytes: Buffer.from('not an audio file at all, only words'.repeat(40)),
  });
  // Oldest first: "Adicionadas recentemente" puts the first title on top.
  for (const [index, title] of [...TITLES].reverse().entries()) {
    const n = TITLES.length - 1 - index;
    ids[title] = await upload(n === LISTER_SENT ? listerApi : owner, {
      topic,
      title,
      author: HELENA.has(n) ? helena : null,
      seconds: [60, 28, 20, 16, 20, 4, 4, 12, 5, 3, 3, 2][n] ?? 3,
      bytes: n === 2 ? readFileSync(repeated) : undefined,
    });
  }
  // A recording cut in three tracks, approved and published (KBC-068).
  const cut = await audioWithTracks(owner, undefined, topic);
  await approve(owner, cut.id);
  await expect
    .poll(
      async () =>
        (
          (await (await owner.get(`/api/v1/media/${cut.id}/edit`)).json()) as {
            preparation: unknown;
          }
        ).preparation,
      { timeout: 60_000 },
    )
    .toBeNull();
  const renamed = await owner.patch(`/api/v1/media/${cut.id}`, {
    data: { title: RECORDING },
    headers: CSRF,
  });
  expect(renamed.status(), await renamed.text()).toBe(200);
  const emptyLister = await person('lista-vazia', [empty], listing);
  const emptyReader = await person(
    'leitor-vazio',
    [empty],
    ['search', 'media', 'media-library'],
  );
  const emptyUploader = await person(
    'envia-vazio',
    [empty],
    ['search', 'media', 'media-library', 'media-upload'],
  );
  for (const id of Object.values(ids)) await settled(owner, id);
  await owner.dispose();
  await listerApi.dispose();
  seeded = {
    topic,
    topicTitle,
    empty,
    ids,
    repeated,
    recording: cut.id,
    lister,
    emptyLister,
    emptyReader,
    emptyUploader,
  };
  return seeded;
}

/** Where each of the first three stopped, as the player saves it (Continuar ouvindo). */
const progressed = new Set<string>();
async function inProgress(page: Page, data: Seeded): Promise<void> {
  // Once per seed: a second save based on nothing is "another device" (409).
  if (progressed.has(data.topic)) return;
  progressed.add(data.topic);
  for (const [title, ms] of [
    [TITLES[2], 9_000],
    [TITLES[1], 12_000],
    [TITLES[0], 22_000],
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
    await page
      .getByRole('button', { name: 'Tocando agora', exact: true })
      .click();
    await expect(
      page.getByRole('complementary', { name: 'Tocando agora' }),
    ).toBeVisible();
  }
  // It keeps playing (muted), as in the frame: the row green, ⏸ in the mini-player.
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
  {
    width,
    browserName,
  }: { readonly width: Width; readonly browserName: string },
): Promise<void> {
  const box = await scroller.boundingBox();
  if (!box) throw new Error('scroller not on screen');
  // The list may still be filling in (its covers, the next page): wait for its length.
  await expect
    .poll(
      () => scroller.evaluate((node) => node.scrollHeight - node.clientHeight),
      { message: 'the content is longer than its box' },
    )
    .toBeGreaterThan(100);
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(box.height / 2, 300);

  // The wheel.
  await scroller.evaluate((node) => node.scrollTo({ top: 0 }));
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, 600);
  await expect.poll(() => scrollTopOf(scroller)).toBeGreaterThan(100);

  // The keyboard right after the page opens, nothing clicked, nothing focused (verify-2):
  // PageDown and Space move the page, Home brings it back.
  await scroller.evaluate((node) => node.scrollTo({ top: 0 }));
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
  });
  await page.keyboard.press('PageDown');
  await expect.poll(() => scrollTopOf(scroller)).toBeGreaterThan(100);
  const afterPageDown = await scrollTopOf(scroller);
  const bottom = await scroller.evaluate(
    (node) => node.scrollHeight - node.clientHeight,
  );
  await page.keyboard.press('Space');
  // Space goes on down, unless PageDown already reached the end.
  await expect
    .poll(() => scrollTopOf(scroller))
    .toBeGreaterThanOrEqual(Math.min(afterPageDown + 50, bottom - 5));
  await page.keyboard.press('Home');
  await expect.poll(() => scrollTopOf(scroller)).toBeLessThan(5);

  // The keyboard: End and Home on the scroller itself (focus on its content).
  await scroller.evaluate((node) => node.scrollTo({ top: 0 }));
  await scroller.evaluate((node) => {
    node.setAttribute('tabindex', '-1');
    node.focus();
  });
  await page.keyboard.press('End');
  await expect.poll(() => scrollTopOf(scroller)).toBeGreaterThan(100);
  // The end may bring the next page in: the keys go to the list's box again.
  await scroller.evaluate((node) => node.focus());
  await page.keyboard.press('Home');
  // WebKit animates the keys' scroll and can stop short of the top when the list grew
  // under it (the end brought the next page): a second Home finishes it, as a person would.
  await expect
    .poll(() => scrollTopOf(scroller), { timeout: 1_500 })
    .toBeLessThan(5)
    .catch(() => page.keyboard.press('Home'));
  await expect.poll(() => scrollTopOf(scroller)).toBeLessThan(5);
  await scroller.evaluate((node) => node.focus());
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
  // Back to the pointer, as a person who reaches for the mouse or the screen again: a tap on
  // the header's blank corner, so what opens next shows no keyboard focus ring.
  await page.mouse.click(box.x + 2, box.y + 2);
}

/** Nothing runs past the screen's side: the page scrolls only up and down (phone). */
async function expectNoSideScroll(page: Page): Promise<void> {
  const wide = await page.evaluate(() =>
    ['app-library-page', 'app-media-list-page', 'main']
      .map((selector) => document.querySelector(selector))
      .filter((node): node is Element => node !== null)
      .filter((node) => node.scrollWidth > node.clientWidth + 1)
      .map((node) => `${node.tagName} ${node.scrollWidth}>${node.clientWidth}`),
  );
  expect(wide, 'no horizontal overflow').toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
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
  const own = await overlay.evaluate(
    (node, at) => {
      const top = document.elementFromPoint(at.x, at.y);
      return !!top && node.contains(top);
    },
    { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 40) },
  );
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
        page
          .locator('header.topbar')
          .getByRole('heading', { name: 'Biblioteca' }),
      ).toBeVisible();
      await expect(
        page.getByRole('link', { name: /itens precisam de atenção/ }),
      ).toBeVisible();
      // The top row holds 🔍 and ⬆ only (media-library@mobile): no ⋯ of the page.
      await expectControls(page, ['Abrir a busca', 'Enviar mídia']);
      await expect(
        page
          .getByRole('button', { name: 'Mais ações da Biblioteca' })
          .and(page.locator(':visible')),
      ).toHaveCount(0);
    } else {
      await expect(page.getByText('Tudo para ouvir')).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'Precisa da sua atenção' }),
      ).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'Continuar ouvindo' }),
      ).toBeVisible();
      await expectControls(page, [
        'Tocar em ordem aleatória',
        'Enviar mídia',
        'Convidar pessoas',
        'Mais ações da Biblioteca',
        'Ir para a busca',
      ]);
    }
    for (const name of ['Todas', 'Não ouvidas', 'Em andamento'])
      await expect(
        page
          .getByRole('group', { name: 'Filtros' })
          .getByRole('button', { name, exact: true }),
      ).toBeVisible();

    if (phone) await expectNoSideScroll(page);
    // It scrolls.
    const scroller = await scrollerOf(rows(page).first());
    await expectScrolls(page, scroller, { width, browserName });

    await playFirst(page, width);
    await shoot(page, 'media-library', width);
    if (!phone) {
      // The right panel narrows the list: no "Continuar ouvindo", no Acervo column.
      await expect(
        page.getByRole('heading', { name: 'Continuar ouvindo' }),
      ).toBeHidden();
      await page
        .getByRole('button', { name: 'Tocando agora', exact: true })
        .click();
      await expect(
        page.getByRole('heading', { name: 'Continuar ouvindo' }),
      ).toBeVisible();
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
    await page
      .getByRole('menuitemradio', { name: 'Ouvidas recentemente' })
      .click();
    await expect(rows(page).first()).toContainText(TITLES[0]);

    // The grid, and back.
    if (phone)
      await page.getByRole('button', { name: 'Ver como grade' }).click();
    else {
      await page.getByRole('button', { name: /^Ordenar:/ }).click();
      await page.getByRole('menuitemradio', { name: 'Grade' }).click();
    }
    await expect(
      page.locator('app-library-card:not(.tile)').first(),
    ).toBeVisible();
    if (!phone)
      await page
        .getByRole('button', { name: 'Tocando agora', exact: true })
        .click();
    await shoot(page, 'media-library-grid', width);
    if (!phone)
      await page
        .getByRole('button', { name: 'Tocando agora', exact: true })
        .click();
    if (phone)
      await page.getByRole('button', { name: 'Ver como lista' }).click();
    else {
      await page.getByRole('button', { name: /^Ordenar:/ }).click();
      await page.getByRole('menuitemradio', { name: 'Lista' }).click();
    }
    await expect(rows(page).first()).toBeVisible();

    // "Compacta" (Ver como): the list without covers, and back to "Lista".
    await page.getByRole('button', { name: /^Ordenar:/ }).click();
    await page.getByRole('menuitemradio', { name: 'Compacta' }).click();
    await expect(page.locator('.table.compact')).toHaveCount(1);
    await expect(rows(page).first().locator('.art ui-cover')).toHaveCSS(
      'visibility',
      'hidden',
    );
    await page.getByRole('button', { name: /^Ordenar:/ }).click();
    await expect(
      page.getByRole('menuitemradio', { name: 'Compacta' }),
    ).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('menuitemradio', { name: 'Lista' }).click();
    await expect(page.locator('.table.compact')).toHaveCount(0);

    // "Em andamento": only the three heard in part; "Todas" brings the rest back.
    const filters = page.getByRole('group', { name: 'Filtros' });
    await filters.getByRole('button', { name: 'Em andamento' }).click();
    await expect(rows(page)).toHaveCount(3);
    // A phone says how much the filter left where the order was (media-library-chip@mobile).
    if (phone)
      await expect(
        page.getByRole('button', { name: /^Ordenar:/ }),
      ).toContainText(/^3 mídias · \d+ min$/);
    await shoot(page, 'media-library-chip', width);
    await filters.getByRole('button', { name: 'Todas', exact: true }).click();
    await expect(rows(page)).not.toHaveCount(3);

    // "Autoria ▾": a menu of the authors; the chosen one becomes a chip with ✕.
    await filters.getByRole('button', { name: 'Autoria' }).click();
    const authors = page.getByRole('menu', { name: 'Autoria' });
    await expectWholeOnTop(page, authors);
    await authors
      .getByRole('menuitemradio', { name: /Irmã Helena Prado/ })
      .click();
    await expect(rows(page)).toHaveCount(HELENA.size);
    await shoot(page, 'media-library-author', width);
    await filters
      .getByRole('button', { name: /Tirar o filtro de autoria/ })
      .click();
    await expect(rows(page)).toHaveCount(TITLES.length + 2);
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
    await attention(page, data);
    await openLibrary(page, data);
    const phone = width === 'phone';
    const row = rowNamed(page, TITLES[1]);
    const more = row.getByRole('button', {
      name: `Mais ações para ${TITLES[1]}`,
    });
    await row.hover();
    await more.click();
    const menu = page.getByRole('menu');
    await expectWholeOnTop(page, menu);
    await expect(menu.getByRole('menuitem')).toHaveText(
      phone
        ? [
            'Tocar em seguida',
            'Marcar como ouvida',
            'Ver marcadores',
            'Editar informações',
            'Compartilhar',
            'Remover',
          ]
        : [
            'Tocar agora',
            'Tocar em seguida',
            'Marcar como ouvida',
            'Ver marcadores',
            'Editar informações',
            'Copiar link',
            'Remover',
          ],
    );
    await shoot(page, 'media-library-row-menu', width);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(more).toBeFocused();

    // A selection of two: the box on a desktop, a long press on the row on a phone.
    if (phone) {
      await longPressToSelect(
        page,
        row,
        row.getByRole('checkbox', { name: `Selecionar ${TITLES[1]}` }),
      );
    } else {
      await row.hover();
      await row
        .getByRole('checkbox', { name: `Selecionar ${TITLES[1]}` })
        .check();
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
    // Emptied, the title says so at once and "Salvar" looks off (media-library-edit-errors).
    await expect(edit.getByText('Dê um título ao áudio.')).toBeVisible();
    const save = edit.getByRole('button', { name: 'Salvar' });
    await expect(save).toHaveAttribute('aria-disabled', 'true');
    await edit
      .getByRole('combobox', { name: 'Acervo' })
      .selectOption(data.empty);
    await expect(
      edit.getByText(/^Posições, marcadores e transcrição vão junto/),
    ).toBeVisible();
    // aria-disabled keeps it pressable (a press says why): Playwright counts it as off.
    await save.click({ force: true });
    await expect(edit).toBeVisible();
    await shoot(page, 'media-library-edit-errors', width);
    await edit.getByRole('button', { name: 'Cancelar' }).click();
    await expect(edit).toHaveCount(0);

    // Remover asks first; Cancelar keeps it.
    await row.hover();
    await more.click();
    await page.getByRole('menuitem', { name: 'Remover' }).click();
    const remove = page.getByRole('dialog', {
      name: `Remover "${TITLES[1]}"?`,
    });
    await expectWholeOnTop(page, remove);
    await shoot(page, 'media-library-remove', width);
    await remove.getByRole('button', { name: 'Cancelar' }).click();
    await expect(remove).toHaveCount(0);
    await expect(row).toHaveCount(1);
    // On a desktop the ✕ beside the title closes it too (a phone's sheet has its handle).
    if (!phone) {
      await row.hover();
      await more.click();
      await page.getByRole('menuitem', { name: 'Remover' }).click();
      await remove.getByRole('button', { name: 'Fechar' }).click();
      await expect(remove).toHaveCount(0);
    }

    // "Tocar em seguida": plays now with nothing playing, waits its turn after one that is.
    await row.hover();
    await more.click();
    await page.getByRole('menuitem', { name: 'Tocar em seguida' }).click();
    await expect(
      page.getByRole('button', { name: /^Pausar/ }).first(),
    ).toBeVisible();
    const third = rowNamed(page, TITLES[2]);
    await third.hover();
    await third
      .getByRole('button', { name: `Mais ações para ${TITLES[2]}` })
      .click();
    await page.getByRole('menuitem', { name: 'Tocar em seguida' }).click();
    await expect(
      page.locator('app-library-page [role="status"]').last(),
    ).toHaveText(`“${TITLES[2]}” toca em seguida.`);

    // "Ver marcadores": the media's page, its bookmarks in view and focused.
    await row.hover();
    await more.click();
    await page.getByRole('menuitem', { name: 'Ver marcadores' }).click();
    await expect(page).toHaveURL(/\/midia\/[^/#]+#marcadores$/);
    if (!phone)
      await expect(page.locator('app-bookmark-list h3')).toBeFocused();
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
    if (phone)
      await page.getByRole('button', { name: 'Abrir a busca' }).click();
    else await page.getByRole('button', { name: 'Ir para a busca' }).click();
    const search = page.getByLabel('Buscar na biblioteca');
    await expect(search).toBeFocused();
    await search.pressSequentially('Tábua', { delay: 20 });
    await expect(
      page.getByRole('heading', { name: /resultados? para “Tábua”/ }),
    ).toBeVisible();
    await expect(
      page.locator('app-library-search-results').getByRole('listitem'),
    ).not.toHaveCount(0);
    if (phone) await expectNoSideScroll(page);
    await shoot(page, 'media-library-search', width);
    await search.fill('xilofone');
    await expect(
      page.getByText('Nada encontrado para “xilofone”'),
    ).toBeVisible();
    await shoot(page, 'media-library-search-empty', width);
    await page.getByRole('button', { name: 'Limpar busca' }).last().click();
    await expect(rows(page).first()).toBeVisible();

    // A collection with nothing: "Ver todos os acervos" is the way out.
    await page.goto(`/biblioteca?acervo=${data.empty}`);
    await expect(page.getByText('Nenhuma mídia neste acervo')).toBeVisible();
    await shoot(page, 'media-library-collection-empty', width);
    await page
      .getByRole('button', { name: 'Ver todos os acervos', exact: true })
      .click();
    await expect(rows(page).first()).toBeVisible();
    await context.close();
  }
});

test('a recording opens its tracks, and removing it names them (tracks, remove-tracks)', async ({
  browser,
}) => {
  skipRepeats();
  const data = await seed();
  for (const width of WIDTHS) {
    const { context, page } = await contextAt(browser, width);
    await openLibrary(page, data);
    // Its tracks are rows of their own too, naming it: the recording is the row of its ⋯.
    const more = page.getByRole('button', {
      name: `Mais ações para ${RECORDING}`,
    });
    const recording = more.locator('xpath=ancestor::app-library-row[1]');
    const toggle = page.getByRole('button', { name: '3 faixas' });
    await toggle.scrollIntoViewIfNeeded();
    await toggle.click();
    const tracks = page.getByRole('list', { name: `Faixas de ${RECORDING}` });
    await expect(tracks.getByRole('listitem')).toHaveCount(3);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // The frame's recording row: a "3 faixas" pill and the chevron at its end (⌄ once open);
    // each track says its place ("faixa 2 de 3") and opens its own page.
    await expect(recording.locator('.tracks-pill')).toHaveText('3 faixas');
    await expect(
      recording.getByRole('button', { name: '3 faixas' }),
    ).toBeVisible();
    await expect(tracks.getByText('faixa 2 de 3')).toBeVisible();
    await expect(
      tracks.getByRole('link', { name: 'Segunda pergunta' }),
    ).toBeVisible();
    // Open tracks make the list the page: no attention, no "Continuar ouvindo" over it.
    await expect(page.locator('app-queue-summary')).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: 'Continuar ouvindo' }),
    ).toHaveCount(0);
    await shoot(page, 'media-library-tracks', width);

    // The first "Remover" is refused while tracks hang on it (KBC-068): the dialog comes
    // back naming them; Cancelar keeps everything.
    await recording.hover();
    await more.click();
    await page.getByRole('menuitem', { name: 'Remover' }).click();
    const remove = page.getByRole('dialog', {
      name: `Remover "${RECORDING}"?`,
    });
    await remove.getByRole('button', { name: 'Remover' }).click();
    await expect(remove.getByRole('alert')).toContainText(
      'Também remove 3 faixas: Primeira pergunta, Segunda pergunta, Terceira pergunta',
    );
    await expectWholeOnTop(page, remove);
    await shoot(page, 'media-library-remove-tracks', width);
    await remove.getByRole('button', { name: 'Cancelar' }).click();
    await expect(remove).toHaveCount(0);
    await expect(recording).toHaveCount(1);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await context.close();
  }
});

test('"Enviar mídia": empty, a file chosen, a repeated one, a wrong one and sending (media-upload-*)', async ({
  browser,
  browserName,
}) => {
  skipRepeats();
  // Playwright's WebKit lets tus's requests past a route, so the send cannot be held at 0 %
  // there; and WebKit gives a pressed button no focus, so none comes back to it. Chromium
  // proves both, at both widths.
  const chromium = browserName === 'chromium';
  if (!chromium)
    test.info().annotations.push({
      type: 'WebKit',
      description:
        'the held send and the focus back to the trigger: Chromium only',
    });
  const data = await seed();
  for (const width of WIDTHS) {
    const { context, page } = await contextAt(browser, width);
    await openLibrary(page, data);
    const phone = width === 'phone';
    const open = async () => {
      await page.getByRole('button', { name: 'Enviar mídia' }).first().click();
      const dialog = page.getByRole('dialog', { name: 'Enviar áudio' });
      await expectWholeOnTop(page, dialog);
      return dialog;
    };
    let dialog = await open();
    const input = dialog.locator('input[type="file"]');
    const send = dialog.getByRole('button', { name: 'Enviar', exact: true });
    await expect(
      dialog.getByText(/mp3, m4a, wav, flac, ogg ou opus/),
    ).toBeVisible();
    await shoot(page, 'media-upload', width);
    // Nothing chosen: "Enviar" looks off (media-upload), says what is missing, the panel stays.
    await expect(send).toHaveAttribute('aria-disabled', 'true');
    // aria-disabled keeps it pressable (a press says why): Playwright counts it as off.
    await send.click({ force: true });
    await expect(dialog.getByRole('alert')).toContainText(
      'Escolha um arquivo de áudio.',
    );

    await input.setInputFiles(
      makeMp3(`Palestra sobre o mercúrio dos sábios ${uniqueTag()}`, 4),
    );
    await expect(dialog.getByRole('textbox', { name: 'Título' })).toBeVisible();
    await expect(send).toBeEnabled();
    await expect(send).not.toHaveAttribute('aria-disabled', 'true');
    await shoot(page, 'media-upload-chosen', width);
    // A phone's list (media-upload-chosen@mobile): "Dividir em faixas ›" opens its choices.
    if (phone) {
      const division = dialog.getByRole('button', {
        name: /^Dividir em faixas/,
      });
      await expect(division).toContainText('Não dividir agora');
      await expect(
        dialog.getByRole('radio', { name: 'Vou marcar as faixas eu mesmo' }),
      ).toBeHidden();
      await division.click();
      await expect(division).toHaveAttribute('aria-expanded', 'true');
      await dialog
        .getByRole('radio', { name: 'Vou marcar as faixas eu mesmo' })
        .check();
      await expect(division).toContainText('Vou marcar as faixas eu mesmo');
      await dialog.getByRole('radio', { name: 'Não dividir agora' }).check();
      await division.click();
      await expect(division).toHaveAttribute('aria-expanded', 'false');
    }
    await dialog
      .getByRole('button', { name: /^Tirar/ })
      .first()
      .click();
    await expect(dialog.getByRole('textbox', { name: 'Título' })).toHaveCount(
      0,
    );

    await input.setInputFiles({
      name: 'Conversa sobre os sete princípios.mp3',
      mimeType: 'audio/mpeg',
      buffer: readFileSync(data.repeated),
    });
    await dialog
      .getByRole('combobox', { name: 'Acervo' })
      .selectOption(data.topic);
    await expect(dialog.getByText('Já está no acervo:')).toBeVisible();
    await shoot(page, 'media-upload-duplicate', width);
    await dialog
      .getByRole('button', { name: /^Tirar/ })
      .first()
      .click();

    await input.setInputFiles({
      name: 'apostila.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4'),
    });
    await expect(
      dialog.getByRole('alert').filter({ hasText: 'não é um áudio aceito' }),
    ).toBeVisible();
    await shoot(page, 'media-upload-bad-type', width);
    await dialog
      .getByRole('button', { name: /^Tirar/ })
      .first()
      .click();

    // Sending: the file's parts wait on the network, so it stays at 0 %.
    if (chromium) await expectHeldSend(page, { dialog, input, send, width });
    else {
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    }

    // Escape closes it, and the focus goes back to where it came from.
    dialog = await open();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    if (!phone && chromium)
      await expect(
        page.getByRole('button', { name: 'Enviar mídia' }).first(),
      ).toBeFocused();
    await context.close();
  }
});

test('an empty library, for who reads and for who sends (media-library-empty-*)', async ({
  browser,
}) => {
  skipRepeats();
  const data = await seed();
  for (const width of WIDTHS) {
    for (const [email, id, title] of [
      [
        data.emptyReader,
        'media-library-empty-reader',
        'Ainda não há mídias para você',
      ],
      [
        data.emptyUploader,
        'media-library-empty-uploader',
        'Comece enviando um áudio',
      ],
    ] as const) {
      const { context, page } = await contextAt(browser, width, email);
      await page.goto('/biblioteca');
      await expect(page.getByText(title, { exact: true })).toBeVisible();
      await expect(
        page.getByRole('region', { name: 'Precisa da sua atenção' }),
      ).toHaveCount(0);
      // The frame first, before its chip is used (and keeps the focus).
      await shoot(page, id, width);
      // "Autoria" stays among the chips with nothing to tell apart yet (-empty-*).
      const authorship = page
        .getByRole('group', { name: 'Filtros' })
        .getByRole('button', { name: 'Autoria' });
      await expect(authorship).toBeVisible();
      await authorship.click();
      await expect(
        page.getByRole('menuitemradio', { name: 'Todas as autorias' }),
      ).toHaveAttribute('aria-checked', 'true');
      await page.keyboard.press('Escape');
      await expect(authorship).toBeFocused();
      await expectUploadEntry(page, id === 'media-library-empty-uploader');
      await context.close();
    }
  }
});

test('/midia is the collection as an album, for who has no library (media-list-*)', async ({
  browser,
  browserName,
}) => {
  skipRepeats();
  const data = await seed();
  for (const width of WIDTHS) {
    const phone = width === 'phone';
    const { context, page } = await contextAt(browser, width, data.lister);
    await page.goto('/midia');
    const first = page.getByRole('link', { name: TITLES[0] });
    await expect(first).toBeVisible();
    await expect(
      page.getByRole('heading', { name: `Acervo — ${data.topicTitle}` }),
    ).toBeAttached();
    if (phone) {
      await expect(
        page
          .locator('header.topbar')
          .getByRole('heading', { name: data.topicTitle }),
      ).toBeVisible();
      await expectChips(page, ['Todas', 'Em andamento', 'Não ouvidas']);
    } else {
      await expectControls(page, [
        'Tocar a primeira da lista',
        'Tocar em ordem aleatória',
        'Enviar áudio',
        'Mais ações do acervo',
      ]);
      await expect(
        page.getByRole('link', { name: 'Meus marcadores' }).first(),
      ).toBeVisible();
      await expect(
        page.getByRole('searchbox', { name: 'Filtrar por título' }),
      ).toBeVisible();
    }
    if (phone) await expectNoSideScroll(page);
    // The frame is the top of the page, before any finger's fling.
    await shoot(page, 'media-list', width);
    // It scrolls, with the wheel, the keyboard and a finger.
    const scroller = await scrollerOf(first);
    await expectScrolls(page, scroller, { width, browserName });

    // The ⋯ of an audio: whole on the screen, Escape closes it.
    const more = page.getByRole('button', {
      name: `Mais ações para ${TITLES[3]}`,
    });
    await more.scrollIntoViewIfNeeded();
    await more.click();
    const menu = page.getByRole('menu');
    await expectWholeOnTop(page, menu);
    // He sent it: "Editar informações" too. "Remover" is a master's, and a master has the
    // library, never /midia (KBC-051 FR-7) — the frame's "Remover" has no one to show it to.
    await expect(menu.getByRole('menuitem')).toHaveText(
      phone
        ? ['Tocar em seguida', 'Editar informações', 'Compartilhar']
        : [
            'Tocar agora',
            'Tocar em seguida',
            'Editar informações',
            'Copiar link',
          ],
    );
    await shoot(page, 'media-list-menu', width);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    if (!phone) {
      await more.click();
      await page.getByRole('menuitem', { name: 'Tocar agora' }).click();
      await expect(page.locator('li.row.playing')).toContainText(TITLES[3]);
    }

    // The title filter, with nothing found: "Limpar filtro" brings the list back.
    if (phone)
      await page.getByRole('button', { name: 'Filtrar por título' }).click();
    const filter = page.getByRole('searchbox', { name: 'Filtrar por título' });
    await expect(filter).toBeVisible();
    await filter.fill('xilofone');
    await expect(
      page.getByText('Nenhum áudio com “xilofone” no título'),
    ).toBeVisible();
    await shoot(page, 'media-list-filter-empty', width);
    await page.getByRole('button', { name: 'Limpar filtro' }).click();
    await expect(first).toBeVisible();

    // "Em andamento" on a phone; "Autoria" everywhere.
    if (phone) {
      const chips = page.getByRole('group', { name: 'Filtros' });
      await chips.getByRole('button', { name: 'Não ouvidas' }).click();
      await expect(page.getByRole('link', { name: TITLES[0] })).toHaveCount(1);
      await chips.getByRole('button', { name: 'Todas', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Autoria' }).first().click();
    const authors = page.getByRole('menu', { name: 'Autoria' });
    await expectWholeOnTop(page, authors);
    await authors
      .getByRole('menuitemradio', { name: /Irmã Helena Prado/ })
      .click();
    await expect(page.locator('li.row')).toHaveCount(HELENA.size);
    await page
      .getByRole('button', { name: /Tirar o filtro de autoria/ })
      .first()
      .click();
    await expect(page.locator('li.row')).toHaveCount(TITLES.length + 2);

    // "Enviar áudio" opens the panel, Escape closes it.
    if (phone)
      await page.getByRole('button', { name: 'Enviar áudio' }).first().click();
    else
      await page.getByRole('button', { name: 'Enviar áudio' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Enviar áudio' });
    await expectWholeOnTop(page, dialog);
    await shoot(page, 'media-list-upload', width);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await context.close();

    // A collection with nothing yet.
    const empty = await contextAt(browser, width, data.emptyLister);
    await empty.page.goto('/midia');
    await expect(
      empty.page.getByText('Ainda não há áudios neste acervo'),
    ).toBeVisible();
    // The phone's top row keeps 🔍 and the chips keep "Autoria" (media-list-empty@mobile).
    if (phone) {
      await expectControls(empty.page, ['Filtrar por título']);
      await expectChips(empty.page, ['Todas', 'Em andamento', 'Não ouvidas']);
      await expect(
        empty.page
          .getByRole('group', { name: 'Filtros' })
          .getByRole('button', { name: 'Autoria' }),
      ).toBeVisible();
    }
    await shoot(empty.page, 'media-list-empty', width);
    await empty.page
      .getByRole('main')
      .getByRole('button', { name: 'Enviar áudio' })
      .last()
      .click();
    await expect(
      empty.page.getByRole('dialog', { name: 'Enviar áudio' }),
    ).toBeVisible();
    await empty.context.close();
  }
});

test.afterAll(() => {
  if (shots) writeFileSync(`${shots}/.done`, new Date().toISOString());
});
