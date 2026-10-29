import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { CSRF, expect, ownerApi } from './fixtures.js';
import {
  audioState,
  listenerTest as test,
  uniqueTag,
  uploadReady,
  useTheme,
  type UploadedMedia,
} from './media-helpers.js';

let lecture: UploadedMedia;

test.beforeAll(async () => {
  const owner = await ownerApi();
  lecture = await uploadReady(owner, {
    title: `Marcadores ${uniqueTag()}`,
    seconds: 120,
  });
  await owner.dispose();
});

async function openPlayer(page: Page) {
  await page.goto(`/midia/${lecture.id}`);
  await expect(
    page.getByRole('button', { name: 'Tocar', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Marcar este trecho' }),
  ).toBeEnabled();
}

/** Goes to 1:00 (PageUp on the slider) and waits for the audio to be there. */
async function goToMinute(page: Page) {
  const slider = page.getByRole('slider', { name: 'Posição' });
  await slider.focus();
  await slider.press('PageUp');
  await expect
    .poll(async () => Math.round((await audioState(page)).currentTime))
    .toBe(60);
}

const list = (page: Page) =>
  page.getByRole('region', { name: /Marcadores/ }).getByRole('listitem');

async function seed(page: Page, positions: readonly number[]) {
  for (const positionMs of positions) {
    const created = await page.request.post(
      `/api/v1/media/${lecture.id}/bookmarks`,
      {
        headers: CSRF,
        data: { id: crypto.randomUUID(), positionMs },
      },
    );
    expect(created.status()).toBe(201);
  }
}

test('AC-1: B marks 2 s back while it plays, with the note, and the audio goes on', async ({
  page,
}) => {
  await openPlayer(page);
  await goToMinute(page);
  await page.getByRole('button', { name: 'Tocar', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Pausar', exact: true }),
  ).toBeVisible();
  await page.locator('#media-item-title').click();
  const before = (await audioState(page)).currentTime;
  await page.keyboard.press('b');
  const note = page.getByRole('textbox', {
    name: /^Nota do marcador em 0:5\d$/,
  });
  await expect(note).toBeFocused();
  await note.fill('lei do ritmo');
  await note.press('Enter');
  await expect(note).toBeHidden();
  const item = list(page).first();
  await expect(item).toContainText('lei do ritmo');
  const shown = await item
    .getByRole('button', { name: /^Tocar de/ })
    .innerText();
  const [minutes = 0, seconds = 0] = shown.split(':').map(Number);
  // 2 s before the moment of the key (a second of slack for the clock that moved).
  expect(minutes * 60 + seconds).toBeGreaterThanOrEqual(Math.floor(before) - 3);
  expect(minutes * 60 + seconds).toBeLessThanOrEqual(Math.floor(before) - 1);
  expect((await audioState(page)).paused).toBe(false);
  await page.reload();
  await expect(list(page).first()).toContainText('lei do ritmo');
});

test('AC-7: a mark at 0:01 lands on 0:00', async ({ page }) => {
  await openPlayer(page);
  await page.getByRole('button', { name: 'Tocar', exact: true }).click();
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeGreaterThan(0.5);
  await page.getByRole('button', { name: 'Marcar este trecho' }).click();
  await page.keyboard.press('Escape');
  await expect(
    list(page)
      .first()
      .getByRole('button', { name: /^Tocar de/ }),
  ).toHaveText('0:00');
});

test('AC-2: three bookmarks show on the slider, and one plays from its time', async ({
  page,
}) => {
  await seed(page, [10_000, 40_000, 90_000]);
  await openPlayer(page);
  await expect(list(page)).toHaveCount(3);
  await expect(page.locator('app-seek-slider .mark')).toHaveCount(3);
  await list(page)
    .nth(1)
    .getByRole('button', { name: 'Tocar de 40 segundos' })
    .click();
  await expect(
    page.getByRole('button', { name: 'Pausar', exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeGreaterThanOrEqual(40);
});

test('AC-3: deleting shows "Desfazer", which brings it back with its note', async ({
  page,
}) => {
  await openPlayer(page);
  await page.getByRole('button', { name: 'Marcar este trecho' }).click();
  const note = page.getByRole('textbox', { name: /Nota do marcador/ });
  await note.fill('polaridade');
  await note.press('Enter');
  await expect(list(page)).toHaveCount(1);
  await list(page)
    .first()
    .getByRole('button', { name: /^Apagar/ })
    .click();
  await expect(list(page)).toHaveCount(0);
  const undo = page.getByRole('button', { name: 'Desfazer' });
  await expect(undo).toBeFocused();
  await undo.click();
  await expect(list(page).first()).toContainText('polaridade');
  // Nothing went to the server: after a reload it is still there.
  await page.reload();
  await expect(list(page).first()).toContainText('polaridade');
});

test('FR-4: without "Desfazer" the deletion reaches the server after 8 s', async ({
  page,
}) => {
  await seed(page, [5_000]);
  await page.clock.install();
  await openPlayer(page);
  const deleted = page.waitForRequest(
    (request) =>
      request.method() === 'DELETE' && request.url().includes('/bookmarks/'),
  );
  await list(page)
    .first()
    .getByRole('button', { name: /^Apagar/ })
    .click();
  await page.clock.fastForward('00:08');
  await deleted;
  await page.reload();
  await expect(page.getByText(/Nenhum marcador ainda/)).toBeVisible();
});

test('AC-8: with the API down, the note stays and "Tentar de novo" saves it', async ({
  page,
}) => {
  await openPlayer(page);
  await page.route('**/bookmarks', (route) =>
    route.request().method() === 'POST' ? route.abort() : route.continue(),
  );
  await page.getByRole('button', { name: 'Marcar este trecho' }).click();
  const note = page.getByRole('textbox', { name: /Nota do marcador/ });
  await note.fill('lei do ritmo');
  await note.press('Enter');
  await expect(page.getByRole('alert')).toContainText(
    'Não consegui salvar o marcador.',
  );
  await expect(note).toHaveValue('lei do ritmo');
  await page.unroute('**/bookmarks');
  const noted = page.waitForResponse(
    (response) => response.request().method() === 'PATCH' && response.ok(),
  );
  await page.getByRole('button', { name: 'Tentar de novo' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await noted;
  await page.reload();
  await expect(list(page).first()).toContainText('lei do ritmo');
});

test('FR-5: "Meus marcadores" opens the media playing from the bookmark', async ({
  page,
}) => {
  await seed(page, [30_000]);
  await page.goto('/midia');
  await page.getByRole('link', { name: 'Meus marcadores' }).click();
  await page
    .getByRole('link', {
      name: `${lecture.title}, tocar de 30 segundos`,
    })
    .click();
  await expect(
    page.getByRole('heading', { name: lecture.title }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Pausar', exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeGreaterThanOrEqual(30);
  await expect(page.getByRole('button', { name: /Continuar de/ })).toHaveCount(
    0,
  );
});

test('AC-9: marking, noting, playing from the list and undoing work with the keyboard only', async ({
  page,
}) => {
  await openPlayer(page);
  const mark = page.getByRole('button', { name: 'Marcar este trecho' });
  await mark.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('textbox', { name: /Nota do marcador/ }),
  ).toBeFocused();
  await page.keyboard.type('trecho importante');
  await page.keyboard.press('Enter');
  await expect(mark).toBeFocused();
  const time = list(page)
    .first()
    .getByRole('button', { name: /^Tocar de/ });
  await time.focus();
  await page.keyboard.press('Tab');
  await expect(
    list(page)
      .first()
      .getByRole('button', { name: /^Editar/ }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Desfazer' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(list(page).first()).toContainText('trecho importante');
});

test('NFR-2: 500 bookmarks list and respond fast', async ({ page }) => {
  test.setTimeout(120_000);
  await seed(
    page,
    Array.from({ length: 500 }, (_, i) => i * 200),
  );
  await openPlayer(page);
  await expect(list(page)).toHaveCount(500);
  await page.evaluate(() => {
    const durations: number[] = [];
    new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) durations.push(entry.duration);
    }).observe({
      type: 'event',
      durationThreshold: 16,
      buffered: false,
    } as PerformanceObserverInit);
    Object.assign(window, { interactionDurations: durations });
  });
  const target = list(page)
    .nth(250)
    .getByRole('button', { name: /^Tocar de/ });
  await target.scrollIntoViewIfNeeded();
  await target.click();
  await page.waitForTimeout(500);
  const slowest = await page.evaluate(() =>
    Math.max(
      0,
      ...(window as unknown as { interactionDurations: number[] })
        .interactionDurations,
    ),
  );
  expect(slowest).toBeLessThanOrEqual(200);
});

for (const theme of ['light', 'dark', 'esoteric'] as const) {
  test(`the bookmarks pass axe in the ${theme} theme`, async ({ page }) => {
    await useTheme(page, theme);
    await seed(page, [5_000]);
    await openPlayer(page);
    await page.getByRole('button', { name: 'Marcar este trecho' }).click();
    await expect(
      page.getByRole('textbox', { name: /Nota do marcador/ }),
    ).toBeVisible();
    const violations = (
      await new AxeBuilder({ page }).analyze()
    ).violations.filter((violation) =>
      ['serious', 'critical'].includes(violation.impact ?? ''),
    );
    expect(violations).toEqual([]);
  });
}
