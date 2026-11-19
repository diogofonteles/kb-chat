import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test, uniqueEmail } from './fixtures.js';

/**
 * KBC-124: the v2 foundation at 1440 and 390 (one project each): the revised theme by
 * default, the entry screens and the public pages in v2, and the component catalog under axe.
 */
const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

const shots = process.env['KBC_SHOTS'];
async function shoot(page: Page, name: string): Promise<void> {
  if (shots)
    await page.screenshot({
      path: `${shots}/${name}-${page.viewportSize()?.width}.png`,
      fullPage: false,
    });
}

/** Serious or critical axe violations only (KBC-124 NFR-1). */
async function seriousViolations(page: Page, include?: string) {
  const builder = new AxeBuilder({ page });
  if (include) builder.include(include);
  const { violations } = await builder.analyze();
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
    );
}

test.describe('signed out', () => {
  test.use({ signedInAs: null });

  test('AC-1: with no theme saved, the entry screen opens in the revised theme', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(
      page.getByRole('button', { name: 'Fazer login com o Google' }),
    ).toBeVisible();
    await expect(page.locator('html')).not.toHaveAttribute('data-theme');
    // The revised background, not the v1 one (#1f1e1c / #f7f5f0).
    const background = await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--color-bg')
        .trim(),
    );
    expect(background).toBe('#121212');
    const font = await page.evaluate(
      () => getComputedStyle(document.body).fontFamily,
    );
    expect(font).toMatch(/^Figtree/);
    await shoot(page, 'auth-login');
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('AC-1: a saved "Claro" stays light', async ({ page }) => {
    await page.addInitScript(() =>
      localStorage.setItem('kb-chat.theme', 'light'),
    );
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('AC-3: without the Google script, a banner with "Tentar de novo" and the code sign-in stays', async ({
    page,
  }) => {
    await page.context().unroute('https://accounts.google.com/**');
    await page
      .context()
      .route('https://accounts.google.com/**', (route) => route.abort());
    await page.goto('/');
    const banner = page.getByRole('alert');
    await expect(banner).toContainText(
      'Não consegui carregar o botão do Google.',
    );
    await expect(
      banner.getByRole('button', { name: 'Tentar de novo' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Entrar com código' }),
    ).toBeEnabled();
    await shoot(page, 'auth-login-unavailable');
  });

  test('AC-4: a pasted code fills the 6 boxes and turns on "Entrar"; Backspace goes back', async ({
    page,
  }) => {
    // The boxes are what is tested: the send is answered here, so the API's rate limit on
    // code requests (shared by the whole run) never decides this test.
    await page.route('**/api/v1/auth/code', (route) =>
      route.fulfill({ status: 202, body: '' }),
    );
    await page.goto('/');
    await page.getByRole('button', { name: 'Entrar com código' }).click();
    await page.getByLabel('Seu e-mail').fill(uniqueEmail('v2-code'));
    await page.getByRole('button', { name: 'Enviar código' }).click();
    const first = page.getByLabel('Dígito 1 de 6');
    await expect(first).toBeFocused();
    const enter = page.getByRole('button', { name: 'Entrar', exact: true });
    await expect(enter).toBeDisabled();
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData('text', '481920');
      document.activeElement?.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true }),
      );
    });
    for (const [n, digit] of [...'481920'].entries())
      await expect(page.getByLabel(`Dígito ${n + 1} de 6`)).toHaveValue(digit);
    await expect(enter).toBeEnabled();
    await shoot(page, 'auth-code-code');

    const sixth = page.getByLabel('Dígito 6 de 6');
    await sixth.press('Backspace');
    await expect(sixth).toHaveValue('');
    await sixth.press('Backspace');
    await expect(page.getByLabel('Dígito 5 de 6')).toBeFocused();
    await expect(page.getByLabel('Dígito 5 de 6')).toHaveValue('');
  });

  test('AC-5: the access request shows each error under its field and focuses the first', async ({
    page,
  }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: 'Pedir acesso sem conta Google' })
      .click();
    await page.getByRole('button', { name: 'Enviar código' }).click();
    await expect(page.getByLabel('E-mail')).toBeFocused();
    await expect(page.getByText('Digite seu nome.')).toBeVisible();
    await expect(page.getByLabel('Celular')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await shoot(page, 'auth-signup-errors');
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('AC-9: v2 keeps every entry action of v1', async ({ page }) => {
    await page.goto('/');
    for (const name of [
      'Fazer login com o Google',
      'Entrar com código',
      'Pedir acesso sem conta Google',
    ])
      await expect(page.getByRole('button', { name })).toBeVisible();
    for (const name of ['Como usar', 'Privacidade'])
      await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
  });

  test('AC-7: the privacy index marks the section on screen; on a phone it is a row of chips', async ({
    page,
  }) => {
    await page.goto('/privacidade');
    const index = page.getByRole('navigation', { name: 'Nesta página' });
    const retention = index.getByRole('link', { name: 'Por quanto tempo' });
    await retention.click();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Por quanto tempo' }),
    ).toBeInViewport();
    await expect(retention).toHaveAttribute('aria-current', 'location');
    if (!desktop(page)) {
      // A chip: a pill in a horizontal row.
      const box = await index.getByRole('list').boundingBox();
      expect(box?.height ?? 0).toBeLessThan(60);
    }
    await shoot(page, 'public-privacy');
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('the tutorial is a reading page with the index and figure cards', async ({
    page,
  }) => {
    await page.goto('/tutorial');
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'Como usar a Nova Alexandria',
      }),
    ).toBeVisible();
    await expect(
      page
        .getByRole('navigation', { name: 'Nesta página' })
        .getByRole('link', { name: 'Entrar', exact: true }),
    ).toBeVisible();
    await shoot(page, 'public-tutorial');
    expect(await seriousViolations(page)).toEqual([]);
  });
});

test('AC-8: every component of the catalog passes axe, with a visible focus', async ({
  page,
}) => {
  await page.goto('/catalogo-ui');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Componentes' }),
  ).toBeVisible();
  await shoot(page, 'ui-catalog');
  expect(await seriousViolations(page, 'app-ui-catalog-page')).toEqual([]);
  for (const theme of ['light', 'dark', 'esoteric']) {
    await page.evaluate(
      (name) => document.documentElement.setAttribute('data-theme', name),
      theme,
    );
    // The buttons ease into the new theme's colours: measured once they got there.
    await page.evaluate(() =>
      Promise.all(
        document.getAnimations().map((animation) => animation.finished),
      ),
    );
    expect(
      await seriousViolations(page, 'app-ui-catalog-page'),
      `theme ${theme}`,
    ).toEqual([]);
  }
  await page.evaluate(() =>
    document.documentElement.removeAttribute('data-theme'),
  );
  const save = page.getByRole('button', { name: 'Salvar', exact: true });
  await save.focus();
  const outline = await save.evaluate(
    (element) => getComputedStyle(element).outlineStyle,
  );
  expect(outline).not.toBe('none');

  // The catalog's own "Conta" (exact): the shell's avatar is "Conta de <nome>" (KBC-125).
  await page.getByRole('button', { name: 'Conta', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Conta' });
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(
    menu.getByRole('menuitem', { name: 'Pessoas e permissões' }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(
    page.getByRole('button', { name: 'Conta', exact: true }),
  ).toBeFocused();

  await page.getByRole('button', { name: 'Abrir modal' }).click();
  const dialog = page.getByRole('dialog', { name: 'Editar detalhes' });
  await expect(dialog).toBeVisible();
  await shoot(page, 'ui-catalog-dialog');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
