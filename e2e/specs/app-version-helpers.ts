import type { Page } from '@playwright/test';

/**
 * KBC-123: a tab left open across a deploy. The dev server's index.html has no version
 * stamp, so each test plays the build (the kb-app-version meta deploy/web/version.mjs
 * writes) and the server (/version.json); a "deploy" changes both.
 */
export interface Deploy {
  /** The version the next page load is stamped with. */
  stamped: string;
  /** What /version.json answers. */
  served: string;
  /** How many times the app's page was loaded (a reload is one more). */
  loads: number;
}

export async function playDeploys(page: Page): Promise<Deploy> {
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
export async function comeBack(page: Page): Promise<void> {
  await page.evaluate(() =>
    document.dispatchEvent(new Event('visibilitychange')),
  );
}

export function shipNewVersion(deploy: Deploy): void {
  deploy.stamped = 'v2';
  deploy.served = 'v2';
}

/** The notice: its text is announced (status), its buttons sit next to it. */
export const notice = (page: Page) => ({
  text: page.getByRole('status').filter({ hasText: 'Nova versão disponível.' }),
  update: page.getByRole('button', { name: 'Atualizar' }),
  dismiss: page.getByRole('button', { name: 'Agora não' }),
});
