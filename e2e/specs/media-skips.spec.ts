import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, ownerApi, pageAs } from './fixtures.js';
import {
  audioState,
  listenerTest as test,
  newListener,
  uniqueTag,
  uploadReady,
  useTheme,
  type UploadedMedia,
} from './media-helpers.js';

let lecture: UploadedMedia;

test.beforeAll(async () => {
  const owner = await ownerApi();
  lecture = await uploadReady(owner, {
    title: `Pulos ${uniqueTag()}`,
    seconds: 120,
  });
  await owner.dispose();
});

async function openPlayer(page: Page) {
  await page.goto(`/midia/${lecture.id}`);
  await expect(page.getByRole('button', { name: 'Tocar' })).toBeEnabled();
  await expect(
    page.getByRole('slider', { name: 'Posição' }),
  ).not.toHaveAttribute('aria-disabled', 'true');
}

async function chooseSkips(page: Page, back: string, forward: string) {
  await page.getByRole('button', { name: 'Mais opções' }).click();
  await page.getByRole('menuitem', { name: 'Pulos' }).click();
  const dialog = page.getByRole('dialog', { name: 'Pulos' });
  await dialog
    .getByRole('group', { name: 'Voltar' })
    .getByRole('radio', { name: back, exact: true })
    .check();
  await dialog
    .getByRole('group', { name: 'Avançar' })
    .getByRole('radio', { name: forward, exact: true })
    .check();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  // Esc gives the focus back to where it was.
  await expect(page.getByRole('button', { name: 'Mais opções' })).toBeFocused();
}

test('AC-1: back 5 s chosen, J goes from 1:00 to 0:55 and the button says it', async ({
  page,
}) => {
  await openPlayer(page);
  await chooseSkips(page, '5 s', '45 s');
  const back = page.getByRole('button', { name: 'Voltar 5 segundos' });
  await expect(back).toContainText('5');
  await expect(
    page.getByRole('button', { name: 'Avançar 45 segundos' }),
  ).toContainText('45');
  const slider = page.getByRole('slider', { name: 'Posição' });
  await slider.focus();
  await slider.press('PageUp');
  await expect
    .poll(async () => Math.round((await audioState(page)).currentTime))
    .toBe(60);
  await page.locator('#media-item-title').click();
  await page.keyboard.press('j');
  await expect
    .poll(async () => Math.round((await audioState(page)).currentTime))
    .toBe(55);
});

test('AC-2: the lock screen’s forward, with no offset, uses the 45 s chosen', async ({
  browser,
  viewport,
  browserName,
}) => {
  // Chromium only: the spy needs a reliable init script (same decision as KBC-041 AC-9).
  test.skip(browserName !== 'chromium', 'the spy needs a reliable init script');
  const { page } = await newListener(browser, {
    viewport,
    initScript: () => {
      const session = navigator.mediaSession;
      const handlers: Record<string, MediaSessionActionHandler | null> = {};
      const setHandler = session.setActionHandler.bind(session);
      session.setActionHandler = (action, handler) => {
        handlers[action] = handler;
        try {
          setHandler(action, handler);
        } catch {
          // An action this browser does not know.
        }
      };
      Object.assign(window, { mediaSessionSpy: { handlers } });
    },
  });
  await openPlayer(page);
  await chooseSkips(page, '15 s', '45 s');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          typeof (
            window as unknown as {
              mediaSessionSpy: { handlers: Record<string, unknown> };
            }
          ).mediaSessionSpy.handlers['seekforward'] === 'function',
      ),
    )
    .toBe(true);
  await page.evaluate(() =>
    (
      window as unknown as {
        mediaSessionSpy: {
          handlers: Record<string, (details: object) => void>;
        };
      }
    ).mediaSessionSpy.handlers['seekforward']?.({ action: 'seekforward' }),
  );
  await expect
    .poll(async () => Math.round((await audioState(page)).currentTime))
    .toBe(45);
  await page.context().close();
});

test('AC-3: the skips chosen on one device are the same on another', async ({
  browser,
}) => {
  const { page, email } = await newListener(browser, { viewport: null });
  await openPlayer(page);
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      response.url().endsWith('/media/preferences'),
  );
  await chooseSkips(page, '10 s', '60 s');
  await saved;
  const phone = await pageAs(browser, email, { width: 390, height: 844 });
  await openPlayer(phone);
  await expect(
    phone.getByRole('button', { name: 'Voltar 10 segundos' }),
  ).toBeVisible();
  await expect(
    phone.getByRole('button', { name: 'Avançar 60 segundos' }),
  ).toBeVisible();
  await phone.context().close();
  await page.context().close();
});

for (const theme of ['light', 'dark', 'esoteric'] as const) {
  test(`the "Pulos" dialog passes axe in the ${theme} theme`, async ({
    page,
  }) => {
    await useTheme(page, theme);
    await openPlayer(page);
    await page.getByRole('button', { name: 'Mais opções' }).click();
    await page.getByRole('menuitem', { name: 'Pulos' }).click();
    await expect(page.getByRole('dialog', { name: 'Pulos' })).toBeVisible();
    const violations = (
      await new AxeBuilder({ page }).analyze()
    ).violations.filter((violation) =>
      ['serious', 'critical'].includes(violation.impact ?? ''),
    );
    expect(violations).toEqual([]);
  });
}
