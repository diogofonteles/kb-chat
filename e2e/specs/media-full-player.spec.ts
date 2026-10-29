import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, ownerApi, pageAs } from './fixtures.js';
import {
  audioState,
  listenerTest as test,
  newListener,
  uploadReady,
  useTheme,
  type UploadedMedia,
} from './media-helpers.js';

let lecture: UploadedMedia;
let other: UploadedMedia;
let short: UploadedMedia;

test.beforeAll(async () => {
  const owner = await ownerApi();
  const tag = Date.now().toString(36);
  lecture = await uploadReady(owner, {
    title: `Palestra completa ${tag}`,
    seconds: 120,
  });
  other = await uploadReady(owner, { title: `Outra ${tag}`, seconds: 20 });
  short = await uploadReady(owner, { title: `Curta ${tag}`, seconds: 6 });
  await owner.dispose();
});

/** Opens the player and waits until the length is known (the slider works from then). */
async function openPlayer(page: Page, media: UploadedMedia) {
  await page.goto(`/midia/${media.id}`);
  await expect(page.getByRole('heading', { name: media.title })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tocar' })).toBeEnabled();
  await expect(
    page.getByRole('slider', { name: 'Posição' }),
  ).not.toHaveAttribute('aria-disabled', 'true');
}

const element = (page: Page) => page.locator('[data-media-engine]');
const playbackRate = (page: Page) =>
  element(page).evaluate((media) => (media as HTMLMediaElement).playbackRate);
const muted = (page: Page) =>
  element(page).evaluate((media) => (media as HTMLMediaElement).muted);

/** Focus on the page itself (the media's title), where the single-key shortcuts act. */
async function focusPage(page: Page) {
  await page.locator('#media-item-title').click();
}

/** Plays until the element's clock passes `seconds`. */
async function playPast(page: Page, seconds: number) {
  await expect
    .poll(async () => (await audioState(page)).currentTime, { timeout: 20_000 })
    .toBeGreaterThan(seconds);
}

test('AC-1: the speed chosen plays on the next media and follows the account to another browser', async ({
  browser,
}) => {
  const { page, email } = await newListener(browser, { viewport: null });
  await openPlayer(page, lecture);
  await page.getByRole('button', { name: 'Velocidade: 1 vezes' }).click();
  await page.getByRole('menuitemradio', { name: /1,5×/ }).click();
  await expect.poll(() => playbackRate(page)).toBe(1.5);
  await openPlayer(page, other);
  await expect.poll(() => playbackRate(page)).toBe(1.5);
  const elsewhere = await pageAs(browser, email, null);
  await openPlayer(elsewhere, lecture);
  await expect(
    elsewhere.getByRole('button', { name: 'Velocidade: 1,5 vezes' }),
  ).toBeVisible();
  await elsewhere.context().close();
  await page.context().close();
});

test('AC-2, AC-5: the API refuses a speed off the menu and a position outside the media', async ({
  page,
}) => {
  const api = page.request;
  const headers = { 'x-requested-with': 'kb-chat' };
  const speed = await api.put('/api/v1/media/preferences', {
    data: { speed: 3, showRemaining: true },
    headers,
  });
  expect(speed.status()).toBe(400);
  expect((await speed.json()).error.code).toBe('VALIDATION_FAILED');
  for (const positionMs of [-1, 121_000])
    expect(
      (
        await api.put(`/api/v1/media/${lecture.id}/progress`, {
          data: { positionMs },
          headers,
        })
      ).status(),
    ).toBe(400);
});

test('AC-3, AC-12: another browser offers "Continuar de" silently, and continues from there', async ({
  browser,
}) => {
  const { page, email } = await newListener(browser, { viewport: null });
  await openPlayer(page, lecture);
  const slider = page.getByRole('slider', { name: 'Posição' });
  await slider.focus();
  await slider.press('PageUp');
  await page.getByRole('button', { name: 'Tocar' }).click();
  await playPast(page, 61);
  const saved = page.waitForRequest(
    (request) =>
      request.method() === 'PUT' && request.url().endsWith('/progress'),
  );
  await page.getByRole('button', { name: 'Pausar' }).click();
  const stoppedAt = (await audioState(page)).currentTime;
  await saved;
  await page.context().close();

  const elsewhere = await pageAs(browser, email, null);
  await elsewhere.goto(`/midia/${lecture.id}`);
  const resume = elsewhere.getByRole('button', {
    name: /^Continuar de 1:0\d$/,
  });
  await expect(resume).toBeVisible();
  expect((await audioState(elsewhere)).paused).toBe(true);
  await resume.click();
  await expect(elsewhere.getByRole('button', { name: 'Pausar' })).toBeVisible();
  const resumedAt = (await audioState(elsewhere)).currentTime;
  expect(resumedAt).toBeGreaterThanOrEqual(Math.floor(stoppedAt) - 1);
  expect(resumedAt).toBeLessThan(stoppedAt + 2);
  await elsewhere.context().close();
});

test('AC-4: heard to the end, the media has no position to continue and counts as heard', async ({
  page,
}) => {
  await openPlayer(page, short);
  await page.getByRole('button', { name: 'Tocar' }).click();
  await expect(page.getByRole('button', { name: 'Ouvir de novo' })).toBeVisible(
    {
      timeout: 20_000,
    },
  );
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/v1/media/${short.id}`)).json())
          .completedAt,
    )
    .not.toBeNull();
  const item = await (
    await page.request.get(`/api/v1/media/${short.id}`)
  ).json();
  expect(item.positionMs).toBe(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Tocar' })).toBeEnabled();
  await expect(page.getByRole('button', { name: /Continuar de/ })).toHaveCount(
    0,
  );
});

test('AC-6: K, L, J, Shift+. and M act once each with the focus on the page', async ({
  page,
}) => {
  await openPlayer(page, lecture);
  await focusPage(page);
  await page.keyboard.press('k');
  await expect(page.getByRole('button', { name: 'Pausar' })).toBeVisible();
  await page.keyboard.press('k');
  await expect(page.getByRole('button', { name: 'Tocar' })).toBeVisible();
  const before = (await audioState(page)).currentTime;
  await page.keyboard.press('l');
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeCloseTo(before + 30, 0);
  await page.keyboard.press('j');
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeCloseTo(before + 15, 0);
  await page.keyboard.press('Shift+Period');
  await expect.poll(() => playbackRate(page)).toBe(1.25);
  await page.keyboard.press('m');
  await expect.poll(() => muted(page)).toBe(true);
});

test('AC-8: an arrow on the time slider moves 5 s, not also the shortcut', async ({
  page,
}) => {
  await openPlayer(page, lecture);
  const slider = page.getByRole('slider', { name: 'Posição' });
  await slider.focus();
  await slider.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuenow', '5');
  await page.waitForTimeout(300);
  expect(Math.round((await audioState(page)).currentTime)).toBe(5);
});

test('AC-7, AC-14: "?" opens the shortcuts, which can be turned off; Esc gives the focus back', async ({
  page,
}) => {
  await openPlayer(page, lecture);
  await focusPage(page);
  await page.keyboard.press('Shift+Slash');
  const dialog = page.getByRole('dialog', { name: 'Atalhos de teclado' });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole('checkbox', { name: 'Usar atalhos de uma tecla' })
    .uncheck();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await focusPage(page);
  await page.keyboard.press('k');
  await page.waitForTimeout(300);
  expect((await audioState(page)).paused).toBe(true);
  await expect(page.getByRole('button', { name: 'Tocar' })).toBeVisible();
});

test('AC-9: the lock screen shows the title, the authorship and the app icon', async ({
  page,
}) => {
  await openPlayer(page, lecture);
  test.skip(
    !(await page.evaluate(() => 'mediaSession' in navigator)),
    'no Media Session here',
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const metadata = navigator.mediaSession.metadata;
        return metadata
          ? {
              title: metadata.title,
              artist: metadata.artist,
              icons: metadata.artwork.length,
              state: navigator.mediaSession.playbackState,
            }
          : null;
      }),
    )
    .toEqual({
      title: lecture.title,
      artist: 'Outros autores — Nova Alexandria',
      icons: 6,
      state: 'paused',
    });
  await page.getByRole('button', { name: 'Tocar' }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.mediaSession.playbackState))
    .toBe('playing');
});

test('AC-9: the lock screen buttons and the position reach the player', async ({
  browser,
  viewport,
  browserName,
}) => {
  // Chromium only: WebKit sometimes runs a context's init script after the app, so the spy
  // on the system's buttons cannot be trusted there (decision in work/KBC-041). The
  // adapter is unit tested, and the test above checks WebKit's lock screen itself.
  test.skip(browserName !== 'chromium', 'the spy needs a reliable init script');
  const { page } = await newListener(browser, {
    viewport,
    initScript: () => {
      const session = navigator.mediaSession;
      if (!session) return;
      const handlers: Record<string, MediaSessionActionHandler | null> = {};
      const positions: MediaPositionState[] = [];
      const setHandler = session.setActionHandler.bind(session);
      session.setActionHandler = (action, handler) => {
        handlers[action] = handler;
        try {
          setHandler(action, handler);
        } catch {
          // An action this browser does not know.
        }
      };
      const setPosition = session.setPositionState.bind(session);
      session.setPositionState = (state) => {
        if (state) positions.push(state);
        setPosition(state);
      };
      Object.assign(window, { mediaSessionSpy: { handlers, positions } });
    },
  });
  await openPlayer(page, lecture);
  const act = async (action: string, details: object = {}) => {
    // The player registers its handlers once the media is open: wait for this one.
    await expect
      .poll(() =>
        page.evaluate(
          (name) =>
            typeof (
              window as unknown as {
                mediaSessionSpy: { handlers: Record<string, unknown> };
              }
            ).mediaSessionSpy.handlers[name] === 'function',
          action,
        ),
      )
      .toBe(true);
    await page.evaluate(
      ([name, extra]) => {
        const spy = (
          window as unknown as {
            mediaSessionSpy: {
              handlers: Record<string, ((d: object) => void) | null>;
            };
          }
        ).mediaSessionSpy;
        spy.handlers[name as string]?.({ action: name, ...(extra as object) });
      },
      [action, details] as const,
    );
  };
  await act('seekforward');
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeCloseTo(30, 0);
  await act('seekto', { seekTime: 100 });
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeCloseTo(100, 0);
  // The element moves at once; the system hears of it once the seek lands.
  const lastPosition = () =>
    page.evaluate(() => {
      const spy = (
        window as unknown as {
          mediaSessionSpy: { positions: MediaPositionState[] };
        }
      ).mediaSessionSpy;
      return spy.positions.at(-1);
    });
  await expect
    .poll(async () => (await lastPosition())?.position)
    .toBeCloseTo(100, 0);
  const last = await lastPosition();
  expect(last?.duration).toBeCloseTo(120, 0);
  expect(last?.playbackRate).toBe(1);
});

test('AC-13: no volume control where the volume is read-only (iPhone, simulated)', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
      configurable: true,
      get: () => 1,
      set: () => undefined,
    });
  });
  await openPlayer(page, lecture);
  await page.waitForTimeout(1_200);
  await expect(page.getByRole('slider', { name: 'Volume' })).toHaveCount(0);
});

test('AC-13: mute and a volume in percent where the browser allows it', async ({
  page,
}) => {
  await openPlayer(page, lecture);
  const volume = page.getByRole('slider', { name: 'Volume' });
  await expect(volume).toBeVisible();
  await expect(volume).toHaveAttribute('aria-valuetext', '100%');
  await volume.focus();
  await volume.press('ArrowLeft');
  await expect(volume).toHaveAttribute('aria-valuetext', '95%');
  await page.getByRole('button', { name: 'Silenciar' }).click();
  await expect.poll(() => muted(page)).toBe(true);
});

test('AC-15: three skips in a row are announced once, with the final position', async ({
  page,
}) => {
  await openPlayer(page, lecture);
  await focusPage(page);
  for (let i = 0; i < 3; i++) await page.keyboard.press('l');
  const status = page.locator('app-mini-player [role="status"]');
  await expect(status).toHaveText('Posição 1 minuto e 30 segundos', {
    timeout: 3_000,
  });
});

for (const theme of ['light', 'dark', 'esoteric'] as const) {
  test(`AC-14: the full player and its shortcuts list pass axe in the ${theme} theme`, async ({
    page,
  }) => {
    await useTheme(page, theme);
    await openPlayer(page, lecture);
    const serious = async () =>
      (await new AxeBuilder({ page }).analyze()).violations.filter(
        (violation) => ['serious', 'critical'].includes(violation.impact ?? ''),
      );
    expect(await serious()).toEqual([]);
    await page.getByRole('button', { name: 'Velocidade: 1 vezes' }).click();
    expect(await serious()).toEqual([]);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Mais opções' }).click();
    await page.getByRole('menuitem', { name: 'Atalhos de teclado' }).click();
    await expect(
      page.getByRole('dialog', { name: 'Atalhos de teclado' }),
    ).toBeVisible();
    expect(await serious()).toEqual([]);
  });
}

test('NFR-2: at most one saved position every 10 s while playing', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'media-desktop',
    'one project measures it: 35 s of real playback',
  );
  test.setTimeout(90_000);
  const saves: number[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().endsWith('/progress'))
      saves.push(Date.now());
  });
  await openPlayer(page, lecture);
  await page.getByRole('button', { name: 'Tocar' }).click();
  await page.waitForTimeout(35_000);
  expect(saves.length).toBeGreaterThanOrEqual(3);
  expect(saves.length).toBeLessThanOrEqual(4);
  for (let i = 1; i < saves.length; i++)
    expect((saves[i] ?? 0) - (saves[i - 1] ?? 0)).toBeGreaterThan(9_000);
});

test('NFR-4: playing, skipping and the speed respond within 200 ms (INP)', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Event Timing is a Chromium API');
  await page.addInitScript(() => {
    const durations: number[] = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) durations.push(entry.duration);
    }).observe({
      type: 'event',
      durationThreshold: 16,
      buffered: true,
    } as PerformanceObserverInit);
    Object.assign(window, { interactionDurations: durations });
  });
  await openPlayer(page, lecture);
  await page.getByRole('button', { name: 'Tocar' }).click();
  await page.getByRole('button', { name: 'Avançar 30 segundos' }).click();
  await page.getByRole('button', { name: 'Voltar 15 segundos' }).click();
  await page.getByRole('button', { name: 'Velocidade: 1 vezes' }).click();
  await page.getByRole('menuitemradio', { name: /1,25×/ }).click();
  await page.waitForTimeout(500);
  const worst = await page.evaluate(() =>
    Math.max(
      0,
      ...(window as unknown as { interactionDurations: number[] })
        .interactionDurations,
    ),
  );
  expect(worst).toBeLessThanOrEqual(200);
});
