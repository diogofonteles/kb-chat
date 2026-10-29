import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, ownerApi } from './fixtures.js';
import {
  audioState,
  listenerTest as test,
  uniqueTag,
  uploadReady,
  useTheme,
  type UploadedMedia,
} from './media-helpers.js';

let lecture: UploadedMedia;
let short: UploadedMedia;

test.beforeAll(async () => {
  const owner = await ownerApi();
  lecture = await uploadReady(owner, {
    title: `Timer ${uniqueTag()}`,
    seconds: 120,
  });
  short = await uploadReady(owner, {
    title: `Timer curto ${uniqueTag()}`,
    seconds: 4,
  });
  await owner.dispose();
});

/** The page's clock is Playwright's: minutes pass at once, the audio plays for real. */
async function openPlayer(page: Page, media: UploadedMedia = lecture) {
  await page.clock.install();
  await page.goto(`/midia/${media.id}`);
  await expect(page.getByRole('button', { name: 'Tocar' })).toBeEnabled();
}

async function chooseTimer(page: Page, choice: string) {
  await page.getByRole('button', { name: 'Mais opções' }).click();
  await page.getByRole('menuitem', { name: 'Timer para dormir' }).click();
  const dialog = page.getByRole('dialog', { name: 'Timer para dormir' });
  await dialog.getByRole('button', { name: choice, exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function play(page: Page) {
  await page.getByRole('button', { name: 'Tocar' }).click();
  await expect(page.getByRole('button', { name: 'Pausar' })).toBeVisible();
}

const moon = (page: Page) =>
  page.getByRole('button', { name: /^Timer para dormir:/ });

const volume = (page: Page) =>
  page
    .locator('[data-media-engine]')
    .evaluate((element) => (element as HTMLMediaElement).volume);

test('AC-1: after 5 min playing the sound goes down, it pauses, the sound comes back and the position is kept', async ({
  page,
}) => {
  await openPlayer(page);
  await chooseTimer(page, '5 min');
  await expect(moon(page)).toContainText('Para em 5:00');
  await play(page);
  // Real audio first, so the position to keep is not 0.
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeGreaterThan(1);
  await page.clock.fastForward('04:55');
  await expect.poll(() => volume(page)).toBeLessThan(1);
  expect((await audioState(page)).paused).toBe(false);
  await page.clock.fastForward('00:06');
  await expect(page.getByRole('button', { name: 'Tocar' })).toBeVisible();
  const { paused, currentTime } = await audioState(page);
  expect(paused).toBe(true);
  await expect.poll(() => volume(page)).toBe(1);
  // The account has where it paused (the save on pausing, or the one just before).
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/v1/media/${lecture.id}`)).json())
          .positionMs,
    )
    .toBeGreaterThan(currentTime * 1000 - 1000);
  await expect(page.getByRole('status')).toContainText('Pausado pelo timer');
  await expect(moon(page)).toHaveCount(0);
});

test('AC-2: a 2 min pause in the middle is not counted', async ({ page }) => {
  await openPlayer(page);
  await chooseTimer(page, '5 min');
  await play(page);
  await page.clock.fastForward('02:00');
  await page.getByRole('button', { name: 'Pausar' }).click();
  await expect(page.getByRole('button', { name: 'Tocar' })).toBeVisible();
  await page.clock.fastForward('02:00');
  await play(page);
  // 6:50 after the timer started: 4:50 of it playing.
  await page.clock.fastForward('02:50');
  await expect(moon(page)).toContainText(/Para em 0:(0\d|1\d)/);
  expect((await audioState(page)).paused).toBe(false);
  await page.clock.fastForward('00:15');
  await expect(page.getByRole('button', { name: 'Tocar' })).toBeVisible();
});

test('AC-3: "Mais 5 minutos" adds to what is left and undoes the fade', async ({
  page,
}) => {
  await openPlayer(page);
  await chooseTimer(page, '5 min');
  await play(page);
  await page.clock.fastForward('04:30');
  await moon(page).click();
  await page.getByRole('menuitem', { name: 'Mais 5 minutos' }).click();
  await expect(moon(page)).toContainText(/Para em 5:(2\d|30)/);
  await page.clock.fastForward('05:25');
  await expect.poll(() => volume(page)).toBeLessThan(1);
  await moon(page).click();
  await page.getByRole('menuitem', { name: 'Mais 5 minutos' }).click();
  await expect.poll(() => volume(page)).toBe(1);
  await expect(moon(page)).toContainText(/Para em 5:0\d/);
  expect((await audioState(page)).paused).toBe(false);
});

test('AC-4: "No fim desta mídia" stops at the end, and nothing else plays', async ({
  page,
}) => {
  await openPlayer(page, short);
  await chooseTimer(page, 'No fim desta mídia');
  await expect(moon(page)).toContainText('No fim');
  await play(page);
  await expect
    .poll(async () => (await audioState(page)).ended, {
      timeout: 20_000,
    })
    .toBe(true);
  await expect(moon(page)).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('Pausado pelo timer');
  expect((await audioState(page)).paused).toBe(true);
});

test('AC-5: where the volume is read-only, it pauses with no fade', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const sets: number[] = [];
    Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
      configurable: true,
      get: () => 1,
      set: (value: number) => sets.push(value),
    });
    Object.assign(window, { volumeSets: sets });
  });
  await openPlayer(page);
  await expect(page.locator('.options')).toHaveAttribute('data-volume', 'off');
  await chooseTimer(page, '5 min');
  await play(page);
  await page.clock.fastForward('04:55');
  await page.clock.fastForward('00:06');
  await expect(page.getByRole('button', { name: 'Tocar' })).toBeVisible();
  // Only the detection probe's own write: the timer never touched the volume.
  const sets = await page.evaluate(
    () => (window as unknown as { volumeSets: number[] }).volumeSets.length,
  );
  expect(sets).toBeLessThanOrEqual(1);
});

test('AC-6: closing the player turns the timer off', async ({ page }) => {
  await openPlayer(page);
  await chooseTimer(page, '15 min');
  await play(page);
  await page.getByRole('link', { name: '← Mídia' }).click();
  const mini = page.getByRole('region', { name: 'Mini-player' });
  await expect(mini).toContainText(/Timer para dormir: 1[45]:\d\d/);
  await mini.getByRole('button', { name: 'Fechar o player' }).click();
  await expect(mini).toHaveCount(0);
  await page.goto(`/midia/${lecture.id}`);
  await expect(
    page.getByRole('button', { name: /^Tocar|Continuar de/ }).first(),
  ).toBeEnabled();
  await expect(moon(page)).toHaveCount(0);
});

test('NFR-1: with the tab hidden and no time update, it still pauses on time', async ({
  page,
}) => {
  await page.addInitScript(() => {
    // A hidden tab: the media's time updates stop reaching the page.
    window.addEventListener(
      'timeupdate',
      (event) => {
        if ((window as unknown as { hidden?: boolean }).hidden)
          event.stopImmediatePropagation();
      },
      true,
    );
  });
  await openPlayer(page);
  await chooseTimer(page, '5 min');
  await play(page);
  await page.evaluate(() => {
    Object.assign(window, { hidden: true });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.fastForward('05:01');
  await expect
    .poll(async () => (await audioState(page)).paused, { timeout: 2_000 })
    .toBe(true);
});

test('the timer is chosen and turned off with the keyboard only', async ({
  page,
}) => {
  await openPlayer(page);
  const more = page.getByRole('button', { name: 'Mais opções' });
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('menuitem', { name: 'Timer para dormir' }),
  ).toBeVisible();
  // ↑ from the trigger lands on the last item.
  await page.keyboard.press('Escape');
  await more.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: 'Timer para dormir' }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Timer para dormir' });
  await expect(dialog).toBeVisible();
  // Arrows never start a timer; Tab walks the choices and Enter picks one.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await expect(dialog).toBeVisible();
  await expect(moon(page)).toHaveCount(0);
  for (let i = 0; i < 3; i++) await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: '30 min' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(more).toBeFocused();
  await expect(moon(page)).toContainText('Para em 30:00');
  await moon(page).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: 'Desligar timer' }).focus();
  await page.keyboard.press('Enter');
  await expect(moon(page)).toHaveCount(0);
  await expect(more).toBeFocused();
  await expect(page.getByRole('status')).toContainText('Timer desligado');
});

test('BR-2: opening another media turns the timer off', async ({ page }) => {
  await openPlayer(page);
  await chooseTimer(page, '15 min');
  await expect(moon(page)).toBeVisible();
  await page.goto(`/midia/${short.id}`);
  await expect(page.getByRole('button', { name: 'Tocar' })).toBeEnabled();
  await expect(moon(page)).toHaveCount(0);
});

for (const theme of ['light', 'dark', 'esoteric'] as const) {
  test(`the "Timer para dormir" dialog passes axe in the ${theme} theme`, async ({
    page,
  }) => {
    await useTheme(page, theme);
    await openPlayer(page);
    await page.getByRole('button', { name: 'Mais opções' }).click();
    await page.getByRole('menuitem', { name: 'Timer para dormir' }).click();
    await expect(
      page.getByRole('dialog', { name: 'Timer para dormir' }),
    ).toBeVisible();
    const violations = (
      await new AxeBuilder({ page }).analyze()
    ).violations.filter((violation) =>
      ['serious', 'critical'].includes(violation.impact ?? ''),
    );
    expect(violations).toEqual([]);
  });
}
