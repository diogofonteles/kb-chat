import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

/** KBC-032: the public "how to use" guide with real screenshots, at 1440 and 390. */
const shots = process.env['KBC_SHOTS'];
async function shoot(page: Page, name: string): Promise<void> {
  if (shots)
    await page.screenshot({
      path: `${shots}/${name}-${page.viewportSize()?.width}.png`,
      fullPage: true,
    });
}

const SECTIONS = [
  'O que é a Nova Alexandria',
  'Entrar',
  'Buscar documentos (sem IA)',
  'Pesquisa com IA',
  'Histórico de conversas',
  'Sua IA',
  'Preferências',
  'Para administradores',
  'Perguntas frequentes',
];

const seriousViolations = async (page: Page): Promise<string[]> =>
  (await new AxeBuilder({ page }).analyze()).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.help}`);

test.describe('signed out', () => {
  test.use({ signedInAs: null });

  test('AC-1, AC-3: /tutorial opens without a session, every section and picture is there, no serious axe violations', async ({
    page,
  }) => {
    await page.goto('/tutorial');

    await expect(page).toHaveTitle('Como usar — Nova Alexandria');
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'Como usar a Nova Alexandria',
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Fazer login com o Google' }),
    ).toHaveCount(0);
    for (const section of SECTIONS)
      await expect(
        page.getByRole('heading', { level: 2, name: section }),
      ).toBeAttached();
    const images = page.locator('main img');
    expect(await images.count()).toBeGreaterThanOrEqual(15);
    for (const image of await images.all()) {
      await image.scrollIntoViewIfNeeded();
      await expect
        .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
        .toBeGreaterThan(0);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    ).toBeLessThanOrEqual(0);
    expect(await seriousViolations(page)).toEqual([]);
    await shoot(page, 'tutorial');
  });

  test('AC-2: a link to a section opens there with the focus on its title; the contents lead to each section', async ({
    page,
  }) => {
    await page.goto('/tutorial#pesquisa-com-ia');
    const research = page.getByRole('heading', {
      level: 2,
      name: 'Pesquisa com IA',
    });
    await expect(research).toBeFocused();
    await expect(research).toBeInViewport();

    await page.goto('/tutorial');
    await page
      .getByRole('navigation', { name: 'Nesta página' })
      .getByRole('link', { name: 'Para administradores' })
      .click();
    await expect(page).toHaveURL(/\/tutorial#administradores$/);
    const admins = page.getByRole('heading', {
      level: 2,
      name: 'Para administradores',
    });
    await expect(admins).toBeFocused();
    await expect(admins).toBeInViewport();
    await expect(page.getByText('Só para administradores')).toBeVisible();
  });

  test('AC-4: the login and the privacy policy lead to the tutorial, and it leads back', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Como usar' }).click();
    await expect(page).toHaveURL(/\/tutorial$/);
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'Como usar a Nova Alexandria',
      }),
    ).toBeVisible();

    await page.getByRole('link', { name: 'Política de privacidade' }).click();
    await expect(page).toHaveURL(/\/privacidade$/);
    await page
      .getByRole('link', { name: 'Como usar a Nova Alexandria' })
      .click();
    await expect(page).toHaveURL(/\/tutorial$/);

    await page.getByRole('link', { name: 'Voltar à Nova Alexandria' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Nova Alexandria' }),
    ).toBeVisible();
  });
});

test('AC-4: the help in the app header opens the tutorial in a new tab and keeps the conversation', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByLabel('Sua pergunta')).toBeVisible();
  const [tutorial] = await Promise.all([
    page.context().waitForEvent('page'),
    page
      .getByRole('link', {
        name: 'Como usar a Nova Alexandria (abre em nova aba)',
      })
      .click(),
  ]);

  await expect(
    tutorial.getByRole('heading', {
      level: 1,
      name: 'Como usar a Nova Alexandria',
    }),
  ).toBeVisible();
  await expect(page.getByLabel('Sua pergunta')).toBeVisible();
  await tutorial.close();
});
