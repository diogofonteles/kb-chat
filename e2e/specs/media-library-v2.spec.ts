import AxeBuilder from '@axe-core/playwright';
import type { Browser, Locator, Page } from '@playwright/test';
import {
  OWNER_EMAIL,
  expect,
  invite,
  ownerApi,
  pageAs,
  test,
  uniqueEmail,
} from './fixtures.js';
import {
  aCollection,
  chooseLibraryView,
  makeMp3,
  uniqueTag,
  uploadReady,
  useTheme,
  type UploadedMedia,
} from './media-helpers.js';

/**
 * KBC-128: the media library in v2 — the header with its cover, the track table, "Precisa
 * da sua atenção", the grid, the selection bar, the dialogs and the empty states, at 1440
 * and 390. Every menu is whole on the screen and above everything (owner rule 1, D5).
 * `KBC_SHOTS=<dir>` saves the screens for the comparison with the Figma frames.
 */

const shots = process.env['KBC_SHOTS'];
async function shoot(page: Page, name: string): Promise<void> {
  if (shots)
    await page.screenshot({
      path: `${shots}/${name}-${page.viewportSize()?.width}.png`,
    });
}

const LIBRARY = ['search', 'media', 'media-library'];
const viewportOf = () => test.info().project.use.viewport ?? null;
const wide = () => (viewportOf()?.width ?? 0) >= 1024;
const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;
const all = (page: Page) => page.getByRole('region', { name: 'Todas' });
const rowOf = (page: Page, media: UploadedMedia) =>
  all(page).getByRole('listitem').filter({ hasText: media.title });

/** The whole box on the screen, and what is drawn at its corners and centre is its own. */
async function expectWholeOnTop(page: Page, overlay: Locator): Promise<void> {
  await expect(overlay).toBeVisible();
  const box = await overlay.boundingBox();
  const view = page.viewportSize();
  if (!box || !view) throw new Error('no box to measure');
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height + 0.5);
  // Far enough in to clear rounded corners (a pill, a sheet's top).
  const inset = Math.max(12, Math.min(box.width, box.height) / 4);
  const points = [
    [box.x + box.width / 2, box.y + box.height / 2],
    [box.x + inset, box.y + inset],
    [box.x + box.width - inset, box.y + inset],
    [box.x + inset, box.y + box.height - inset],
    [box.x + box.width - inset, box.y + box.height - inset],
  ];
  const owned = await overlay.evaluate(
    (element, at) =>
      at.map(([x, y]) => {
        const top = document.elementFromPoint(x ?? 0, y ?? 0);
        return !!top && element.contains(top);
      }),
    points,
  );
  expect(owned).toEqual(points.map(() => true));
}

async function openLibrary(page: Page, topic: string) {
  await page.goto(`/biblioteca?acervo=${topic}`);
  await expect(
    page.getByRole('heading', { name: 'Biblioteca', level: 2 }),
  ).toBeVisible();
  await expect(all(page).getByText(/^3 mídias/)).toBeVisible();
}

/** A new member with the library on `topics`: their marks are their own. */
async function listener(
  browser: Browser,
  topics: readonly string[],
  features: readonly string[] = LIBRARY,
): Promise<Page> {
  const email = uniqueEmail('biblioteca-v2');
  const owner = await ownerApi();
  await invite(owner, email, { topics, features });
  await owner.dispose();
  return pageAs(browser, email, viewportOf());
}

const seriousViolations = async (page: Page) =>
  (await new AxeBuilder({ page }).analyze()).violations.filter((violation) =>
    ['serious', 'critical'].includes(violation.impact ?? ''),
  );

let collection: string;
let lectures: UploadedMedia[];

// One worker per project: the recordings are made once (see media-library-home.spec.ts).
test.describe.configure({ mode: 'default' });

test.beforeAll(async () => {
  const tag = uniqueTag();
  const owner = await ownerApi();
  collection = await aCollection(owner);
  lectures = [];
  // Words, not digits: the clock-based tag may hold any digit (NFR-3).
  for (const word of ['um', 'dois', 'três'])
    lectures.push(
      await uploadReady(owner, {
        title: `Palestra ${tag} número ${word}`,
        seconds: 6,
        topic: collection,
      }),
    );
  await owner.dispose();
});

const lecture = (n: number): UploadedMedia => {
  const found = lectures[n - 1];
  if (!found) throw new Error(`no lecture ${n}`);
  return found;
};

test('AC-1: the library is a playlist — cover, green ▶, the table, the one playing in green', async ({
  browser,
}) => {
  const page = await pageAs(browser, OWNER_EMAIL, viewportOf());
  await openLibrary(page, collection);
  await expect(page.locator('app-library-page')).toContainText(
    'Tudo para ouvir',
  );
  await expect(all(page).getByRole('listitem')).toHaveCount(3);
  // A desktop's header has ▶ for the list; a phone's has none (media-library@mobile): a tap
  // on a cover plays that one.
  const first = all(page).locator('app-library-row').first();
  const firstTitle =
    (await first.locator('.title').textContent())?.trim() ?? '';
  const playAll = desktop(page)
    ? page.getByRole('button', { name: 'Tocar a primeira da lista' })
    : first.getByRole('button', { name: `Tocar ${firstTitle}` });
  if (!desktop(page))
    await expect(
      page.getByRole('button', { name: 'Tocar a primeira da lista' }),
    ).toBeHidden();
  await shoot(page, 'media-library');
  await playAll.click();
  const pauseAll = desktop(page)
    ? page.getByRole('button', { name: 'Pausar a lista' })
    : first.getByRole('button', { name: `Pausar ${firstTitle}` });
  await expect(pauseAll).toBeVisible();
  const playing = all(page).locator('app-library-row.playing');
  await expect(playing).toHaveCount(1);
  const color = (locator: Locator) =>
    locator.evaluate((element) => getComputedStyle(element).color);
  expect(await color(playing.locator('.title'))).not.toBe(
    await color(
      all(page).locator('app-library-row:not(.playing) .title').first(),
    ),
  );
  await shoot(page, 'media-library-playing');
  await pauseAll.click();
  await expect(playAll).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
  await page.context().close();
});

test('FR-3, D5: Ordenar e ver como and the ⋯ open whole on the screen, a sheet on a phone', async ({
  browser,
}) => {
  const page = await pageAs(browser, OWNER_EMAIL, viewportOf());
  await openLibrary(page, collection);
  await page.getByRole('button', { name: /^Ordenar:/ }).click();
  const sort = page.getByRole('menu', { name: 'Ordenar e ver como' });
  await expectWholeOnTop(page, sort);
  await expect(sort.getByRole('group', { name: 'Ordenar por' })).toBeVisible();
  await expect(sort.getByRole('group', { name: 'Ver como' })).toBeVisible();
  if (!desktop(page)) {
    // The sheet stands on the foot of the screen.
    const box = await sort.boundingBox();
    expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(
      page.viewportSize()?.height,
    );
  }
  await shoot(page, 'media-library-sort');
  await page.keyboard.press('Escape');
  await expect(sort).toHaveCount(0);

  // The last row's ⋯, the nearest to the screen's edge.
  await rowOf(page, lecture(3))
    .getByRole('button', { name: `Mais ações para ${lecture(3).title}` })
    .click();
  const menu = page.getByRole('menu');
  await expectWholeOnTop(page, menu);
  // The frame's ⋯ (media-library-row-menu): play, play next, mark, the bookmarks, edit and
  // copy the link on a desktop; a phone's sheet also starts a selection and shares instead
  // of copying (a tap on the cover plays there).
  await expect(menu.getByRole('menuitem')).toHaveText(
    desktop(page)
      ? [
          'Tocar agora',
          'Tocar em seguida',
          'Marcar como ouvida',
          'Ver marcadores',
          'Editar informações',
          'Copiar link',
          'Remover',
        ]
      : [
          'Tocar em seguida',
          'Marcar como ouvida',
          'Ver marcadores',
          'Selecionar',
          'Editar informações',
          'Compartilhar',
          'Remover',
        ],
  );
  await shoot(page, 'media-library-row-menu');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await page.context().close();
});

test('AC-6: the grid, the search with and without results, and the dialogs render', async ({
  browser,
}) => {
  const page = await pageAs(browser, OWNER_EMAIL, viewportOf());
  await openLibrary(page, collection);

  await chooseLibraryView(page, 'Grade');
  await expect(all(page).locator('app-library-card')).toHaveCount(3);
  await shoot(page, 'media-library-grid');
  await chooseLibraryView(page, 'Lista');
  await expect(all(page).locator('app-library-row')).toHaveCount(3);

  // A phone's box opens from the 🔍 of its top row (media-library-search@mobile).
  if (!desktop(page))
    await page.getByRole('button', { name: 'Abrir a busca' }).click();
  const search = page.getByLabel('Buscar na biblioteca');
  // Only lecture 2 has the word, whatever the tag is.
  await search.fill('dois');
  await expect(
    page.locator('app-library-search-results').getByRole('listitem'),
  ).toHaveCount(1);
  await shoot(page, 'media-library-search');
  await search.fill('xilofone');
  await expect(page.getByText(/Nada encontrado/)).toBeVisible();
  await shoot(page, 'media-library-search-empty');
  await page.getByRole('button', { name: 'Limpar busca' }).last().click();
  await expect(all(page).getByText(/^3 mídias/)).toBeVisible();

  // Enviar mídia: a modal, a tall sheet on a phone.
  await page.getByRole('button', { name: 'Enviar mídia' }).first().click();
  const upload = page.getByRole('dialog', { name: 'Enviar áudio' });
  await expectWholeOnTop(page, upload);
  await shoot(page, 'media-upload');
  await upload
    .locator('input[type="file"]')
    .setInputFiles(makeMp3('Palestra sobre o mercurio', 2));
  await expect(upload.getByRole('textbox', { name: 'Título' })).toHaveValue(
    /mercurio/,
  );
  await shoot(page, 'media-upload-chosen');
  await upload.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await expect(upload).toHaveCount(0);

  // Editar informações, with the cover, and its error.
  const more = () =>
    rowOf(page, lecture(1)).getByRole('button', {
      name: `Mais ações para ${lecture(1).title}`,
    });
  await more().click();
  await page.getByRole('menuitem', { name: 'Editar informações' }).click();
  const edit = page.getByRole('dialog', { name: /Editar/ });
  await expectWholeOnTop(page, edit);
  await shoot(page, 'media-library-edit');
  await edit.getByRole('textbox', { name: 'Título' }).fill('');
  await expect(edit.getByRole('button', { name: 'Salvar' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await edit.getByRole('button', { name: 'Salvar' }).click({ force: true });
  await expect(edit.getByText('Dê um título ao áudio.')).toBeVisible();
  await shoot(page, 'media-library-edit-errors');
  await edit.getByRole('button', { name: 'Cancelar' }).click();
  await expect(edit).toHaveCount(0);

  // Remover asks first.
  await more().click();
  await page.getByRole('menuitem', { name: 'Remover' }).click();
  const remove = page.getByRole('dialog', {
    name: `Remover "${lecture(1).title}"?`,
  });
  await expectWholeOnTop(page, remove);
  await shoot(page, 'media-library-remove');
  await remove.getByRole('button', { name: 'Cancelar' }).click();
  await expect(remove).toHaveCount(0);
  await expect(rowOf(page, lecture(1))).toHaveCount(1);
  await page.context().close();
});

test('AC-4: three selected — the bar takes the foot of the phone, and the mark is for the three', async ({
  browser,
}) => {
  const page = await listener(browser, [collection]);
  await openLibrary(page, collection);
  const boxOf = (n: number) =>
    all(page).getByRole('checkbox', {
      name: `Selecionar ${lecture(n).title}`,
    });
  if (!desktop(page)) {
    // A phone shows no box until a selection starts from a row's ⋯ "Selecionar"
    // (media-library-selection@mobile); then, with no hover, each unchecked box shows its
    // edge, or a tap on the blank lead column would select a row never seen as a target.
    await expect(boxOf(2)).toBeHidden();
    await rowOf(page, lecture(1))
      .getByRole('button', { name: `Mais ações para ${lecture(1).title}` })
      .click();
    await page
      .getByRole('menuitem', { name: 'Selecionar', exact: true })
      .click();
    await expect(boxOf(1)).toBeChecked();
    for (const n of [2, 3])
      await expect(boxOf(n)).not.toHaveCSS(
        'border-top-color',
        'rgba(0, 0, 0, 0)',
      );
  }
  for (const n of [1, 2, 3]) await boxOf(n).check();
  const bar = page.getByRole('region', { name: 'Seleção' });
  await expect(bar).toContainText('3 selecionadas');
  await expectWholeOnTop(page, bar);
  if (!desktop(page)) {
    const box = await bar.boundingBox();
    const view = page.viewportSize();
    // A card 8 px in from the sides, 24 px over the foot, over the bottom navigation
    // (media-library-selection@mobile: 374×56 at y 764).
    expect(box?.x).toBe(8);
    expect(box?.width).toBe((view?.width ?? 0) - 16);
    expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(
      (view?.height ?? 0) - 24,
    );
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(56);
  }
  await shoot(page, 'media-library-selection');
  await bar.getByRole('button', { name: 'Marcar como ouvida' }).click();
  await expect(
    page.locator('app-library-page').getByRole('status'),
  ).toContainText('3 mídias marcadas como ouvidas.');
  for (const n of [1, 2, 3])
    await expect(rowOf(page, lecture(n))).toContainText('✓ Ouvida');
  await expect(bar).toHaveCount(0);
  await page.context().close();
});

test('AC-5: a member who may not edit sees neither Editar nor Remover in the ⋯', async ({
  browser,
}) => {
  const page = await listener(browser, [collection]);
  await openLibrary(page, collection);
  await rowOf(page, lecture(2))
    .getByRole('button', { name: `Mais ações para ${lecture(2).title}` })
    .click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveText(
    desktop(page)
      ? [
          'Tocar agora',
          'Tocar em seguida',
          'Marcar como ouvida',
          'Ver marcadores',
          'Copiar link',
        ]
      : [
          'Tocar em seguida',
          'Marcar como ouvida',
          'Ver marcadores',
          'Selecionar',
          'Compartilhar',
        ],
  );
  await expect(
    menu.getByRole('menuitem', { name: 'Editar informações' }),
  ).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'Remover' })).toHaveCount(0);
  await page.context().close();
});

/** A line of the queue as the API reports it (KBC-090's contract), for seeded states. */
const queueLine = (n: number, over: Record<string, unknown>) => ({
  mediaId: lecture(n).id,
  title: lecture(n).title,
  topic: collection,
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
  durationMs: 6_000,
  action: null,
  retryStage: null,
  step: 2,
  ...over,
});

/** One failed, one waiting with no Groq for this person, one Groq may take now. */
async function seedAttention(page: Page): Promise<void> {
  const waiting = { phase: 'next', state: 'queued', waitsForTranscriber: true };
  await page.route('**/api/v1/media/processing', (route) =>
    route.fulfill({
      json: {
        items: [
          queueLine(1, { state: 'failed', failure: 'work' }),
          queueLine(2, waiting),
          queueLine(3, { ...waiting, canUseGroq: true }),
        ],
        active: 0,
        transcriber: 'off',
        transcriberOffSince: null,
      },
    }),
  );
}

/** Its centre is on the screen and is its own: nothing (bar, mini player) covers it. */
async function expectAboveTheFold(page: Page, element: Locator): Promise<void> {
  const box = await element.boundingBox();
  const view = page.viewportSize();
  if (!box || !view) throw new Error('no box to measure');
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);
  const own = await element.evaluate(
    (node, at) => {
      const top = document.elementFromPoint(at.x, at.y);
      return !!top && node.contains(top);
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
  expect(own).toBe(true);
}

test('AC-2: "Precisa da sua atenção" names what failed and what waits, each with its way', async ({
  browser,
}) => {
  test.skip(
    !wide(),
    'The desktop cards; a phone has one card (the next test).',
  );
  const page = await listener(
    browser,
    [collection],
    [...LIBRARY, 'media-upload', 'media-edit'],
  );
  await seedAttention(page);
  const groqSent: string[] = [];
  await page.route('**/api/v1/media/*/transcription/groq', async (route) => {
    groqSent.push(route.request().url());
    // Groq is paid: the answer is the item as it stands, nothing is sent.
    const item = await page.request.get(`/api/v1/media/${lecture(3).id}`);
    await route.fulfill({ json: await item.json() });
  });
  await openLibrary(page, collection);
  const attention = page.getByRole('region', {
    name: 'Precisa da sua atenção',
  });
  await expect(attention.getByText('Falhou', { exact: true })).toBeVisible();
  await expect(attention.getByText('Aguardando', { exact: true })).toHaveCount(
    2,
  );
  const details = attention.getByRole('link', {
    name: `Ver detalhes: ${lecture(1).title}`,
  });
  await expect(details).toHaveAttribute('href', `/midia/${lecture(1).id}`);
  // Waiting, and Groq may not take it for this person: its page has the details.
  await expect(
    attention.getByRole('link', { name: `Ver detalhes: ${lecture(2).title}` }),
  ).toBeVisible();
  await expect(
    attention.getByRole('button', {
      name: `Transcrever com Groq: ${lecture(2).title}`,
    }),
  ).toHaveCount(0);
  // Waiting, and Groq may take it: the card offers it, as the media page does.
  const groq = attention.getByRole('button', {
    name: `Transcrever com Groq: ${lecture(3).title}`,
  });
  await expect(groq).toBeVisible();
  await expect(
    attention.getByRole('link', { name: `Ver detalhes: ${lecture(3).title}` }),
  ).toHaveCount(0);
  await expect(
    attention.getByRole('link', { name: 'Ver a fila' }),
  ).toBeVisible();
  await shoot(page, 'media-library-attention');
  await groq.click();
  const question = attention.getByRole('group', {
    name: /Transcrever este áudio com o Groq agora\?/,
  });
  await expect(question).toContainText('Custa cerca de US$');
  await shoot(page, 'media-library-attention-groq');
  await question.getByRole('button', { name: 'Transcrever com Groq' }).click();
  await expect(question).toHaveCount(0);
  expect(groqSent).toEqual([
    expect.stringContaining(
      `/api/v1/media/${lecture(3).id}/transcription/groq`,
    ),
  ]);
  await details.click();
  await expect(page).toHaveURL(new RegExp(`/midia/${lecture(1).id}`));
  await page.context().close();
});

test('AC-1, AC-2, BR-3: on a phone one card sums up the attention, and the list starts above the fold', async ({
  browser,
}) => {
  test.skip(
    wide(),
    'The phone layout (media-library@mobile); the desktop cards are AC-2 above.',
  );
  const page = await listener(
    browser,
    [collection],
    [...LIBRARY, 'media-upload', 'media-edit'],
  );
  await seedAttention(page);
  await openLibrary(page, collection);
  const card = page.getByRole('link', { name: /3 itens precisam de atenção/ });
  await expect(card).toHaveAttribute('href', '/fila');
  await expect(card).toContainText('1 falhou · 2 aguardando');
  // The desktop cards give way to the one card.
  await expect(
    page.getByRole('link', { name: `Ver detalhes: ${lecture(1).title}` }),
  ).toHaveCount(0);
  const first = all(page).getByRole('listitem').first();
  await expectAboveTheFold(page, first);
  // The frame's row: cover 52, about 64 px, the title and one line under it.
  const box = await first.boundingBox();
  expect(box?.height ?? 0).toBeLessThanOrEqual(72);
  await shoot(page, 'media-library-attention-phone');
  await card.click();
  await expect(page).toHaveURL(/\/fila/);
  await page.context().close();
});

test('AC-6: an empty library says so, for who reads and for who sends', async ({
  browser,
}) => {
  const owner = await ownerApi();
  const empty = await aCollection(owner);
  await owner.dispose();
  for (const features of [LIBRARY, [...LIBRARY, 'media-upload']]) {
    const page = await listener(browser, [empty], features);
    await page.goto(`/biblioteca?acervo=${empty}`);
    const sends = features.includes('media-upload');
    await expect(
      page.getByText(
        sends ? 'Comece enviando um áudio' : 'Ainda não há mídias para você',
      ),
    ).toBeVisible();
    if (sends)
      await expect(
        all(page).getByRole('button', { name: 'Enviar mídia' }),
      ).toBeVisible();
    await shoot(
      page,
      sends ? 'media-library-empty-uploader' : 'media-library-empty-reader',
    );
    expect(await seriousViolations(page)).toEqual([]);
    await page.context().close();
  }
});

test('/midia without the library is the collection as an album, with its table', async ({
  browser,
}) => {
  const page = await listener(browser, [collection], ['search', 'media']);
  await page.goto('/');
  await page.goto('/midia');
  // The collection chosen in the sidebar is this one (the only one the person sees).
  await expect(page.getByRole('heading', { name: /^Acervo — / })).toBeVisible();
  for (const n of [1, 2, 3])
    await expect(
      page.getByRole('link', { name: lecture(n).title }),
    ).toBeVisible();
  await shoot(page, 'media-list');
  expect(await seriousViolations(page)).toEqual([]);
  await page.context().close();
});

for (const theme of ['light', 'dark', 'esoteric'] as const)
  test(`NFR-1: no serious axe violation on the library in the ${theme} theme`, async ({
    browser,
  }) => {
    const page = await listener(browser, [collection]);
    await useTheme(page, theme);
    await openLibrary(page, collection);
    expect(await seriousViolations(page)).toEqual([]);
    await page.getByRole('button', { name: /^Ordenar:/ }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await page.context().close();
  });
