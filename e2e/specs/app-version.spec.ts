import AxeBuilder from '@axe-core/playwright';
import type { Page, TestInfo } from '@playwright/test';
import {
  comeBack,
  notice,
  playDeploys,
  shipNewVersion,
} from './app-version-helpers.js';
import { expect, test } from './fixtures.js';
import {
  openSettings as shellOpenSettings,
  startNewCollection,
} from './shell-helpers.js';

async function shot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({
    path: testInfo.outputPath(`${name}-${testInfo.project.name}.png`),
  });
}

test('AC-1: coming back to the tab after a deploy reloads it on the same page when nothing is in progress', async ({
  page,
}) => {
  const deploy = await playDeploys(page);
  await page.goto('/');
  const question = page.getByLabel('Sua pergunta');
  await expect(question).toBeVisible();
  const before = page.url();
  const loads = deploy.loads;

  shipNewVersion(deploy);
  await comeBack(page);

  await expect.poll(() => deploy.loads).toBe(loads + 1);
  expect(page.url()).toBe(before);
  await expect(question).toBeVisible();
  await expect(page.getByText('Nova versão disponível.')).toHaveCount(0);
});

test('AC-1: the same version keeps the page as it is', async ({ page }) => {
  const deploy = await playDeploys(page);
  await page.goto('/');
  await expect(page.getByLabel('Sua pergunta')).toBeVisible();
  const versionAsked = page.waitForResponse('**/version.json');
  await comeBack(page);
  await versionAsked;
  expect(deploy.loads).toBe(1);
  await expect(page.getByText('Nova versão disponível.')).toHaveCount(0);
});

const overlaps = (
  one: { x: number; y: number; width: number; height: number },
  other: { x: number; y: number; width: number; height: number },
): boolean =>
  one.x < other.x + other.width &&
  other.x < one.x + one.width &&
  one.y < other.y + other.height &&
  other.y < one.y + one.height;

test('AC-2: a question typed and not sent only gets "Nova versão disponível", which closes on "Agora não"', async ({
  page,
}, testInfo) => {
  const deploy = await playDeploys(page);
  await page.goto('/');
  const question = page.getByLabel('Sua pergunta');
  await question.fill('o que diz o princípio do ritmo?');

  shipNewVersion(deploy);
  await comeBack(page);

  const shown = notice(page);
  // Work in progress holds the reload, so the notice asks to save it first (review R2-3).
  await expect(shown.text).toHaveText(
    'Nova versão disponível. Salve o que estiver fazendo antes de atualizar.',
  );
  await expect(shown.update).toBeVisible();
  expect(deploy.loads).toBe(1);
  await expect(question).toHaveValue('o que diz o princípio do ritmo?');
  // The notice floats over no part of the question box.
  const box = await page.locator('.notice.shown').boundingBox();
  const composer = await page.locator('app-composer').boundingBox();
  expect(box && composer && !overlaps(box, composer)).toBe(true);
  const serious = (
    await new AxeBuilder({ page }).include('app-update-banner').analyze()
  ).violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''));
  expect(serious).toEqual([]);
  await shot(page, testInfo, 'kbc-123-update-banner');

  // "Agora não" closes it, and the top bar stays reachable all along.
  // By keyboard: the focus goes back to the question box, never to nothing (PD-01).
  await question.focus();
  await shown.dismiss.focus();
  await page.keyboard.press('Enter');
  await expect(shown.text).toHaveCount(0);
  await expect(question).toBeFocused();
  // A trial click fails while anything covers the control.
  // v2 (KBC-125): on desktop the top bar is the shell's (app-top-bar), over the page's header.
  await page
    .locator('app-top-bar, .topbar')
    .locator('button:visible, a:visible')
    .first()
    .click({ trial: true, timeout: 5_000 });
  expect(deploy.loads).toBe(1);
});

test('AC-2: "Atualizar" reloads into the new version and the question box keeps its text', async ({
  page,
}) => {
  const deploy = await playDeploys(page);
  await page.goto('/');
  await page.getByLabel('Sua pergunta').fill('rascunho da pergunta');
  shipNewVersion(deploy);
  await comeBack(page);
  await notice(page).update.click();
  await expect.poll(() => deploy.loads).toBe(2);
  await expect(page.getByLabel('Sua pergunta')).toHaveValue(
    'rascunho da pergunta',
  );
  await expect(notice(page).text).toHaveCount(0);
});

test('AC-2: work in a dialog (Configurações) holds the reload too, not only the question box', async ({
  page,
}) => {
  const deploy = await playDeploys(page);
  await page.goto('/');
  await shellOpenSettings(page);
  const settings = page.getByRole('dialog', { name: 'Configurações' });
  await expect(settings).toBeVisible();

  shipNewVersion(deploy);
  const asked = page.waitForResponse('**/version.json');
  await comeBack(page);
  await asked;
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await expect(notice(page).text).toBeVisible();
  expect(deploy.loads).toBe(1);
});

test('AC-1: a dialog typed in and closed with Esc no longer holds the reload ("Novo acervo", review R2-1)', async ({
  page,
}) => {
  const deploy = await playDeploys(page);
  await page.goto('/');
  await expect(page.getByLabel('Sua pergunta')).toBeVisible();
  // v2 (KBC-125): "+ Criar" › "Novo acervo", in the phone's Menu too.
  await startNewCollection(page);
  const dialog = page.getByRole('dialog', { name: 'Novo acervo' });
  await dialog.getByRole('textbox', { name: 'Nome' }).fill('Alquimia');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  const menu = page.getByRole('dialog', { name: 'Menu' });
  if (await menu.isVisible()) {
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  }

  shipNewVersion(deploy);
  await comeBack(page);
  await expect.poll(() => deploy.loads).toBe(2);
});

test('the notice covers neither the top bar nor the question box, at every width', async ({
  page,
}, testInfo) => {
  const deploy = await playDeploys(page);
  await page.goto('/');
  await page.getByLabel('Sua pergunta').fill('rascunho');
  shipNewVersion(deploy);
  await comeBack(page);
  const widths =
    testInfo.project.name === 'desktop' ? [1440, 1024, 768] : [390];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await expect(notice(page).text).toBeVisible();
    const box = await page.locator('.notice.shown').boundingBox();
    const topbar = await page.locator('.topbar').boundingBox();
    const composer = await page.locator('app-composer').boundingBox();
    expect(box && topbar && !overlaps(box, topbar), `at ${width}`).toBe(true);
    expect(box && composer && !overlaps(box, composer), `at ${width}`).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`kbc-123-update-banner-${width}.png`),
    });
  }
});

test.describe('signed out', () => {
  test.use({ signedInAs: null });

  test('AC-3: the login screen reloads into the new version at once', async ({
    page,
  }) => {
    const deploy = await playDeploys(page);
    await page.goto('/');
    await expect(
      page.getByRole('button', { name: 'Fazer login com o Google' }),
    ).toBeVisible();

    shipNewVersion(deploy);
    await comeBack(page);

    await expect.poll(() => deploy.loads).toBe(2);
    await expect(
      page.getByRole('button', { name: 'Fazer login com o Google' }),
    ).toBeVisible();
  });
});
