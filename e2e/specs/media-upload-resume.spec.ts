import AxeBuilder from '@axe-core/playwright';
import type { Browser, Locator, Page, Route } from '@playwright/test';
import { statSync } from 'node:fs';
import {
  CSRF,
  expect,
  invite,
  ownerApi,
  pageAs,
  test,
  uniqueEmail,
} from './fixtures.js';
import { makeMp3, uniqueTag, useTheme } from './media-helpers.js';

/** KBC-035: resumable upload, quota and repeated files, in the real panel. */

const PART_BYTES = 8 * 1024 ** 2;
const UPLOAD_URL = '**/api/v1/media/*/upload';

const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

async function openPanel(page: Page): Promise<Locator> {
  await page.goto('/');
  if (!desktop(page)) await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('link', { name: 'Mídia' }).click();
  await page.getByRole('button', { name: 'Enviar áudio' }).first().click();
  return page.getByRole('dialog', { name: 'Enviar áudio' });
}

async function uploaderPage(
  browser: Browser,
  grant: { mediaQuotaBytes?: number } = {},
): Promise<Page> {
  const owner = await ownerApi();
  const email = uniqueEmail('envia');
  const id = await invite(owner, email, {
    topics: ['hermetismo'],
    features: ['search', 'media', 'media-upload'],
  });
  if (grant.mediaQuotaBytes) {
    const quota = await owner.patch(`/api/v1/people/${id}`, {
      data: grant,
      headers: CSRF,
    });
    expect(quota.status()).toBe(200);
  }
  await owner.dispose();
  return pageAs(browser, email, test.info().project.use.viewport ?? null);
}

/** A real MP3 over `parts` parts of 8 MB; a new tag makes a file nobody sent. */
const largeMp3 = (parts: number): string => {
  const seconds = Math.ceil((parts * PART_BYTES * 8) / 256_000);
  return makeMp3(`grande-${uniqueTag()}`, seconds, {
    bitrate: '256k',
    source: `aevalsrc='0.4*sin(2*PI*(330+${Math.round(Math.random() * 300)})*t)':s=44100:d=${seconds}`,
  });
};

const sendButton = (dialog: Locator) =>
  dialog.getByRole('button', { name: 'Enviar', exact: true });

test('AC-1, NFR-1: a part that fails continues where it stopped and creates one item', async ({
  browser,
}) => {
  const page = await uploaderPage(browser);
  const file = largeMp3(3);
  const size = statSync(file).size;
  let parts = 0;
  await page.route(UPLOAD_URL, async (route: Route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    parts += 1;
    return parts === 2 ? route.abort('connectionfailed') : route.continue();
  });
  const dialog = await openPanel(page);
  await dialog.locator('input[type="file"]').setInputFiles(file);
  await sendButton(dialog).click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  const title = rowTitleOf(file);
  await expect(page.getByRole('listitem').filter({ hasText: title })).toHaveCount(
    1,
  );
  // The aborted part went again, and nothing else did.
  expect(parts).toBe(Math.ceil(size / PART_BYTES) + 1);
});

test('FR-2: a reload loses nothing: choosing the file again continues it', async ({
  browser,
}) => {
  const page = await uploaderPage(browser);
  const file = largeMp3(2);
  const dialog = await openPanel(page);
  let held = false;
  await page.route(UPLOAD_URL, async (route: Route) => {
    if (route.request().method() !== 'PATCH' || !held) return route.continue();
    return route.abort('connectionfailed');
  });
  const firstPart = page.waitForResponse(
    (response) =>
      response.url().endsWith('/upload') &&
      response.request().method() === 'PATCH' &&
      response.status() === 204,
  );
  await dialog.locator('input[type="file"]').setInputFiles(file);
  await sendButton(dialog).click();
  await firstPart;
  held = true;
  await page.reload();
  await page.unroute(UPLOAD_URL);
  const again = await openPanel(page);
  await again.locator('input[type="file"]').setInputFiles(file);
  await expect(again.getByText(/Envio interrompido em/)).toBeVisible({
    timeout: 30_000,
  });
  await sendButton(again).click();
  await expect(again).toBeHidden({ timeout: 60_000 });
  const title = rowTitleOf(file);
  await expect(page.getByRole('listitem').filter({ hasText: title })).toHaveCount(
    1,
  );
});

test('AC-2: a file already in the collection is named, linked and not sent', async ({
  browser,
}) => {
  const page = await uploaderPage(browser);
  const file = makeMp3(`Repetido ${uniqueTag()}`, 2);
  const title = rowTitleOf(file);
  const dialog = await openPanel(page);
  await dialog.locator('input[type="file"]').setInputFiles(file);
  await sendButton(dialog).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Enviar áudio' }).first().click();
  const creates: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/media'))
      creates.push(request.url());
  });
  await dialog.locator('input[type="file"]').setInputFiles(file);
  await expect(dialog.getByText('Já está no acervo:')).toBeVisible();
  await expect(dialog.getByRole('link', { name: title })).toBeVisible();
  await sendButton(dialog).click();
  await expect(
    dialog.getByText('Nada a enviar: estes arquivos não podem ser enviados.'),
  ).toBeVisible();
  expect(creates).toEqual([]);
});

test('AC-3: a send over the quota says so and sends nothing', async ({
  browser,
}) => {
  const page = await uploaderPage(browser, {
    mediaQuotaBytes: 0.1 * 1024 ** 3,
  });
  // Four hours at 8 kbit/s: a small file that converts to about 120 MB.
  const file = makeMp3(`Longo ${uniqueTag()}`, 4 * 3600, { bitrate: '8k' });
  const dialog = await openPanel(page);
  await dialog.locator('input[type="file"]').setInputFiles(file);
  await expect(dialog.getByRole('alert')).toContainText(
    'Este envio passa da sua cota de 0,1 GB. Fale com um master para aumentar.',
  );
});

test('AC-8: three files at once, each with its bar, pass axe at this width', async ({
  browser,
}) => {
  const page = await uploaderPage(browser);
  await useTheme(page, 'light');
  const release = Promise.withResolvers<void>();
  await page.route(UPLOAD_URL, async (route: Route) => {
    if (route.request().method() === 'PATCH') await release.promise;
    return route.continue();
  });
  const dialog = await openPanel(page);
  const files = ['a', 'b', 'c'].map((name) =>
    makeMp3(`Tres ${name} ${uniqueTag()}`, 2),
  );
  await dialog.locator('input[type="file"]').setInputFiles(files);
  await sendButton(dialog).click();
  await expect(dialog.getByRole('progressbar')).toHaveCount(3);
  await expect(
    dialog.locator('[aria-live="polite"]', { hasText: '0% enviado.' }),
  ).toHaveCount(3);
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(
    violations.filter(({ impact }) =>
      ['serious', 'critical'].includes(impact ?? ''),
    ),
  ).toEqual([]);
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
  release.resolve();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
});

/** The title the panel suggests for a file. */
function rowTitleOf(path: string): string {
  const name = path.split('/').at(-1) ?? '';
  return name.replace(/\.mp3$/, '').replace(/_+/g, ' ');
}
