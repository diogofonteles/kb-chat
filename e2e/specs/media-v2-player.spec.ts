import AxeBuilder from '@axe-core/playwright';
import { expect, ownerApi, test } from './fixtures.js';
import type { Page } from '@playwright/test';
import { audioState, uniqueTag, uploadReady } from './media-helpers.js';
import { desktop } from './shell-helpers.js';
import { capture, expectInsideViewport } from './v2-media-helpers.js';

// KBC-129 (v2): the player's ⋯ with the page's editing actions on top, in the top layer,
// and "Meus marcadores" and the queue in their v2 states.

test.describe.configure({ mode: 'default' });

test('KBC-129: the editing actions are at the top of ⋯, whole on screen, and "Editar informações" opens from there', async ({
  page,
}, info) => {
  const owner = await ownerApi();
  const media = await uploadReady(owner, {
    title: `Aula ${uniqueTag()}`,
    seconds: 6,
  });
  await page.goto(`/midia/${media.id}`);
  await expect(page.getByRole('heading', { name: media.title })).toBeVisible();
  await capture(page, 'player', info.project.name);
  await page.getByRole('button', { name: 'Mais opções' }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem').first()).toHaveText(
    'Editar informações',
  );
  await expect(
    menu.getByRole('menuitem', { name: 'Preparar áudio' }),
  ).toBeVisible();
  await expectInsideViewport(page, menu);
  await capture(page, 'player-more', info.project.name);
  await menu.getByRole('menuitem', { name: 'Editar informações' }).click();
  const dialog = page.getByRole('dialog', { name: 'Editar informações' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  // The focus goes back to ⋯, never to the page (WCAG 2.4.3).
  await expect(page.getByRole('button', { name: 'Mais opções' })).toBeFocused();
  await owner.dispose();
});

test('KBC-129 AC-6: "Meus marcadores" and the queue show their v2 states and pass axe', async ({
  page,
}, info) => {
  await page.goto('/midia/marcadores');
  await expect(
    page.getByRole('heading', { name: 'Meus marcadores' }),
  ).toBeVisible();
  // The summary shows once: the header's on a desktop, the phone's under the title.
  // The page's own summary: Sua biblioteca's "Lista · N marcadores" is another place.
  // With none (a fresh database: the owner's bookmarks are other tests'), a phone draws no
  // count, only the empty state (media-bookmarks-empty@mobile); a desktop says so in its
  // header (media-bookmarks-empty).
  const main = page.getByRole('main');
  const summary = (text: RegExp) =>
    main.getByText(text).and(page.locator(':visible'));
  const empty = main.getByText('Seus marcadores aparecem aqui');
  await expect(summary(/\d+ marcador/).or(empty)).toBeVisible();
  if (await empty.isVisible()) {
    if (desktop(page))
      await expect(summary(/^Nenhum marcador ainda$/)).toBeVisible();
    else
      await expect(summary(/\d+ marcador|Nenhum marcador ainda/)).toHaveCount(
        0,
      );
  } else {
    await expect(summary(/\d+ marcador/)).toBeVisible();
  }
  await capture(page, 'bookmarks', info.project.name);
  const bookmarksAxe = await new AxeBuilder({ page })
    .include('.page')
    .analyze();
  expect(
    bookmarksAxe.violations.filter((v) =>
      ['serious', 'critical'].includes(v.impact ?? ''),
    ),
  ).toEqual([]);

  await page.goto('/fila');
  await expect(
    page.getByRole('heading', { name: 'Fila de processamento' }),
  ).toBeVisible();
  // The kicker is the desktop header's (pageHeader); a phone has "‹ Fila de processamento".
  if (desktop(page))
    await expect(
      page.getByText('Processamento', { exact: true }),
    ).toBeVisible();
  await capture(page, 'queue', info.project.name);
  const queueAxe = await new AxeBuilder({ page }).include('.queue').analyze();
  expect(
    queueAxe.violations.filter((v) =>
      ['serious', 'critical'].includes(v.impact ?? ''),
    ),
  ).toEqual([]);
});

/** Plays a new recording on its page and goes to the library without reloading the page. */
async function playThenLibrary(page: Page, title: string): Promise<string> {
  const owner = await ownerApi();
  const media = await uploadReady(owner, { title, seconds: 120 });
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
  // On a phone the page of what plays is full screen: its own "← Biblioteca" leads back.
  else await page.getByRole('link', { name: '← Biblioteca' }).click();
  await expect(page).toHaveURL(/\/biblioteca$/);
  return media.id;
}

test('KBC-129 AC-2: the player bar\'s transcript button opens "Tocando agora" on the right, and the library narrows whole', async ({
  page,
}, info) => {
  test.skip(
    !desktop(page),
    'the player bar is the desktop one (AC-3 is the phone)',
  );
  test.setTimeout(120_000);
  const title = `Aula tocando agora ${uniqueTag()}`;
  await playThenLibrary(page, title);
  const bar = page.getByRole('region', { name: 'Mini-player' });
  const button = bar.getByRole('button', { name: 'Tocando agora' });
  await expect(button).toHaveAttribute('aria-pressed', 'false');

  await button.click();
  const panel = page.getByRole('complementary', { name: 'Tocando agora' });
  await expect(
    panel.getByRole('heading', { name: 'Tocando agora' }),
  ).toBeVisible();
  await expect(panel.getByRole('link', { name: title })).toBeVisible();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  // AC-4 in the app: no "Seguir" (KBC-135) and no share (KBC-136).
  await expect(panel.getByRole('button', { name: /Seguir/ })).toHaveCount(0);
  await expectInsideViewport(page, panel);
  // On the right of the main panel, which narrows: no row of the library passes under it.
  const main = await page.locator('main').boundingBox();
  const side = await panel.boundingBox();
  expect(main && side && main.x + main.width <= side.x).toBe(true);
  const rows = page.locator('main [role="list"] > *');
  for (const box of await rows.evaluateAll((items) =>
    items.map((item) => {
      const rect = item.getBoundingClientRect();
      // A strip that scrolls sideways ("Continuar ouvindo") shows its cards up to its own
      // edge: what is seen of a card ends there.
      const list = item.parentElement;
      const strip =
        list && getComputedStyle(list).overflowX !== 'visible'
          ? list.getBoundingClientRect().right
          : Number.POSITIVE_INFINITY;
      return {
        right: Math.min(rect.right, strip),
        clipped: item.scrollWidth > item.clientWidth,
      };
    }),
  )) {
    expect(box.right).toBeLessThanOrEqual((main?.x ?? 0) + (main?.width ?? 0));
    expect(box.clipped).toBe(false);
  }
  await capture(page, 'now-playing', info.project.name);
  const axe = await new AxeBuilder({ page })
    .include('aside[aria-label="Tocando agora"]')
    .analyze();
  expect(
    axe.violations.filter((v) =>
      ['serious', 'critical'].includes(v.impact ?? ''),
    ),
  ).toEqual([]);

  await button.click();
  await expect(panel).toHaveCount(0);
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  expect((await audioState(page)).paused).toBe(false);
});

test('KBC-129 AC-3: on a phone, a tap on the mini player opens the full-screen player and the sound goes on', async ({
  page,
}, info) => {
  test.skip(
    desktop(page),
    'the mini player is the phone one (AC-2 is the desktop)',
  );
  test.setTimeout(120_000);
  const title = `Aula em tela cheia ${uniqueTag()}`;
  const id = await playThenLibrary(page, title);
  const elements = () =>
    page.evaluate(() => document.querySelectorAll('audio, video').length);
  const before = await elements();
  const mini = page.getByRole('region', { name: 'Mini-player' });
  await expect(mini).toBeVisible();
  await capture(page, 'mini-player', info.project.name);
  // The card, not only its title, opens the player: a tap on its cover, at the left.
  await mini.click({ position: { x: 24, y: 24 } });
  await expect(page).toHaveURL(new RegExp(`/midia/${id}$`));
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  // Full screen: the page is the player, with no phone navigation or mini player over it.
  await expect(
    page.getByRole('navigation', { name: 'Navegação' }),
  ).toBeHidden();
  await expect(mini).toHaveCount(0);
  const at = (await audioState(page)).currentTime;
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeGreaterThan(at);
  expect((await audioState(page)).paused).toBe(false);
  expect(await elements()).toBe(before);
  await capture(page, 'player-full-screen', info.project.name);
  // The way back is on the page.
  await page
    .getByRole('link', { name: /Biblioteca|Mídia/ })
    .first()
    .click();
  await expect(
    page.getByRole('navigation', { name: 'Navegação' }),
  ).toBeVisible();
});
