import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { OWNER_EMAIL, expect, test } from './fixtures.js';

/** KBC-016: the public privacy policy that Google's consent screen links to, at 1440 and 390. */
const shots = process.env['KBC_SHOTS'];
async function shoot(page: Page, name: string): Promise<void> {
  if (shots)
    await page.screenshot({
      path: `${shots}/${name}-${page.viewportSize()?.width}.png`,
      fullPage: true,
    });
}

test.describe('signed out', () => {
  test.use({ signedInAs: null });

  test('AC-7: /privacidade opens without a session, names the contact and has no serious axe violations', async ({
    page,
  }) => {
    await page.goto('/privacidade');

    await expect(page).toHaveTitle('Privacidade — Nova Alexandria');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Política de privacidade' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Fazer login com o Google' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('heading', { level: 2, name: 'Quem participa' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: OWNER_EMAIL })).toHaveAttribute(
      'href',
      `mailto:${OWNER_EMAIL}`,
    );
    await expect(page.getByText(/Última atualização/)).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(
      results.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => `${v.id}: ${v.help}`),
    ).toEqual([]);
    await shoot(page, 'privacy');
  });

  test('AC-8: the login links to the policy and the policy leads back to the login', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page).toHaveTitle('Nova Alexandria');

    await page.getByRole('link', { name: 'Privacidade' }).click();
    await expect(page).toHaveURL(/\/privacidade$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Política de privacidade' }),
    ).toBeVisible();

    await page.getByRole('link', { name: 'Voltar à Nova Alexandria' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Nova Alexandria' }),
    ).toBeVisible();
    await expect(page).toHaveTitle('Nova Alexandria');

    await page.goBack();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Política de privacidade' }),
    ).toBeVisible();
    await page.goBack();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Nova Alexandria' }),
    ).toBeVisible();
  });
});

test('a signed-in person also reads the policy and goes back to the chat', async ({
  page,
}) => {
  await page.goto('/privacidade');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Política de privacidade' }),
  ).toBeVisible();

  await expect(page).toHaveTitle('Privacidade — Nova Alexandria');

  await page.getByRole('link', { name: 'Voltar à Nova Alexandria' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByLabel('Sua pergunta')).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Política de privacidade' }),
  ).toHaveCount(0);
  await expect(page).toHaveTitle('Nova Alexandria');
});
