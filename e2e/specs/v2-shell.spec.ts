import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  CSRF,
  expect,
  invite,
  ownerApi,
  pageAs,
  test,
  uniqueEmail,
} from './fixtures.js';
import { expectSummary } from './search-view.js';
import { aCollection } from './media-helpers.js';
import {
  chooseCollection,
  collectionItem,
  desktop,
  library,
  openSettings,
} from './shell-helpers.js';

/**
 * KBC-125: the v2 shell on every screen, at 1440 and 390 (one project each): the top bar,
 * Sua biblioteca, the player bar under the audio rule, the phone navigation and the band of
 * "Vendo como".
 */
const shots = process.env['KBC_SHOTS'];
async function shoot(page: Page, name: string): Promise<void> {
  if (shots)
    await page.screenshot({
      path: `${shots}/${name}-${page.viewportSize()?.width}.png`,
    });
}

async function seriousViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
    );
}

/** A collection of its own with nothing but texts (none yet): the audio rule's "texts only". */
async function textOnlyCollection(page: Page): Promise<string> {
  const owner = await ownerApi();
  const slug = await aCollection(owner);
  await owner.dispose();
  const topics = (await (await page.request.get('/api/v1/topics')).json()) as {
    items: { slug: string; title: string }[];
  };
  return topics.items.find((t) => t.slug === slug)?.title ?? slug;
}

test('AC-1: every route has the top bar, Sua biblioteca and the main panel', async ({
  page,
}) => {
  for (const path of ['/', '/biblioteca', '/fila', '/catalogo-ui']) {
    await page.goto(path);
    if (desktop(page)) {
      await expect(
        page.locator('app-top-bar').getByRole('search'),
      ).toBeVisible();
      await expect(
        page.getByRole('complementary', { name: 'Sua biblioteca' }),
      ).toBeVisible();
    } else {
      const nav = page.getByRole('navigation', { name: 'Navegação' });
      await expect(nav).toBeVisible();
      // The Menu from every route: the avatar, or on a page drawn with "‹" in its place
      // (v2 · Fila, celular) one step back.
      const menu = await library(page);
      await expect(menu).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
    }
    await expect(page.getByRole('main')).toBeVisible();
  }
  await page.goto('/');
  await expect(page.getByLabel('Sua pergunta')).toBeVisible();
  await shoot(page, 'shell-chat-empty');
  expect(await seriousViolations(page)).toEqual([]);
});

test('AC-2: ⌘K focuses the global search from the library and Enter searches the collection in use', async ({
  page,
}) => {
  test.skip(!desktop(page), 'The global search is the desktop top bar.');
  await page.goto('/biblioteca');
  await page
    .getByRole('heading', { name: 'Biblioteca', level: 2, exact: true })
    .waitFor();
  await page.keyboard.press('ControlOrMeta+k');
  const search = page.getByRole('searchbox', {
    name: 'Buscar no acervo em uso',
  });
  await expect(search).toBeFocused();
  await search.fill('ritmo');
  await search.press('Enter');
  await expect(page).toHaveURL(/\/$/);
  await expectSummary(page, /documentos?/, 'Tudo');
  await shoot(page, 'shell-search');

  // In a field, the key belongs to the field: the focus stays and nothing is typed. A
  // desktop search page has no question box (chat-results): its field is the top bar's.
  const question = search;
  await question.fill('natureza');
  await question.press('ControlOrMeta+k');
  await expect(question).toBeFocused();
  await expect(question).toHaveValue('natureza');
});

test('AC-4: in a collection of texts only, nothing of audio shows', async ({
  page,
}) => {
  await page.goto('/');
  const title = await textOnlyCollection(page);
  await page.reload();
  await chooseCollection(page, title);
  const side = await library(page);
  await expect(collectionItem(side, title)).toHaveAttribute(
    'aria-current',
    'true',
  );
  // The chip by its whole name: a collection's row says "Acervo · 11 áudios" (v2).
  await expect(
    side.getByRole('button', { name: 'Áudios', exact: true }),
  ).toHaveCount(0);
  await expect(side.getByRole('link', { name: /Meus marcadores/ })).toHaveCount(
    0,
  );
  await expect(page.getByRole('region', { name: 'Player' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Mini-player' })).toHaveCount(
    0,
  );
  if (!desktop(page)) {
    await page.getByRole('button', { name: 'Fechar menu' }).click();
    const nav = page.getByRole('navigation', { name: 'Navegação' });
    await expect(nav.getByRole('listitem')).toHaveText([
      'Conversas',
      'Buscar',
      'Acervos',
    ]);
  }
  await shoot(page, 'shell-text-only');
});

test('AC-5: on a phone the last item of a long list stays above the navigation', async ({
  page,
}) => {
  test.skip(desktop(page), 'Phones only.');
  await page.goto('/');
  const tabs = page.getByRole('navigation', { name: 'Navegação' });
  await tabs.getByRole('link', { name: 'Buscar' }).click();
  await page.getByLabel('Sua pergunta').fill('ritmo');
  await page.getByRole('button', { name: 'Buscar', exact: true }).click();
  await expectSummary(page, /documentos?/, 'Tudo');
  // One current tab: Buscar, never Conversas too though both open "/".
  await expect(tabs.locator('[aria-current="page"]')).toHaveText(['Buscar']);
  const last = page.locator('app-result-card').last();
  await last.scrollIntoViewIfNeeded();
  const nav = await tabs.boundingBox();
  const item = await last.boundingBox();
  expect(item && nav && item.y + item.height <= nav.y).toBe(true);
  // The band behind the navigation is opaque: the page never shows through.
  const background = await page
    .locator('.shell-foot')
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toMatch(/rgba\(.*, 0\)/);
});

test('AC-6: a member sees neither "Pessoas e permissões" nor "Ver como"', async ({
  browser,
}) => {
  const email = uniqueEmail('membro-v2');
  const owner = await ownerApi();
  await invite(owner, email, { topics: ['hermetismo'], features: ['search'] });
  await owner.dispose();
  const member = await pageAs(browser, email, { width: 1440, height: 900 });
  await member.goto('/');
  await member.getByRole('button', { name: /^Conta de / }).click();
  const menu = member.getByRole('menu', { name: 'Conta' });
  await expect(
    menu.getByRole('menuitem', { name: 'Configurações' }),
  ).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Sair' })).toBeVisible();
  await expect(
    menu.getByRole('menuitem', { name: 'Pessoas e permissões' }),
  ).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'Ver como' })).toHaveCount(0);
  await expect(
    member.locator('app-top-bar').getByRole('button', { name: /Pessoas/ }),
  ).toHaveCount(0);
  await member.context().close();
});

test('AC-6 (master): the avatar menu has every v1 entry', async ({ page }) => {
  test.skip(!desktop(page), 'The avatar menu is the desktop top bar.');
  await page.goto('/');
  await page.getByRole('button', { name: /^Conta de / }).click();
  const menu = page.getByRole('menu', { name: 'Conta' });
  for (const name of [
    'Configurações',
    'Pessoas e permissões',
    'Ver como',
    'Sair',
  ])
    await expect(menu.getByRole('menuitem', { name })).toBeVisible();
  await expect(
    menu.getByRole('menuitem', {
      name: 'Como usar a Nova Alexandria (abre em nova aba)',
    }),
  ).toHaveAttribute('href', '/tutorial');
  await shoot(page, 'shell-account-menu');
  await page.keyboard.press('Escape');
  await openSettings(page);
  // Configurações is a page (KBC-131).
  await expect(page).toHaveURL(/\/configuracoes/);
  await expect(
    page.getByRole('region', { name: 'Configurações' }),
  ).toBeVisible();
});

test('AC-7: choosing Cabala in Sua biblioteca makes it the collection in use', async ({
  page,
}) => {
  await page.goto('/');
  const title = await textOnlyCollection(page);
  await page.reload();
  await chooseCollection(page, title);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(title);
  const side = await library(page);
  await expect(collectionItem(side, title)).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(collectionItem(side, 'Hermetismo')).not.toHaveAttribute(
    'aria-current',
  );
});

test('AC-8: acting as a person, the blue band is on every page', async ({
  page,
  browser,
}) => {
  const email = uniqueEmail('ana-v2');
  const owner = await ownerApi();
  const id = await invite(owner, email, {
    topics: ['hermetismo'],
    features: ['search'],
  });
  await owner.dispose();
  // Acting needs a person who signed in once.
  const person = await pageAs(browser, email, {
    width: 390,
    height: 844,
  });
  await person.context().close();
  const started = await page.request.post(`/api/v1/people/${id}/act-as`, {
    headers: CSRF,
    data: { reason: `Ver a casca v2 ${randomUUID().slice(0, 6)}` },
  });
  expect(started.ok(), await started.text()).toBe(true);
  for (const path of ['/', '/catalogo-ui']) {
    await page.goto(path);
    await expect(
      // The band's words on screen ("Vendo como …" on a phone), not its status line.
      page.locator('app-acting-banner .what >> visible=true').first(),
    ).toContainText(/endo como/);
  }
  await page.goto('/');
  await expect(
    // The band's words on screen ("Vendo como …" on a phone), not its status line.
    page.locator('app-acting-banner .what >> visible=true').first(),
  ).toContainText(/endo como/);
  await expect(page.getByLabel('Sua pergunta')).toBeVisible();
  // The band and the shell share one screen: the page itself never scrolls.
  expect(
    await page.evaluate(
      () => document.documentElement.scrollHeight <= window.innerHeight,
    ),
  ).toBe(true);
  await shoot(page, 'shell-acting');
  await page.getByRole('button', { name: 'Voltar para a minha conta' }).click();
  await expect(page.getByText(/Você está vendo como/)).toHaveCount(0);
});

/** A menu is whole on screen and on top: its box inside the viewport, its items hit by a click. */
async function expectWholeOnTop(page: Page, menuName: string): Promise<void> {
  const menu = page.getByRole('menu', { name: menuName });
  await expect(menu).toBeVisible();
  expect(await menu.evaluate((el) => el.matches(':popover-open'))).toBe(true);
  const box = await menu.boundingBox();
  const size = page.viewportSize();
  expect(box && size).toBeTruthy();
  if (!box || !size) return;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(size.width);
  expect(box.y + box.height).toBeLessThanOrEqual(size.height);
  // Nothing covers or clips the items: the point under each one is the item itself.
  // Actions and choices (an order) alike.
  for (const item of await menu.locator('[role^="menuitem"]').all()) {
    const hit = await item.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(
        r.left + r.width / 2,
        r.top + r.height / 2,
      );
      return at !== null && el.contains(at);
    });
    expect(hit).toBe(true);
  }
}

/** The head's line holds "Sua biblioteca" (whole), "+ Nova conversa" and ⤢, none over another. */
async function expectLibraryHeadWhole(
  page: Page,
  side: Locator,
): Promise<void> {
  const title = side.getByRole('button', { name: 'Recolher Sua biblioteca' });
  const head = [
    title,
    side.getByRole('button', { name: 'Nova conversa', exact: true }),
    side.getByRole('button', { name: 'Ampliar Sua biblioteca' }),
  ];
  const boxes = await Promise.all(head.map((one) => one.boundingBox()));
  const aside = await side.boundingBox();
  const edges = boxes.map((box) => (box ? box.x + box.width : Infinity));
  expect(boxes.every((box) => box !== null)).toBe(true);
  expect(Math.max(...edges)).toBeLessThanOrEqual(
    (aside?.x ?? 0) + (aside?.width ?? 0),
  );
  for (const [at, edge] of edges.slice(0, -1).entries())
    expect(edge).toBeLessThanOrEqual(boxes[at + 1]?.x ?? 0);
  expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await shoot(page, 'shell-library-head');
}

test('D5: "Recentes" and the avatar menu open whole, over the sidebar, inside the viewport; a conversation and a collection are created apart (KBC-164)', async ({
  page,
}) => {
  await page.goto('/');
  const side = await library(page);
  // No "+ Criar" menu (KBC-164): "Nova conversa" is a button of its own, "Novo acervo" the
  // "+" of the Acervos head, at both widths.
  await expect(
    side.getByRole('button', { name: 'Criar', exact: true }),
  ).toHaveCount(0);
  await expect(
    side.getByRole('button', { name: 'Nova conversa', exact: true }),
  ).toBeVisible();
  await expect(
    side
      .getByRole('group', { name: /^Acervos/ })
      .getByRole('button', { name: 'Novo acervo', exact: true }),
  ).toBeVisible();
  if (desktop(page)) await expectLibraryHeadWhole(page, side);

  const order = side.getByRole('button', { name: /Ordenar por/ });
  await order.click();
  await expectWholeOnTop(page, 'Ordenar');
  // The order is a choice: the current one is checked, and the open menu passes axe.
  await expect(
    page.getByRole('menuitemradio', { name: 'Recentes' }),
  ).toHaveAttribute('aria-checked', 'true');
  await expect(
    page.getByRole('menuitemradio', { name: 'Ordem alfabética' }),
  ).toHaveAttribute('aria-checked', 'false');
  expect(await seriousViolations(page)).toEqual([]);
  await shoot(page, 'shell-order-menu');
  await page.getByRole('menuitemradio', { name: 'Ordem alfabética' }).click();
  await expect(page.getByRole('menu', { name: 'Ordenar' })).toBeHidden();
  // Back on the trigger, not lost on the page (APG menu button).
  await expect(order).toBeFocused();
  await order.click();
  await expect(
    page.getByRole('menuitemradio', { name: 'Ordem alfabética' }),
  ).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');

  if (desktop(page)) {
    await page.getByRole('button', { name: /^Conta de / }).click();
    await expectWholeOnTop(page, 'Conta');
    await page.keyboard.press('Escape');
    // Collapsed to its covers, the 72 px column keeps "+ Nova conversa" as its "+".
    await page.getByRole('button', { name: 'Recolher Sua biblioteca' }).click();
    await expect(
      side.getByRole('button', { name: 'Nova conversa', exact: true }),
    ).toBeVisible();
    await shoot(page, 'shell-new-conversation-collapsed');
    await page.getByRole('button', { name: 'Expandir Sua biblioteca' }).click();
  }
});

test('D5: Sua biblioteca keeps Fixados, Acervos and Conversas apart, each with its heading, count and caret', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByLabel('Sua pergunta')
    .fill(`ritmo d5-${randomUUID().slice(0, 6)}`);
  await page.getByRole('button', { name: 'Perguntar' }).click();
  const side = await library(page);
  const collections = side.getByRole('heading', {
    name: /^Acervos \d+$/,
    level: 2,
  });
  const conversations = side.getByRole('heading', {
    name: /^Conversas \d+$/,
    level: 2,
  });
  await expect(collections).toBeVisible();
  await expect(conversations).toBeVisible();
  // Conversations are rows under a recency label with the neutral chat cover (v2 · Sua
  // biblioteca), never a collection's cover with its initials.
  const history = side.getByRole('navigation', { name: 'Conversas' });
  await expect(history.getByText('Hoje', { exact: true })).toBeVisible();
  await expect(
    history.locator('ui-cover:not(.conversation-cover)'),
  ).toHaveCount(0);
  await expect(
    history.locator('ui-cover.conversation-cover').first(),
  ).toBeVisible();
  await expect(history.getByRole('button').first()).toContainText('IA');
  await expect(
    side.locator('#library-collections ui-cover').first(),
  ).toBeVisible();
  await shoot(page, 'shell-library-sections');
  // A long library scrolls in its own column: the page itself never grows past the screen.
  if (desktop(page))
    expect(
      await page.evaluate(
        () => document.documentElement.scrollHeight <= window.innerHeight,
      ),
    ).toBe(true);

  // The caret folds a section and says so; a second click brings it back.
  const toggle = conversations.getByRole('button');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(history).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(history).toBeVisible();

  // A chip shows its section alone.
  await side.getByRole('button', { name: 'Conversas', exact: true }).click();
  await expect(collections).toHaveCount(0);
  await expect(conversations).toBeVisible();
  await side.getByRole('button', { name: 'Acervos', exact: true }).click();
  await expect(conversations).toHaveCount(0);
  await expect(collections).toBeVisible();
  await side.getByRole('button', { name: 'Acervos', exact: true }).click();
  expect(await seriousViolations(page)).toEqual([]);
});
