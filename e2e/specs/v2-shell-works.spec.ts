import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import {
  expectKeyboardScrolls,
  expectScrolls,
  scrollSettled,
  shortWindow,
} from './scroll-helpers.js';
import { desktop, library } from './shell-helpers.js';

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
    if (desktop(page)) {
      // At the column's foot before and after the rows scroll.
      // Both boxes in one frame: the player bar may still be coming in (it takes 72 off
      // the column once the audio presence answers).
      const atFoot = () =>
        side.evaluate((column) => {
          const foot = column.querySelector('.spend')!.getBoundingClientRect();
          return Math.round(
            column.getBoundingClientRect().bottom - foot.bottom,
          );
        });
      await expect(spend).toBeInViewport();
      await expect.poll(atFoot).toBe(0);
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
    await expect(page.getByText(/documentos? · Tudo ·/)).toBeVisible();

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
});
