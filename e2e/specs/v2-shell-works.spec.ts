import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import {
  expectKeyboardScrolls,
  expectScrolls,
  scrollSettled,
  shortWindow,
} from './scroll-helpers.js';
import { desktop, library } from './shell-helpers.js';
import { expectSummary } from './search-view.js';

/** The rows a filter leaves: at least one, each named after what was typed. */
async function expectOnlyNamed(rows: Locator, name: RegExp): Promise<void> {
  await expect(rows.first()).toBeVisible();
  await expect(rows.filter({ hasNotText: name })).toHaveCount(0);
  await expect(rows.filter({ hasText: /alquimia/i })).toHaveCount(0);
}

/**
 * KBC-124/KBC-125, v2 fidelity: the shell, the entry screens and the public pages do not only
 * look like the Figma frames, they work. At 1440 and 390 (and in WebKit with
 * KBC_E2E_WEBKIT=1): the text scrolls with the wheel, a finger and the keyboard, every control
 * on screen answers, the fields take what is typed and every menu or sheet opens and closes.
 */

test.describe('public pages', () => {
  test.use({ signedInAs: null });

  for (const { path, title, last, other } of [
    {
      path: '/privacidade',
      title: 'Política de privacidade',
      last: 'Seus direitos',
      other: 'Como usar',
    },
    {
      path: '/tutorial',
      title: 'Como usar a Nova Alexandria',
      last: 'Perguntas frequentes',
      other: 'Privacidade',
    },
  ]) {
    test(`${path} scrolls by wheel or touch and keyboard, and its index and bar lead on`, async ({
      page,
    }) => {
      await page.goto(path);
      const heading = page.getByRole('heading', { level: 1, name: title });
      await expect(heading).toBeVisible();
      const column = page.locator('app-reading-page .column');
      await expectScrolls(page, column);
      await page.evaluate(() => window.scrollTo(0, 0));
      await expectKeyboardScrolls(page, heading);
      await scrollSettled(page);

      // The index (a column on desktop, chips on a phone) takes to the section and its title.
      const index = page.getByRole('navigation', { name: 'Nesta página' });
      await index.getByRole('link', { name: last }).click();
      const section = page.getByRole('heading', { level: 2, name: last });
      await expect(section).toBeInViewport();
      await expect(section).toBeFocused();
      await expect(index.getByRole('link', { name: last })).toHaveAttribute(
        'aria-current',
        'location',
      );

      // The bar: the other public page (desktop) and "Entrar" back to the entry screen.
      const bar = page.locator('app-reading-page .bar');
      if (desktop(page)) {
        await bar.getByRole('link', { name: other, exact: true }).click();
        await expect(page).not.toHaveURL(new RegExp(`${path}$`));
        await page.goBack();
        await expect(heading).toBeVisible();
      }
      await bar.getByRole('link', { name: 'Entrar', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Entrar com código' }),
      ).toBeVisible();
    });
  }

  test('/privacidade names the contact beside the text on desktop, in its rights on a phone', async ({
    page,
  }) => {
    await page.goto('/privacidade');
    const card = page.getByRole('complementary', { name: 'Contato' });
    if (desktop(page)) {
      await expect(card).toBeVisible();
      await expect(card.getByRole('link', { name: /@/ })).toHaveAttribute(
        'href',
        /^mailto:/,
      );
    } else await expect(card).toBeHidden();
    await expect(
      page.locator('#privacy-rights ~ p').getByRole('link', { name: /@/ }),
    ).toHaveAttribute('href', /^mailto:/);
  });
});

test.describe('entry screens', () => {
  test.use({ signedInAs: null });

  test('on a short window the sign-up form scrolls, takes what is typed and goes back', async ({
    page,
  }) => {
    await shortWindow(page);
    await page.goto('/');
    await page
      .getByRole('button', { name: 'Pedir acesso sem conta Google' })
      .click();
    const title = page.getByRole('heading', {
      name: 'Pedir acesso sem conta Google',
    });
    await expect(title).toBeVisible();
    await expectScrolls(page, page.locator('app-login-page .column'), 300);

    await page.getByLabel('E-mail').fill('ana.lima@');
    await page.getByLabel('Nome', { exact: true }).fill('Ana');
    await page.getByLabel('Sobrenome').fill('Lima');
    await page.getByLabel(/^Celular/).fill('81999990000');
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue('Ana');
    // Side by side on a phone too (v2 · Auth).
    const first = await page.getByLabel('Nome', { exact: true }).boundingBox();
    const last = await page.getByLabel('Sobrenome').boundingBox();
    expect(Math.abs((first?.y ?? 0) - (last?.y ?? 1))).toBeLessThan(2);
    await page.getByRole('button', { name: 'Enviar código' }).click();
    await expect(
      page.getByText('Digite um e-mail válido, como nome@exemplo.com.'),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Voltar' }).click();
    await expect(
      page.getByRole('button', { name: 'Entrar com código' }),
    ).toBeVisible();
  });

  test('the code sign-in takes the e-mail and the digits, and every link of the step answers', async ({
    page,
  }) => {
    await page.route('**/api/v1/auth/code', (route) =>
      route.fulfill({ status: 202, json: {} }),
    );
    await page.goto('/');
    await page.getByRole('button', { name: 'Entrar com código' }).click();
    await page.getByLabel('Seu e-mail').fill('ana.lima@exemplo.test');
    await page.getByRole('button', { name: 'Enviar código' }).click();
    const sent = page.getByRole('status').filter({ hasText: 'Se houver' });
    await expect(sent.locator('strong')).toHaveText('ana.lima@exemplo.test');
    await page.getByLabel('Dígito 1 de 6').click();
    await page.keyboard.type('481');
    await expect(page.getByLabel('Dígito 3 de 6')).toHaveValue('1');
    await expect(page.getByLabel('Dígito 4 de 6')).toBeFocused();
    await expect(page.getByRole('button', { name: 'Entrar' })).toBeDisabled();
    await page.getByRole('button', { name: 'Trocar e-mail' }).click();
    await expect(page.getByLabel('Seu e-mail')).toBeVisible();
    await page.getByRole('button', { name: 'Voltar' }).click();

    // The footer leads to both public pages.
    await expect(
      page.getByRole('link', { name: 'Como usar', exact: true }),
    ).toHaveAttribute('href', '/tutorial');
    await page.getByRole('link', { name: 'Privacidade', exact: true }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Política de privacidade' }),
    ).toBeVisible();
  });
});

/** The rows of Sua biblioteca, on desktop the column, on a phone the Menu. */
async function rows(page: Page) {
  return (await library(page)).locator('.sections');
}

test.describe('the shell', () => {
  test('Sua biblioteca scrolls its rows and keeps the AI spend at its foot', async ({
    page,
  }) => {
    await shortWindow(page);
    await page.goto('/');
    await expect(page.getByLabel('Sua pergunta')).toBeVisible();
    const side = await library(page);
    const spend = side.getByText('Gasto com IA hoje');
    // The rows to scroll are the collections': the column (its foot, the spend) is drawn
    // before they come, and a wheel over an empty list moves nothing.
    await expect(
      side
        .getByRole('group', { name: /^Acervos/ })
        .getByRole('listitem')
        .first(),
    ).toBeVisible();
    if (desktop(page)) {
      // At the column's foot before and after the rows scroll.
      // Both boxes in one frame: the player bar may still be coming in (it takes 72 off
      // the column once the audio presence answers).
      const atFoot = () =>
        side.evaluate((column) => {
          const foot = column.querySelector('.spend')?.getBoundingClientRect();
          if (!foot) return null;
          return Math.round(
            column.getBoundingClientRect().bottom - foot.bottom,
          );
        });
      await expect(spend).toBeInViewport();
      await expect.poll(atFoot).toBe(0);
      // The column ends 8 above the player bar, or 8 above the window's foot without one
      // (v2 · a collection of texts: no empty foot row).
      const gapBelow = () =>
        side.evaluate((column) => {
          const bar = document.querySelector('app-mini-player section.bar');
          const below = bar
            ? bar.getBoundingClientRect().top
            : window.innerHeight;
          return Math.round(below - column.getBoundingClientRect().bottom);
        });
      await expect.poll(gapBelow).toBe(8);
      await expectScrolls(page, await rows(page), 300);
      await expect(spend).toBeInViewport();
      expect(await atFoot()).toBe(0);
    } else {
      // The phone's Menu scrolls as one sheet and closes again.
      await expectScrolls(page, side, 300);
      await page.keyboard.press('Escape');
      await expect(side).toBeHidden();
    }
  });

  test('every control of the top bar answers (desktop)', async ({ page }) => {
    test.skip(!desktop(page), 'The top bar is the desktop one.');
    await page.goto('/');
    await expect(page.getByLabel('Sua pergunta')).toBeVisible();
    await page.goto('/configuracoes');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Configurações' }),
    ).toBeVisible();
    const bar = page.locator('app-top-bar');
    await bar.getByRole('button', { name: 'Voltar' }).click();
    await expect(page).toHaveURL(/\/$/);
    await bar.getByRole('button', { name: 'Avançar' }).click();
    await expect(page).toHaveURL(/\/configuracoes$/);
    await bar.getByRole('button', { name: 'Início' }).click();
    await expect(page.getByLabel('Sua pergunta')).toBeVisible();

    const search = bar.getByRole('searchbox', {
      name: 'Buscar no acervo em uso',
    });
    await search.fill('ritmo');
    await expect(search).toHaveValue('ritmo');
    await search.press('Enter');
    await expectSummary(page, /documentos?/, 'Tudo');
    // The field holds the search; ✕ in place of ⌘K empties it (v2 · Conversa).
    await expect(search).toHaveValue('ritmo');
    await bar.getByRole('button', { name: 'Limpar a busca' }).click();
    await expect(search).toHaveValue('');
    await expect(search).toBeFocused();
    await expect(
      bar.getByRole('button', { name: 'Limpar a busca' }),
    ).toHaveCount(0);

    await bar.getByRole('button', { name: /^Conta de / }).click();
    await expect(page.getByRole('menu', { name: 'Conta' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: 'Conta' })).toBeHidden();

    const side = await library(page);
    await side.getByRole('button', { name: 'Recolher Sua biblioteca' }).click();
    await expect(side.getByText('Gasto com IA hoje')).toBeHidden();
    await side.getByRole('button', { name: 'Expandir Sua biblioteca' }).click();
    await expect(side.getByText('Gasto com IA hoje')).toBeVisible();

    // The chips show one section at a time and come back to all.
    const chips = side.getByRole('group', { name: 'Mostrar' });
    await chips.getByRole('button', { name: 'Conversas' }).click();
    await expect(side.getByRole('group', { name: /^Acervos/ })).toHaveCount(0);
    await chips.getByRole('button', { name: 'Conversas' }).click();
    await expect(side.getByRole('group', { name: /^Acervos/ })).toBeVisible();
  });

  test('on a phone the header Menu and every tab of the navigation answer', async ({
    page,
  }) => {
    test.skip(desktop(page), 'The navigation is the phone one.');
    await page.goto('/');
    await expect(page.getByLabel('Sua pergunta')).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Navegação' });
    const menu = page.getByRole('dialog', { name: 'Menu' });
    // The header's avatar opens the Menu on every page.
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await expect(menu).toBeVisible();
    await menu.getByRole('button', { name: 'Fechar menu' }).click();
    await expect(menu).toBeHidden();
    // The tabs follow the audio rule (BR-2): Acervos opens the Menu in a collection of
    // texts; with audio, Biblioteca and Fila (or Acervos) are pages of their own.
    const tabs = nav.locator('.tab:visible');
    const labels = (await tabs.allInnerTexts()).map((t) => t.trim());
    expect(labels.slice(0, 2)).toEqual(['Conversas', 'Buscar']);
    expect(labels.length).toBeGreaterThanOrEqual(3);
    for (const label of labels.slice(2)) {
      const tab = tabs.filter({ hasText: label });
      if ((await tab.evaluate((e) => e.tagName)) === 'BUTTON') {
        await tab.click();
        await expect(menu).toBeVisible();
        await menu.getByRole('button', { name: 'Fechar menu' }).click();
        await expect(menu).toBeHidden();
      } else {
        await tab.click();
        await expect(tab).toHaveAttribute('aria-current', 'page');
      }
    }
    await nav.getByRole('link', { name: 'Buscar' }).click();
    await expect(page.getByLabel('Sua pergunta')).toBeVisible();
    await nav.getByRole('link', { name: 'Conversas' }).click();
    await expect(nav.getByRole('link', { name: 'Conversas' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('Início is on at home, the bell opens and ⤢ shows Sua biblioteca expandida (desktop)', async ({
    page,
  }) => {
    test.skip(
      !desktop(page),
      'The top bar and the column are the desktop ones.',
    );
    await page.goto('/');
    await expect(page.getByLabel('Sua pergunta')).toBeVisible();
    const bar = page.locator('app-top-bar');
    // v2 · Conversa vazia: Início filled on the conversation's home.
    await expect(bar.getByRole('button', { name: 'Início' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    // The bell lists what needs the person (or says nothing is new), and closes.
    await bar.getByRole('button', { name: /^Notificações/ }).click();
    const bell = page.getByRole('menu', { name: 'Notificações' });
    await expect(bell).toBeVisible();
    await expect(
      bell
        .getByText(/pedidos? de acesso|precisam? de atenção|Nada novo por aqui/)
        .first(),
    ).toBeVisible();
    const box = await bell.boundingBox();
    expect(box && box.x + box.width).toBeLessThanOrEqual(1440);
    await page.keyboard.press('Escape');
    await expect(bell).toBeHidden();

    // ⤢: the library in the main panel, its own search filters it, a row opens it.
    const side = await library(page);
    const widen = side.getByRole('button', { name: 'Ampliar Sua biblioteca' });
    await widen.click();
    await expect(widen).toHaveAttribute('aria-pressed', 'true');
    const wide = page.getByRole('region', { name: 'Sua biblioteca' });
    await expect(wide).toBeVisible();
    await expect(page.getByLabel('Sua pergunta')).toBeHidden();
    await expect(wide.getByText('Tipo', { exact: true })).toBeVisible();
    const filter = wide.getByRole('searchbox', {
      name: 'Filtrar Sua biblioteca',
    });
    await filter.fill('hermetismo');
    await expect(filter).toHaveValue('hermetismo');
    const rowsShown = wide.locator(
      'li.collection > .row > button.ui-libitem-row',
    );
    // Only collections named after it stay (other specs add "Hermetismo <tag>" ones).
    await expectOnlyNamed(rowsShown, /hermetismo/i);
    // The list scrolls inside the panel, not the page.
    await filter.fill('');
    const list = wide.locator('.sections');
    await list.hover();
    await page.mouse.wheel(0, 600);
    await expect
      .poll(() => list.evaluate((e) => e.scrollTop))
      .toBeGreaterThan(0);
    expect(
      await page.evaluate(() => document.scrollingElement?.scrollTop),
    ).toBe(0);
    // Every row has its ⋯ (v2 · Biblioteca expandida), its menu whole in the window.
    const rowMore = wide.getByRole('button', {
      name: 'Mais opções de Hermetismo',
      exact: true,
    });
    await rowMore.click();
    const rowMenu = page.getByRole('menu', {
      name: 'Mais opções de Hermetismo',
    });
    await expect(rowMenu).toBeVisible();
    const menuBox = await rowMenu.boundingBox();
    expect(menuBox && menuBox.x + menuBox.width).toBeLessThanOrEqual(1440);
    expect(menuBox && menuBox.y + menuBox.height).toBeLessThanOrEqual(900);
    await page.keyboard.press('Escape');
    await expect(rowMenu).toBeHidden();
    await expect(rowMore).toBeFocused();
    await rowMore.click();
    await rowMenu.getByRole('menuitem', { name: 'Abrir acervo' }).click();
    await expect(wide).toBeHidden();
    await expect(page.getByLabel('Sua pergunta')).toBeVisible();
    await widen.click();
    await expect(wide).toBeVisible();
    await rowsShown.first().click();
    await expect(wide).toBeHidden();
    await expect(widen).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByLabel('Sua pergunta')).toBeVisible();

    // ⤢ again closes it; so does Início.
    await widen.click();
    await expect(wide).toBeVisible();
    await widen.click();
    await expect(wide).toBeHidden();
    await widen.click();
    await bar.getByRole('button', { name: 'Início' }).click();
    await expect(wide).toBeHidden();
  });

  test('the phone Menu is the drawn list: chips, rows, then its action rows', async ({
    page,
  }) => {
    test.skip(desktop(page), 'The Menu is the phone one.');
    await page.goto('/');
    await expect(page.getByLabel('Sua pergunta')).toBeVisible();
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    const menu = page.getByRole('dialog', { name: 'Menu' });
    await expect(menu).toBeVisible();
    // v2 "Menu lateral aberto": no "Sua biblioteca · + Criar" row and no search row on top.
    await expect(
      menu.getByRole('button', { name: 'Criar', exact: true }),
    ).toHaveCount(0);
    await expect(menu.getByRole('group', { name: 'Mostrar' })).toBeVisible();
    // The drawn rows stay at the sheet's foot however long the list (12 collections here),
    // and the list scrolls under them by finger and by keyboard.
    for (const name of ['Novo acervo', 'Configurações']) {
      await expect(
        menu.getByRole('button', { name, exact: true }),
      ).toBeInViewport();
    }
    const sheet = menu.locator('.drawer-body');
    await sheet.hover();
    await page.mouse.wheel(0, 400);
    await expect
      .poll(() => sheet.evaluate((e) => e.scrollTop))
      .toBeGreaterThan(0);
    await expect(
      menu.getByRole('button', { name: 'Configurações', exact: true }),
    ).toBeInViewport();
    await sheet.evaluate((e) => e.scrollTo(0, 0));
    for (const name of [
      'Novo acervo',
      'Configurações',
      'Nova conversa',
      'Filtrar Sua biblioteca',
    ]) {
      await expect(
        menu.getByRole('button', { name, exact: true }),
      ).toBeVisible();
    }
    // The filter row opens the field, which takes the focus and what is typed.
    await menu
      .getByRole('button', { name: 'Filtrar Sua biblioteca', exact: true })
      .click();
    const field = menu.getByRole('searchbox', {
      name: 'Filtrar Sua biblioteca',
    });
    await expect(field).toBeFocused();
    await field.fill('hermetismo');
    await expectOnlyNamed(
      menu.locator('li.collection > .row > button.ui-libitem-row'),
      /hermetismo/i,
    );
    await field.fill('');
    // The order row opens its menu, whole on screen.
    await menu.getByRole('button', { name: /^Ordenar/ }).click();
    const order = page.getByRole('menu', { name: 'Ordenar' });
    await expect(order).toBeVisible();
    const box = await order.boundingBox();
    expect(box && box.y + box.height).toBeLessThanOrEqual(844);
    await order
      .getByRole('menuitemradio', { name: 'Ordem alfabética' })
      .or(order.getByRole('menuitem', { name: 'Ordem alfabética' }))
      .click();
    await expect(order).toBeHidden();
    // "Nova conversa" closes the Menu, ready to type.
    await menu
      .getByRole('button', { name: 'Nova conversa', exact: true })
      .click();
    await expect(menu).toBeHidden();
    await expect(page.getByLabel('Sua pergunta')).toBeVisible();
  });
});
