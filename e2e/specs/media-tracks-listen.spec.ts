import type { Page } from '@playwright/test';
import {
  expect,
  invite,
  ownerApi,
  pageAs,
  test,
  uniqueEmail,
} from './fixtures.js';
import { audioState } from './media-helpers.js';
import {
  approve,
  audioWithTracks,
  handle,
  trackRow,
} from './tracks-helpers.js';

// KBC-066: listening inside step 3 (FR-5) and by track in the player (FR-9), with real audio.

const auditionTime = (page: Page) =>
  page
    .locator('audio[hidden]')
    .first()
    .evaluate((element) => ({
      time: (element as HTMLAudioElement).currentTime,
      paused: (element as HTMLAudioElement).paused,
    }));

test('AC-7: "Ouvir o início" plays from 2 s before to 3 s after the start, and stops', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  await page.goto(`/midia/${media.id}/faixas`);
  await trackRow(page, 2).getByRole('button').first().click();
  await page.getByRole('button', { name: 'Ouvir o início' }).click();
  await expect
    .poll(async () => (await auditionTime(page)).time)
    .toBeGreaterThan(13);
  await expect
    .poll(async () => (await auditionTime(page)).paused, { timeout: 10_000 })
    .toBe(true);
  const { time } = await auditionTime(page);
  expect(time).toBeGreaterThanOrEqual(17.8);
  expect(time).toBeLessThanOrEqual(18.4);
  await owner.dispose();
});

test('AC-7: "Ouvir o fim", from a handle with F', async ({ page }) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  await page.goto(`/midia/${media.id}/faixas`);
  await handle(page, 'Fim da faixa 1').focus();
  await page.keyboard.press('f');
  await expect(page.getByTestId('playhead')).toBeVisible();
  await expect
    .poll(async () => (await auditionTime(page)).paused, { timeout: 10_000 })
    .toBe(true);
  const { time } = await auditionTime(page);
  expect(time).toBeGreaterThanOrEqual(16.8);
  expect(time).toBeLessThanOrEqual(17.4);
  await owner.dispose();
});

test('AC-12: who has `media-tracks` sees the marks, the title and goes to the next track', async ({
  browser,
  viewport,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  await approve(owner, media.id);
  const email = uniqueEmail('faixas');
  await invite(owner, email, {
    topics: ['hermetismo'],
    features: ['media', 'media-tracks'],
  });
  await owner.dispose();
  const page = await pageAs(browser, email, viewport);
  await page.goto(`/midia/${media.id}`);
  await expect(page.getByTestId('track-marks').locator('span')).toHaveCount(3);
  const list = page.getByRole('region', { name: 'Player' });
  await expect(list.getByText('Primeira pergunta')).toBeVisible();

  await page.getByRole('button', { name: 'Próxima faixa' }).click();
  await expect(list.getByText('Segunda pergunta')).toBeVisible();
  expect((await audioState(page)).currentTime).toBeGreaterThanOrEqual(14.9);

  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(list.getByText('Primeira pergunta')).toBeVisible();
  await page.context().close();
});

test('AC-12: `?track=3` opens at track 3, paused', async ({ page }) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  await approve(owner, media.id);
  await owner.dispose();
  await page.goto(`/midia/${media.id}?track=3`);
  await expect(
    page.getByRole('region', { name: 'Player' }).getByText('Terceira pergunta'),
  ).toBeVisible();
  const state = await audioState(page);
  expect(state.paused).toBe(true);
  expect(state.currentTime).toBeGreaterThanOrEqual(39.9);
});

test('the track goes on showing in the mini-player', async ({ page }) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  await approve(owner, media.id);
  await owner.dispose();
  await page.goto(`/midia/${media.id}?track=2`);
  await page.getByRole('button', { name: 'Tocar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pausar' })).toBeVisible();
  await page
    .getByRole('link', { name: /Biblioteca|Mídia/ })
    .first()
    .click();
  await expect(
    page.getByRole('region', { name: 'Mini-player' }).getByRole('link', {
      name: 'Segunda pergunta',
    }),
  ).toBeVisible();
});

test('AC-13: with `media` and no `media-tracks`, the player is the one of before', async ({
  browser,
  viewport,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  await approve(owner, media.id);
  const email = uniqueEmail('sem-faixas');
  await invite(owner, email, { topics: ['hermetismo'], features: ['media'] });
  await owner.dispose();
  const page = await pageAs(browser, email, viewport);
  await page.goto(`/midia/${media.id}`);
  await expect(
    page.getByRole('button', { name: 'Tocar', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Próxima faixa' })).toHaveCount(
    0,
  );
  await expect(page.getByRole('heading', { name: 'Faixas' })).toHaveCount(0);
  await expect(page.getByTestId('track-marks')).toHaveCount(0);
  await page.context().close();
});

test('AC-1: a draft shows nothing to listeners, and AC-16: reopening keeps the old tracks', async ({
  browser,
  page,
  viewport,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  const email = uniqueEmail('ouve');
  await invite(owner, email, {
    topics: ['hermetismo'],
    features: ['media', 'media-tracks'],
  });
  const listener = await pageAs(browser, email, viewport);
  await listener.goto(`/midia/${media.id}`);
  await expect(
    listener.getByRole('button', { name: 'Tocar', exact: true }),
  ).toBeVisible();
  await expect(listener.getByRole('heading', { name: 'Faixas' })).toHaveCount(
    0,
  );

  await page.goto(`/midia/${media.id}/faixas`);
  await page.getByRole('button', { name: 'Aprovar faixas' }).click();
  await expect(
    page.getByRole('heading', { name: '3 faixas aplicadas.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Reabrir edição' }).click();
  await expect(page.getByTestId('step-text')).toContainText('Validar faixas');
  await expect(trackRow(page, 1)).toContainText('Primeira pergunta');

  await listener.reload();
  await expect(listener.getByRole('heading', { name: 'Faixas' })).toBeVisible();
  await listener.context().close();
  await owner.dispose();
});
