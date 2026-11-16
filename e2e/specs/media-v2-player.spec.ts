import AxeBuilder from '@axe-core/playwright';
import { expect, ownerApi, test } from './fixtures.js';
import { uniqueTag, uploadReady } from './media-helpers.js';
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
  await expect(
    page.getByText(/\d+ marcador|Nenhum marcador ainda/),
  ).toBeVisible();
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
  await expect(page.getByText('Processamento', { exact: true })).toBeVisible();
  await capture(page, 'queue', info.project.name);
  const queueAxe = await new AxeBuilder({ page }).include('.queue').analyze();
  expect(
    queueAxe.violations.filter((v) =>
      ['serious', 'critical'].includes(v.impact ?? ''),
    ),
  ).toEqual([]);
});
