import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { CSRF, expect, ownerApi, test } from './fixtures.js';

/**
 * KBC-107 (ADR 0036 §5, screens.md T24 "Sem nível"): documents that arrive from kb without a
 * level wait in "Sem nível"; the master filters them, gives the filtered ones a level, then the
 * rows ticked by hand, until the queue says "Todos os documentos têm nível." and the sidebar's
 * notice is gone. Each project has its own collection (`zz-semnivel-<project>`).
 */
const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

const shots = process.env['KBC_SHOTS'];
async function shoot(page: Page, name: string): Promise<void> {
  if (shots)
    await page.screenshot({
      path: `${shots}/${name}-${page.viewportSize()?.width}.png`,
      fullPage: true,
    });
}

/** A press as the device makes it: a tap on the phone, a click on the desktop. */
async function press(page: Page, target: Locator): Promise<void> {
  if (desktop(page)) await target.click();
  else await target.tap();
}

/** The sidebar with `slug` chosen (on the phone, choosing closes the drawer: reopened). */
async function sidebarOn(page: Page, slug: string): Promise<Locator> {
  await (
    await sidebar(page)
  )
    .getByRole('combobox', { name: 'Acervo', exact: true })
    .selectOption(slug);
  return sidebar(page);
}

async function sidebar(page: Page): Promise<Locator> {
  const drawer = page.getByRole('dialog', { name: 'Menu' });
  if (!desktop(page) && !(await drawer.isVisible()))
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
  return desktop(page)
    ? page.getByRole('complementary', { name: 'Lateral' })
    : drawer;
}

/** QS < CI on the collection (the first level places its three documents at QS). */
async function scaleOf(owner: APIRequestContext, slug: string) {
  for (const code of ['QS', 'CI']) {
    const created = await owner.post(`/api/v1/topics/${slug}/levels`, {
      data: { code },
      headers: CSRF,
    });
    expect(created.status(), await created.text()).toBe(201);
  }
}

/** Four documents arrive from kb: two transcribed from an audio, two typed. */
async function arrive(owner: APIRequestContext, slug: string) {
  const arrived = await owner.post('/api/e2e/levels/arrive', {
    data: {
      topic: slug,
      docs: [
        { name: 'fala-1', title: 'Fala Nova Um', audio: true },
        { name: 'fala-2', title: 'Fala Nova Dois', audio: true },
        { name: 'texto-1', title: 'Texto Novo Um' },
        { name: 'texto-2', title: 'Texto Novo Dois' },
      ],
    },
    headers: CSRF,
  });
  expect(arrived.status(), await arrived.text()).toBe(204);
}

/** The level in the bar, then "Dar nível" and the confirmation in the bar (MA-27). */
async function give(page: Page, code: string, count: number): Promise<void> {
  const bar = page.getByRole('group', { name: 'Nível em lote' });
  await bar.getByRole('combobox', { name: 'Nível' }).selectOption(code);
  await press(page, bar.getByRole('button', { name: 'Dar nível' }));
  await expect(
    bar.getByText(`Dar o nível ${code.toUpperCase()} a ${count} documentos?`),
  ).toBeVisible();
  const confirm = bar.getByRole('button', { name: 'Confirmar' });
  await expect(confirm).toBeFocused();
  await shoot(page, `unassigned-confirm-${code}`);
  await press(page, confirm);
}

test('AC-8, AC-9, AC-2, FR-6: "Sem nível" on T24 by filter and by row, by touch on the phone, until the queue and the notice are gone', async ({
  page,
}, testInfo) => {
  const slug = `zz-semnivel-${testInfo.project.name}`;
  const owner = await ownerApi();
  const scale = await owner.get(`/api/v1/topics/${slug}/levels`);
  const kept = ((await scale.json()) as { levels: unknown[] }).levels.length;
  test.skip(kept > 0, 'A reused server kept this scale: start a fresh one.');
  await scaleOf(owner, slug);
  await arrive(owner, slug);

  await page.goto('/');
  const side = await sidebarOn(page, slug);
  const notice = side.getByRole('link', { name: /4 documentos sem nível/ });
  await expect(notice).toBeVisible();
  await shoot(page, 'unassigned-notice');
  await press(page, notice);

  await expect(
    page.getByRole('heading', { name: 'Sem nível (4)' }),
  ).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(4);
  await shoot(page, 'unassigned-list');
  await page.getByRole('combobox', { name: 'Origem' }).selectOption('audio');
  await expect(page.getByRole('checkbox')).toHaveCount(2);
  await press(
    page,
    page.getByRole('button', { name: 'Selecionar os 2 filtrados' }),
  );
  await expect(page.getByText('2 selecionados')).toBeVisible();
  await give(page, 'ci', 2);
  await expect(page.getByText('2 documentos foram para CI.')).toBeAttached();
  await expect(
    page.getByRole('heading', { name: 'Sem nível (2)' }),
  ).toBeVisible();

  await page.getByRole('combobox', { name: 'Origem' }).selectOption('');
  await expect(page.getByRole('checkbox')).toHaveCount(2);
  await press(page, page.getByRole('checkbox', { name: 'Texto Novo Um' }));
  await press(page, page.getByRole('checkbox', { name: 'Texto Novo Dois' }));
  const bar = page.locator('app-bulk-level-bar');
  if (!desktop(page)) {
    // UP-13: on the phone the bar stays at the bottom of the screen.
    expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe(
      'sticky',
    );
    const box = await bar.boundingBox();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(
      page.viewportSize()?.height ?? 0,
    );
  }
  const axe = await new AxeBuilder({ page })
    .include('app-levels-page')
    .analyze();
  expect(axe.violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await give(page, 'qs', 2);

  await expect(page.getByText('Todos os documentos têm nível.')).toBeVisible();
  await shoot(page, 'unassigned-empty');
  await page.goto('/');
  const again = await sidebarOn(page, slug);
  await expect(again.getByText(/documentos? sem nível/)).toHaveCount(0);
  await owner.dispose();
});
