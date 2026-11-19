import { writeFileSync } from 'node:fs';
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import {
  CSRF,
  WEB_ORIGIN,
  expect,
  fakeGoogle,
  signIn,
  test,
} from '../specs/fixtures.js';
import { modeRadio } from '../specs/search-view.js';
import { library, startNewCollection } from '../specs/shell-helpers.js';
import {
  ANA,
  CONVERSATIONS,
  LISTED,
  LISTED_PHONE,
  NO_TOPICS,
  OWNER,
  chatWorld,
  resetChatWorld,
  seedChatWorld,
  signInNamed,
  withFramesTime,
  type ChatOptions,
  type ChatWorld,
} from './figma-chat-world.js';

/**
 * The states of the v2 · Conversa frames (chat-*), at 1440×900 and 390×844, on the frames' own
 * sample data (figma-chat-world.ts): the capture recipe of the Figma inventory check
 * (figma-recreation/tools/inventory/check.sh chat). It only reaches each state and saves it:
 * the behaviour is proven by e2e/specs/v2-conversa, v2-pesquisa and v2-chat-interactions.
 * Needs a fresh E2E server. `KBC_FIDELITY_SHOTS=<dir>` saves `<state-id>[@mobile].png`.
 */

const shots = process.env['KBC_FIDELITY_SHOTS'];
const DESKTOP = { width: 1440, height: 900 } as const;
const PHONE = { width: 390, height: 844 } as const;
type Width = 'desktop' | 'phone';
const WIDTHS: readonly Width[] = ['desktop', 'phone'];

test.describe.configure({ timeout: 300_000 });

async function contextAt(
  browser: Browser,
  width: Width,
  options: ChatOptions = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const phone = width === 'phone';
  await resetChatWorld(world);
  const context = await browser.newContext({
    baseURL: WEB_ORIGIN,
    viewport: phone ? PHONE : DESKTOP,
    deviceScaleFactor: 1,
    hasTouch: phone,
    isMobile: phone,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  });
  await chatWorld(context, world, {
    listed: LISTED,
    ...options,
  });
  const page = await context.newPage();
  await fakeGoogle(page);
  if (options.name)
    await signInNamed(page.request, options.email ?? OWNER, options.name);
  else await signIn(page.request, options.email ?? OWNER);
  return { context, page };
}

/** `hover`: what the frame draws under the pointer (the first document's row), on a desktop. */
async function shoot(
  page: Page,
  id: string,
  width: Width,
  hover?: Locator,
): Promise<void> {
  if (!shots) return;
  await page.addStyleTag({
    content:
      '*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}',
  });
  for (let i = 0; i < 2; i += 1) {
    await page.evaluate(() =>
      document.querySelectorAll('*').forEach((node) => {
        if (node.scrollTop > 0) node.scrollTop = 0;
        // a row of chips scrolled to the one pressed starts again at its first, as drawn
        if (node.scrollLeft > 0) node.scrollLeft = 0;
      }),
    );
    await page.waitForTimeout(300);
  }
  await page.mouse.move(1, 1);
  // The frames draw the question box at rest: no focus ring, no profiles floating over it.
  // So do the collection dialogs (the name field without its focus ring) and the box's chips.
  await page.evaluate(() => {
    const focused = document.activeElement;
    if (
      focused instanceof HTMLTextAreaElement ||
      (focused instanceof HTMLInputElement &&
        focused.closest('dialog, app-composer'))
    )
      focused.blur();
  });
  if (hover && width === 'desktop') {
    await hover.hover();
    await page.waitForTimeout(200);
  }
  await page.screenshot({
    path: `${shots}/${id}${width === 'phone' ? '@mobile' : ''}.png`,
  });
}

const question = (page: Page) => page.getByLabel('Sua pergunta');

/** The home, its question box ready. */
async function home(page: Page): Promise<void> {
  await page.goto('/');
  await expect(question(page)).toBeVisible();
  await skipWizard(page);
}

/** The first-run wizard, when it shows. */
async function skipWizard(page: Page): Promise<void> {
  const skip = page.getByRole('button', { name: 'Pular' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

async function search(
  page: Page,
  text: string,
  mode?: 'Tudo' | 'Por significado',
): Promise<void> {
  if (mode) await (await modeRadio(page, mode)).check();
  await question(page).fill(text);
  await page
    .locator('app-composer')
    .getByRole('button', { name: 'Buscar', exact: true })
    .click();
}

const cards = (page: Page) => page.locator('app-result-card');
/** The first row of "Documentos", beside the best result (the frames draw it hovered). */
const firstDocument = (page: Page) => cards(page).nth(1);

/** A conversation of "Sua biblioteca" (the phone's Menu), by its title. */
async function openConversation(page: Page, title: string): Promise<void> {
  const side = await library(page);
  await side
    .getByRole('navigation', { name: 'Conversas' })
    .getByRole('button', { name: new RegExp(title.replace('?', '\\?')) })
    .first()
    .click();
}

/** A request that never answers while `held` (the frames' "Buscando…", "Pesquisando…"). */
async function hold(page: Page, url: string | RegExp): Promise<() => void> {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(url, async (route) => {
    await gate;
    await route.abort().catch(() => undefined);
  });
  return () => {
    release();
  };
}

let world: ChatWorld;
test.beforeAll(async () => {
  test.setTimeout(300_000);
  world = await seedChatWorld();
});

test('the home: empty, history, research, profiles, the library, the collection dialogs', async ({
  browser,
}) => {
  for (const width of WIDTHS) {
    const phone = width === 'phone';
    let { context, page } = await contextAt(browser, width);
    await home(page);
    await expect(
      page.getByRole('navigation', { name: 'Recentes' }),
    ).toBeVisible();
    await shoot(page, 'chat-empty', width);
    if (!phone) await shoot(page, 'chat-history', width);

    // The phone's Conversas and the Menu (both widths) list the Alquimia Prática search too.
    await context.close();
    ({ context, page } = await contextAt(browser, width, {
      listed: LISTED_PHONE,
      name: 'Helena Prado',
    }));
    await home(page);
    if (phone) {
      await page
        .getByRole('navigation', { name: 'Navegação' })
        .getByRole('link', { name: 'Conversas' })
        .click();
      await expect(
        page.getByText(CONVERSATIONS.alchemy).locator('visible=true').first(),
      ).toBeVisible();
      await shoot(page, 'chat-history', width);
      await home(page);
    }

    // The Menu (phone) or Sua biblioteca widened (desktop).
    if (phone) {
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Menu' })).toBeVisible();
    } else {
      await page
        .getByRole('button', { name: 'Ampliar Sua biblioteca' })
        .click();
    }
    await shoot(page, 'chat-sidebar-drawer-mobile', width);
    await context.close();

    ({ context, page } = await contextAt(browser, width));
    await home(page);
    await startNewCollection(page);
    const dialog = page.getByRole('dialog', { name: 'Novo acervo' });
    await dialog.getByLabel('Nome').fill('Rosacruz');
    await shoot(page, 'chat-collection-new', width);
    await dialog.getByLabel('Nome').fill('   ');
    await dialog.getByRole('button', { name: 'Criar acervo' }).click();
    await expect(
      dialog.getByText('Escreva um nome com pelo menos uma letra ou número.'),
    ).toBeVisible();
    await shoot(page, 'chat-collection-invalid', width);
    await dialog.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialog).toBeHidden();

    const side = await library(page);
    await side.getByRole('button', { name: 'Editar acervo' }).first().click();
    const edit = page.getByRole('dialog', { name: 'Editar acervo' });
    await expect(edit.getByLabel('Nome')).toHaveValue('Hermetismo');
    await shoot(page, 'chat-collection-edit', width);
    await edit.getByRole('button', { name: 'Cancelar' }).click();
    await expect(edit).toBeHidden();
    await context.close();

    const research = await contextAt(browser, width, { view: 'research' });
    await home(research.page);
    await expect(
      research.page.getByText('O que você quer pesquisar no acervo?'),
    ).toBeVisible();
    await shoot(research.page, 'chat-empty-research', width);
    if (phone) await question(research.page).focus();
    await research.page.getByRole('radio', { name: 'Exaustivo' }).check();
    await expect(
      research.page.getByText(/Varre o acervo inteiro/).first(),
    ).toBeVisible();
    await shoot(research.page, 'chat-research-profiles', width);
    await research.context.close();
  }
});

test('the home without collections: an error, none in the vault, none granted, one with no text', async ({
  browser,
}) => {
  for (const width of WIDTHS) {
    for (const [id, options, text] of [
      [
        'chat-topics-error',
        { topics: 'error' },
        'Algo deu errado do nosso lado.',
      ],
      ['chat-no-topics-master', { topics: 'none' }, 'Nenhum acervo encontrado'],
      [
        'chat-no-topics',
        { topics: 'none', email: NO_TOPICS, ownersList: true },
        'Nenhum acervo liberado',
      ],
      [
        'chat-empty-topic',
        { topics: 'empty-hermetismo' },
        'Este acervo ainda não tem textos para buscar.',
      ],
    ] as const) {
      const { context, page } = await contextAt(browser, width, options);
      await page.goto('/');
      const skip = page.getByRole('button', { name: 'Pular' });
      const ready =
        id === 'chat-empty-topic'
          ? question(page)
          : page.getByText(text).first();
      await expect(ready.or(skip)).toBeVisible();
      await skipWizard(page);
      await expect(page.getByText(text).first()).toBeVisible();
      await shoot(page, id, width);
      await context.close();
    }
  }
});

test('the results: all, loading, error, more, by meaning, filters, authorship, copies, none', async ({
  browser,
}) => {
  for (const width of WIDTHS) {
    const phone = width === 'phone';
    let { context, page } = await contextAt(browser, width);
    const fresh = async (options: ChatOptions = {}) => {
      await context.close();
      ({ context, page } = await contextAt(browser, width, options));
      await home(page);
    };
    await home(page);

    const release = await hold(page, /\/searches$/);
    await search(page, 'lei do ritmo', 'Tudo');
    await expect(
      page.getByText(/Buscando em Hermetismo/).first(),
    ).toBeVisible();
    await shoot(page, 'chat-results-loading', width);
    release();
    await page.unroute(/\/searches$/);

    await fresh();
    // The frames' "lei do ritmo" is the conversation of "Sua biblioteca", opened (it searches
    // again and stays in its place, the one open), not a new one.
    await openConversation(page, CONVERSATIONS.search);
    await expect(cards(page).first()).toBeVisible();
    await shoot(page, 'chat-results', width, firstDocument(page));

    await fresh();
    await page.route(/\/searches$/, (route) =>
      route.fulfill({
        status: 500,
        json: { error: { code: 'INTERNAL', message: 'down' } },
      }),
    );
    await search(page, 'lei do ritmo', 'Tudo');
    await expect(
      page.getByRole('button', { name: 'Tentar de novo' }).first(),
    ).toBeVisible();
    await shoot(page, 'chat-results-error', width);
    await page.unroute(/\/searches$/);

    await fresh();
    await search(page, 'ritmo', 'Tudo');
    const more = page.getByRole('button', { name: 'Mostrar mais' });
    await expect(more).toBeVisible();
    await shoot(page, 'chat-results-more', width, firstDocument(page));

    await fresh();
    await search(page, 'xqzw kplvm', 'Tudo');
    await expect(
      page.getByText('Nada encontrado para “xqzw kplvm”.'),
    ).toBeVisible();
    await shoot(page, 'chat-results-none', width);

    await fresh();
    await search(page, 'natureza', 'Por significado');
    await expect(cards(page).first()).toBeVisible();
    await shoot(page, 'chat-results-semantic', width, firstDocument(page));

    // A popover on desktop, its own sheet on a phone.
    await page.getByRole('button', { name: /^Assuntos/ }).click();
    const place = phone
      ? page.getByRole('dialog', { name: 'Assuntos' })
      : page.getByRole('group', { name: 'Assuntos' });
    await expect(place).toBeVisible();
    // The frames draw Cabala chosen, not yet applied ("Limpar" beside "Aplicar").
    await place
      .getByRole('checkbox', { name: /Cabala/ })
      .first()
      .check();
    await shoot(
      page,
      'chat-results-filter-popover',
      width,
      firstDocument(page),
    );
    await place
      .getByRole('button', { name: /^(Aplicar|Ver \d+ resultados?)$/ })
      .click();
    await expect(place).toBeHidden();
    await expect(page.getByText(/^2 documentos/).first()).toBeVisible();
    await shoot(page, 'chat-results-filtered', width, firstDocument(page));

    await fresh();
    await search(page, 'natureza', 'Por significado');
    await expect(cards(page).first()).toBeVisible();
    if (phone) {
      await page.getByRole('button', { name: 'Filtros', exact: true }).click();
      const sheet = page.getByRole('dialog', { name: 'Filtros' });
      await expect(sheet).toBeVisible();
      await shoot(page, 'chat-filters-sheet-mobile', width);
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
    } else {
      // The desktop has no Filtros sheet: its results with the filter chips, as drawn.
      await shoot(page, 'chat-filters-sheet-mobile', width);
    }

    await page
      .getByRole('radiogroup', { name: 'Autoria' })
      .getByRole('radio', { name: /Mestre Laércio/ })
      .first()
      .check();
    await expect(cards(page)).toHaveCount(1);
    await shoot(page, 'chat-results-authorship', width);

    await fresh({ tookMs: 100 });
    await search(page, 'sétupla', 'Por significado');
    await expect(cards(page).first()).toBeVisible();
    // The lone best result shows its copy beside it by itself (copy-column): nothing to open.
    await shoot(page, 'chat-results-off-topic', width);

    // No text/apostila on "ritmo" (the frame): the filtered search answers nothing.
    await fresh();
    await page.route(/\/searches$/, async (route) => {
      const asked = route.request().postDataJSON() as {
        filters?: { genres?: string[] };
      };
      const response = await route.fetch();
      if (!asked.filters?.genres?.length)
        return route.fulfill({
          response,
          json: withFramesTime(
            (await response.json()) as Record<string, unknown>,
          ),
        });
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({
        response,
        json: withFramesTime({
          ...body,
          items: [],
          total: 0,
          nextOffset: null,
        }),
      });
    });
    await search(page, 'ritmo', 'Por significado');
    await expect(cards(page).first()).toBeVisible();
    if (phone) {
      await page.getByRole('button', { name: 'Filtros', exact: true }).click();
      const sheet = page.getByRole('dialog', { name: 'Filtros' });
      const genres = sheet.locator('details', {
        has: page.locator('[data-sheet-facet="genres"]'),
      });
      await genres.locator('summary').click();
      await genres
        .getByRole('checkbox', { name: /Texto\/apostila/ })
        .first()
        .check();
      await sheet.getByRole('button', { name: /^Ver / }).click();
    } else {
      await page.getByRole('button', { name: /^Tipo de texto/ }).click();
      const popover = page.getByRole('group', { name: 'Tipo de texto' });
      await popover
        .getByRole('checkbox', { name: /Texto\/apostila/ })
        .first()
        .check();
      await popover.getByRole('button', { name: 'Aplicar' }).click();
    }
    await expect(
      page.getByText('Nada encontrado para “ritmo” com estes filtros.'),
    ).toBeVisible();
    await shoot(page, 'chat-results-none-filtered', width);
    await page.unroute(/\/searches$/);
    await context.close();
  }
});

test('the document: open, loading, error, a subject of "Veja também"', async ({
  browser,
}) => {
  for (const width of WIDTHS) {
    let { context, page } = await contextAt(browser, width);
    const fresh = async () => {
      await context.close();
      ({ context, page } = await contextAt(browser, width));
      await home(page);
    };
    await home(page);
    await search(page, 'natureza sétupla', 'Por significado');
    await expect(cards(page).first()).toBeVisible();
    const open = () =>
      page
        .getByRole('button', { name: /A Natureza Sétupla/ })
        .first()
        .click();
    const panel = () => page.locator('app-document-panel');

    const release = await hold(page, /\/documents\//);
    await open();
    await expect(panel()).toBeVisible();
    await shoot(page, 'chat-document-loading', width);
    release();
    await page.unroute(/\/documents\//);
    await fresh();

    await page.route(/\/documents\//, (route) =>
      route.fulfill({
        // chat-document-error: "Algo deu errado do nosso lado." (the server's own fault)
        status: 500,
        json: { error: { code: 'INTERNAL', message: 'down' } },
      }),
    );
    await search(page, 'natureza sétupla', 'Por significado');
    await open();
    await expect(
      panel().getByText('Não foi possível abrir “A Natureza Sétupla”'),
    ).toBeVisible();
    await shoot(page, 'chat-document-error', width);
    await page.unroute(/\/documents\//);
    await panel().getByRole('button', { name: 'Tentar de novo' }).click();
    await expect(
      panel().getByRole('heading', { name: 'A Natureza Sétupla' }).first(),
    ).toBeVisible();
    await expect(panel().locator('mark').first()).toBeVisible();
    await shoot(page, 'chat-document', width);

    const subject = panel()
      .locator('app-see-also')
      .getByRole('button', { name: /Cabala/ })
      .or(
        panel()
          .locator('app-see-also')
          .getByRole('link', { name: /Cabala/ }),
      )
      .first();
    await subject.scrollIntoViewIfNeeded();
    await subject.click();
    await expect(
      page.getByText(/Documentos que discutem a Cabala/).first(),
    ).toBeVisible();
    await shoot(page, 'chat-document-see-also', width);
    await context.close();
  }
});

test('AI research: answering, the answer, failed, interrupted, the sweep to go on', async ({
  browser,
}) => {
  for (const width of WIDTHS) {
    const phone = width === 'phone';
    let { context, page } = await contextAt(browser, width, {
      view: 'research',
    });
    const fresh = async () => {
      await context.close();
      ({ context, page } = await contextAt(browser, width, {
        view: 'research',
      }));
      await home(page);
    };
    const ask = async (text: string) => {
      await question(page).fill(text);
      await page.getByRole('button', { name: 'Perguntar' }).click();
    };

    await home(page);
    const release = await hold(page, /\/research$/);
    await ask('O que é a lei do ritmo?');
    await expect(
      page.getByText('Pesquisando no acervo…').first(),
    ).toBeVisible();
    await shoot(page, 'chat-research-streaming', width);
    release();
    await page.unroute(/\/research$/);

    await fresh();
    const release2 = await hold(page, /\/research$/);
    await ask('Como o ritmo aparece na música?');
    await expect(
      page.getByText('Pesquisando no acervo…').first(),
    ).toBeVisible();
    await shoot(page, 'chat-history-pending', width);
    release2();
    await page.unroute(/\/research$/);

    await fresh();
    await ask('O que é a lei do ritmo?');
    const answer = page.locator('app-research-message').last();
    await expect(answer.getByText(/Resposta gerada por IA/)).toBeVisible({
      timeout: 30_000,
    });
    const steps = answer.getByRole('button', { name: /Pesquisou 2 vezes/ });
    if (!phone && (await steps.isVisible())) await steps.click();
    await shoot(page, 'chat-research-answer', width);

    for (const [title, id] of [
      [CONVERSATIONS.failed, 'chat-research-error'],
      [CONVERSATIONS.interrupted, 'chat-research-interrupted'],
    ] as const) {
      await fresh();
      await openConversation(page, title);
      await expect(
        page.getByRole('button', { name: 'Tentar de novo' }).first(),
      ).toBeVisible();
      await shoot(page, id, width);
    }
    await context.close();

    const sweep = await contextAt(browser, width, {
      view: 'research',
      listed: [...LISTED, CONVERSATIONS.sweep],
    });
    await home(sweep.page);
    await openConversation(sweep.page, CONVERSATIONS.sweep);
    await expect(
      sweep.page.getByRole('button', { name: 'Continuar varredura' }),
    ).toBeVisible();
    await shoot(sweep.page, 'chat-research-continue', width);
    await sweep.context.close();
  }
});

test('acting as Ana Lima: the band over her home', async ({ browser }) => {
  for (const width of WIDTHS) {
    const { context, page } = await contextAt(browser, width, {
      recentsOf: ANA.email,
      listed: LISTED,
    });
    const started = await page.request.post(
      `/api/v1/people/${world.anaId}/act-as`,
      { data: { reason: 'conferir o que ela vê' }, headers: CSRF },
    );
    expect(started.status(), await started.text()).toBeLessThan(300);
    await home(page);
    await expect(
      page
        .locator('app-acting-banner')
        .getByText(new RegExp(ANA.name))
        .locator('visible=true')
        .first(),
    ).toBeVisible();
    await shoot(page, 'chat-acting', width);
    await page.request.delete('/api/v1/act-as', { headers: CSRF });
    await context.close();
  }
});

test.afterAll(() => {
  if (shots) writeFileSync(`${shots}/.done`, new Date().toISOString());
});
