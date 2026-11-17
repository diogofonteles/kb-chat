import type { Page } from '@playwright/test';
import { expect, ownerApi, test } from './fixtures.js';
import { audioState, closePlayer, uniqueTag, uploadReady } from './media-helpers.js';
import { expectScrolls, shortWindow } from './scroll-helpers.js';
import { desktop } from './shell-helpers.js';

/**
 * KBC-125, v2 fidelity: the player bar, "Tocando agora" and the phone's mini player work, not
 * only look like the frames: every control answers, the menus open and close, the panel's
 * text scrolls (in Google Chrome at 1440 and 390, and in WebKit with KBC_E2E_WEBKIT=1).
 */

test.describe.configure({ mode: 'default' });

async function playThenLibrary(page: Page): Promise<string> {
  const owner = await ownerApi();
  const media = await uploadReady(owner, {
    title: `Aula da casca que funciona ${uniqueTag()}`,
    seconds: 120,
  });
  await owner.dispose();
  await page.goto(`/midia/${media.id}`);
  await page.getByRole('button', { name: 'Tocar' }).click();
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeGreaterThan(0.5);
  if (desktop(page))
    await page
      .getByRole('complementary', { name: 'Sua biblioteca' })
      .getByRole('link', { name: 'Biblioteca', exact: true })
      .click();
  else await page.getByRole('link', { name: '← Biblioteca' }).click();
  await expect(page).toHaveURL(/\/biblioteca$/);
  return media.id;
}

test('every control of the player bar answers, and "Tocando agora" scrolls and closes from ⋯', async ({
  page,
}) => {
  test.skip(!desktop(page), 'The player bar is the desktop one.');
  test.setTimeout(150_000);
  const id = await playThenLibrary(page);
  const bar = page.getByRole('region', { name: 'Mini-player' });
  // One 72 band at the foot of the shell, 8 from the window's edge (v2 · Casca).
  const band = await bar.boundingBox();
  const viewport = page.viewportSize();
  expect(band?.height).toBe(72);
  expect((band?.y ?? 0) + (band?.height ?? 0)).toBe((viewport?.height ?? 0) - 8);

  const pause = bar.getByRole('button', { name: /^Pausar/ });
  await pause.click();
  await expect.poll(async () => (await audioState(page)).paused).toBe(true);
  const at = (await audioState(page)).currentTime;
  await bar.getByRole('button', { name: /^Avançar \d+ segundos/ }).click();
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeGreaterThan(at + 5);
  const ahead = (await audioState(page)).currentTime;
  await bar.getByRole('button', { name: /^Voltar \d+ segundos/ }).click();
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeLessThan(ahead - 5);
  await bar.getByRole('button', { name: /^(Tocar|Continuar)/ }).click();
  await expect.poll(async () => (await audioState(page)).paused).toBe(false);

  // The speed is a menu: it opens, takes a choice and closes.
  await bar.getByRole('button', { name: /Velocidade/ }).click();
  await page.getByRole('menuitemradio', { name: /^1,5×$|Velocidade 1,5 vezes/ }).click();
  await expect
    .poll(() =>
      page
        .locator('[data-media-engine]')
        .evaluate((element) => (element as HTMLMediaElement).playbackRate),
    )
    .toBe(1.5);
  // Back to 1× (the speed is the person's preference, shared with the other specs).
  await bar.getByRole('button', { name: /Velocidade/ }).click();
  await page.getByRole('menuitemradio', { name: /^1×$|^Velocidade normal$/ }).click();
  await expect
    .poll(() =>
      page
        .locator('[data-media-engine]')
        .evaluate((element) => (element as HTMLMediaElement).playbackRate),
    )
    .toBe(1);
  // The sleep timer is a dialog that opens and closes with Escape.
  await bar.getByRole('button', { name: /Timer para dormir/ }).click();
  const timer = page.getByRole('dialog', { name: /Timer para dormir/ });
  await expect(timer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(timer).toBeHidden();
  // Mute and back.
  const mute = bar.getByRole('button', { name: 'Silenciar' });
  if (await mute.isVisible()) {
    await mute.click();
    await expect(mute).toHaveAttribute('aria-pressed', 'true');
    await mute.click();
    await expect(mute).toHaveAttribute('aria-pressed', 'false');
  }

  // "Tocando agora": the panel opens, its text scrolls on a short window, ⋯ opens and closes.
  await bar.getByRole('button', { name: 'Tocando agora' }).click();
  const panel = page.getByRole('complementary', { name: 'Tocando agora' });
  await expect(panel.getByRole('link', { name: /Aula da casca/ })).toBeVisible();
  await shortWindow(page, 420);
  await expectScrolls(page, panel, 300);
  const more = panel.getByRole('button', { name: 'Mais opções de Tocando agora' });
  await more.click();
  await expect(
    page.getByRole('menuitem', { name: 'Fechar Tocando agora' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('menuitem', { name: 'Fechar Tocando agora' }),
  ).toBeHidden();
  await expect(more).toBeFocused();
  await more.click();
  await page.getByRole('menuitem', { name: 'Fechar Tocando agora' }).click();
  await expect(panel).toHaveCount(0);
  expect((await audioState(page)).paused).toBe(false);

  // ⤢ opens the player page; "Fechar o player" (in ⋯) stops and takes the bar away.
  await bar.getByRole('link', { name: 'Abrir o player' }).click();
  await expect(page).toHaveURL(new RegExp(`/midia/${id}$`));
  await page.goBack();
  await closePlayer(page);
  await expect(bar).toHaveCount(0);
});

test('on a phone the mini player plays and pauses, opens the player and closes', async ({
  page,
}) => {
  test.skip(desktop(page), 'The mini player is the phone one.');
  test.setTimeout(150_000);
  const id = await playThenLibrary(page);
  const mini = page.getByRole('region', { name: 'Mini-player' });
  // A 56 card right on top of the navigation (v2 · celular).
  const card = await mini.boundingBox();
  const nav = await page
    .getByRole('navigation', { name: 'Navegação' })
    .boundingBox();
  expect(Math.round(card?.height ?? 0)).toBe(56);
  expect(Math.round((card?.y ?? 0) + (card?.height ?? 0))).toBe(
    Math.round(nav?.y ?? 0),
  );
  await mini.getByRole('button', { name: /^Pausar/ }).click();
  await expect.poll(async () => (await audioState(page)).paused).toBe(true);
  await mini.getByRole('button', { name: /^(Tocar|Continuar)/ }).click();
  await expect.poll(async () => (await audioState(page)).paused).toBe(false);
  // The library under it scrolls with a finger.
  await expectScrolls(page, page.getByRole('main'), 300);
  await mini.getByRole('link', { name: /Aula da casca/ }).click();
  await expect(page).toHaveURL(new RegExp(`/midia/${id}$`));
  await page.getByRole('link', { name: '← Biblioteca' }).click();
  await closePlayer(page);
  await expect(mini).toHaveCount(0);
});
