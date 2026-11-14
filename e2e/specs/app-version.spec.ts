import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from './fixtures.js';

/**
 * KBC-123: a tab left open across a deploy. The dev server's index.html has no version
 * stamp, so each test plays the build (the kb-app-version meta deploy/web/version.mjs
 * writes) and the server (/version.json); a "deploy" changes both.
 */
interface Deploy {
  /** The version the next page load is stamped with. */
  stamped: string;
  /** What /version.json answers. */
  served: string;
  /** How many times the app's page was loaded (a reload is one more). */
  loads: number;
}

async function playDeploys(page: Page): Promise<Deploy> {
  const deploy: Deploy = { stamped: 'v1', served: 'v1', loads: 0 };
  await page.route('**/version.json', (route) =>
    route.fulfill({
      contentType: 'application/json',
      headers: { 'cache-control': 'no-cache' },
      body: JSON.stringify({ version: deploy.served }),
    }),
  );
  await page.route(
    (url) => !url.pathname.startsWith('/api/') && !/\.\w+$/.test(url.pathname),
    async (route) => {
      if (route.request().resourceType() !== 'document')
        return route.fallback();
      const response = await route.fetch();
      deploy.loads += 1;
      const html = (await response.text()).replace(
        '<head>',
        `<head><meta name="kb-app-version" content="${deploy.stamped}">`,
      );
      return route.fulfill({ response, body: html });
    },
  );
  return deploy;
}

/** The tab comes back to the front (a phone woke it up, another tab was closed). */
async function comeBack(page: Page): Promise<void> {
  await page.evaluate(() =>
    document.dispatchEvent(new Event('visibilitychange')),
  );
}

function shipNewVersion(deploy: Deploy): void {
  deploy.stamped = 'v2';
  deploy.served = 'v2';
}

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

test('AC-2: a question typed and not sent only gets "Nova versão disponível", which closes on "Agora não"', async ({
  page,
}, testInfo) => {
  const deploy = await playDeploys(page);
  await page.goto('/');
  const question = page.getByLabel('Sua pergunta');
  await question.fill('o que diz o princípio do ritmo?');

  shipNewVersion(deploy);
  await comeBack(page);

  const banner = page.getByRole('status').filter({
    hasText: 'Nova versão disponível.',
  });
  await expect(banner).toBeVisible();
  expect(deploy.loads).toBe(1);
  await expect(question).toHaveValue('o que diz o princípio do ritmo?');
  // The notice floats over no part of the question box.
  const notice = await banner.boundingBox();
  const box = await page.locator('app-composer').boundingBox();
  expect(notice && box && notice.y + notice.height <= box.y).toBe(true);
  await shot(page, testInfo, 'kbc-123-update-banner');

  // "Agora não" closes it, so a top bar it covered (a phone's) is reachable again.
  await banner.getByRole('button', { name: 'Agora não' }).click();
  await expect(banner).toHaveCount(0);
  // A trial click fails while anything covers the control.
  await page
    .locator('.topbar')
    .locator('button:visible, a:visible')
    .first()
    .click({ trial: true, timeout: 5_000 });
  expect(deploy.loads).toBe(1);
});

test('AC-2: "Atualizar" reloads into the new version, the question box empty', async ({
  page,
}) => {
  const deploy = await playDeploys(page);
  await page.goto('/');
  await page.getByLabel('Sua pergunta').fill('rascunho');
  shipNewVersion(deploy);
  await comeBack(page);
  const banner = page.getByRole('status').filter({
    hasText: 'Nova versão disponível.',
  });
  await banner.getByRole('button', { name: 'Atualizar' }).click();
  await expect.poll(() => deploy.loads).toBe(2);
  await expect(page.getByLabel('Sua pergunta')).toHaveValue('');
  await expect(page.getByText('Nova versão disponível.')).toHaveCount(0);
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
