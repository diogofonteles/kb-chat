import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import {
  expect,
  invite,
  ownerApi,
  pageAs,
  signIn,
  uniqueEmail,
} from './fixtures.js';
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
let other: UploadedMedia;
let short: UploadedMedia;

// One worker per project runs this file: its media are made once in `beforeAll`, which
// fully parallel would repeat in every worker that picks a test of the file (up to eight
// conversions of the same recordings, queued with every other spec's).
test.describe.configure({ mode: 'default' });

test.beforeAll(async () => {
  const owner = await ownerApi();
  const tag = uniqueTag();
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
  await page.getByRole('button', { name: 'Pausar' }).click();
  const stoppedAt = (await audioState(page)).currentTime;
  // The server's position, not the request: closing the context cancels a PUT still in
  // flight (or the one awaited was an earlier periodic save), and the other browser would
  // then find an older position.
  await expect
    .poll(
      async () =>
        (
          (await (
            await page.request.get(`/api/v1/media/${lecture.id}`)
          ).json()) as { positionMs: number }
        ).positionMs,
    )
    .toBeGreaterThanOrEqual((Math.floor(stoppedAt) - 1) * 1_000);
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
  // The saved position is applied once the metadata is in: a click before that plays
  // and then moves there, so the element's time is waited for, not read once.
  await expect
    .poll(async () => (await audioState(elsewhere)).currentTime)
    .toBeGreaterThanOrEqual(Math.floor(stoppedAt) - 1);
  const resumedAt = (await audioState(elsewhere)).currentTime;
  expect(resumedAt).toBeLessThan(stoppedAt + 2);
  await elsewhere.context().close();
});

test('AC-3: leaving the page never brings back an older position over another device', async ({
  browser,
}) => {
  const { page: laptop, email } = await newListener(browser, {
    viewport: null,
  });
  await openPlayer(laptop, lecture);
  await laptop.getByRole('button', { name: 'Tocar' }).click();
  await playPast(laptop, 1.5);
  await laptop.getByRole('button', { name: 'Pausar' }).click();
  // Away from the page: the laptop keeps nothing that could override later saves.
  await laptop.getByRole('link', { name: '← Mídia' }).click();
  await expect(laptop.getByRole('heading', { name: /Mídia — / })).toBeVisible();

  const phone = await pageAs(browser, email, null);
  await openPlayer(phone, lecture);
  const slider = phone.getByRole('slider', { name: 'Posição' });
  await slider.focus();
  await slider.press('PageUp');
  await phone
    .getByRole('button', { name: /^(Tocar|Continuar de)/ })
    .first()
    .click();
  await playPast(phone, 61);
  const saved = phone.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      response.url().endsWith('/progress'),
  );
  await phone.getByRole('button', { name: 'Pausar' }).click();
  await saved;
  await phone.context().close();

  await laptop.locator(`a[href="/midia/${lecture.id}"]`).click();
  await expect(
    laptop.getByRole('button', { name: /^Continuar de 1:0\d$/ }),
  ).toBeVisible();
  const item = await (
    await laptop.request.get(`/api/v1/media/${lecture.id}`)
  ).json();
  expect(item.positionMs).toBeGreaterThan(60_000);
  await laptop.context().close();
});

test('AC-3: a page only opened (not played) never sends its old position over a newer one', async ({
  browser,
}) => {
  const { page: laptop, email } = await newListener(browser, {
    viewport: null,
  });
  const headers = { 'x-requested-with': 'kb-chat' };
  const first = await laptop.request.put(`/api/v1/media/${other.id}/progress`, {
    data: { positionMs: 5_000, basedOn: null },
    headers,
  });
  expect(first.status()).toBe(200);
  // The laptop opens the media at 0:05 and leaves it there.
  await openPlayer(laptop, other);
  await expect(
    laptop.getByRole('button', { name: 'Continuar de 0:05' }),
  ).toBeVisible();
  // Meanwhile the phone saves 0:12.
  const phone = await pageAs(browser, email, null);
  const newer = await phone.request.put(`/api/v1/media/${other.id}/progress`, {
    data: {
      positionMs: 12_000,
      basedOn: (await first.json()).positionUpdatedAt,
    },
    headers,
  });
  expect(newer.status()).toBe(200);
  await phone.context().close();
  // The laptop's tab is hidden, then closed: the server keeps the phone's 0:12.
  await laptop.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await laptop.context().close();
  const owner = await pageAs(browser, email, null);
  await expect
    .poll(
      async () =>
        (await (await owner.request.get(`/api/v1/media/${other.id}`)).json())
          .positionMs,
    )
    .toBe(12_000);
  await owner.context().close();
});

test('BR-2: two people in one browser never see each other’s position', async ({
  browser,
}) => {
  const { page, email } = await newListener(browser, { viewport: null });
  // Saves fail for the first person: the position stays in this browser, unsent.
  await page.route('**/progress', (route) =>
    route.abort('internetdisconnected'),
  );
  await openPlayer(page, lecture);
  await page.getByRole('button', { name: 'Tocar' }).click();
  await playPast(page, 1.5);
  await page.getByRole('button', { name: 'Pausar' }).click();
  expect(
    await page.evaluate(
      (person) =>
        Object.keys(localStorage).some((key) =>
          key.startsWith(
            `kb-chat.media-position.${encodeURIComponent(person)}.`,
          ),
        ),
      email,
    ),
  ).toBe(true);
  // The first person's page goes away (its last save still fails), then another
  // person signs in on this browser: only then may saves reach the server again.
  await page.goto('about:blank');
  await page.unroute('**/progress');
  const owner = await ownerApi();
  const other = uniqueEmail('outra');
  await invite(owner, other, {
    topics: ['hermetismo'],
    features: ['search', 'media'],
  });
  await owner.dispose();
  await signIn(page.request, other);
  await openPlayer(page, lecture);
  await expect(page.getByRole('button', { name: /Continuar de/ })).toHaveCount(
    0,
  );
  expect(
    (await (await page.request.get(`/api/v1/media/${lecture.id}`)).json())
      .positionMs,
  ).toBe(0);
  await page.context().close();
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
  await expect
    .poll(async () => Math.round((await audioState(page)).currentTime))
    .toBe(5);
  // The next press lands on 10: had the global shortcut also acted, it would pass 10.
  await slider.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuenow', '10');
  await expect
    .poll(async () => Math.round((await audioState(page)).currentTime))
    .toBe(10);
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
  await page.keyboard.press('l');
  // A later action the page does see: once it shows, K and L were handled (and ignored).
  await page.getByRole('button', { name: 'Avançar 30 segundos' }).click();
  await expect
    .poll(async () => Math.round((await audioState(page)).currentTime))
    .toBe(30);
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
  // The player tells once it knows (`data-volume`): only then is "no control" an answer.
  await expect(page.locator('.options')).toHaveAttribute('data-volume', 'off');
  await expect(page.getByRole('slider', { name: 'Volume' })).toHaveCount(0);
});

test('AC-13: mute and a volume in percent where the browser allows it', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === 'media-mobile',
    'a phone uses its own buttons: no volume control (fine pointer only)',
  );
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
  await expect
    .poll(async () => (await audioState(page)).currentTime, {
      timeout: 60_000,
      intervals: [1_000],
    })
    .toBeGreaterThanOrEqual(35);
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
  await expect.poll(() => playbackRate(page)).toBe(1.25);
  // Two frames: the last interaction's timing entry is recorded.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const worst = await page.evaluate(() =>
    Math.max(
      0,
      ...(window as unknown as { interactionDurations: number[] })
        .interactionDurations,
    ),
  );
  expect(worst).toBeLessThanOrEqual(200);
});
