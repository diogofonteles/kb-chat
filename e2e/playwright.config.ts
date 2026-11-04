import { defineConfig, devices, webkit } from '@playwright/test';

// Overridable so a second checkout (a worktree) can run beside the default ports.
const API_PORT = process.env['KBC_E2E_API_PORT'] ?? '3117';
const WEB_PORT = process.env['KBC_E2E_WEB_PORT'] ?? '4317';
const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;
/** The media specs: they need a browser that plays AAC (see the media projects). */
const MEDIA_SPECS = /media-.*\.spec\.ts$/;
/**
 * The media specs play real tones (330 Hz, up to minutes long): keep them off the
 * machine's speakers. Chrome mutes its output only; `muted` and `volume` stay as the
 * page set them, so the player's assertions still hold.
 */
const MUTE_AUDIO = ['--mute-audio'];
/**
 * WebKit has no switch to mute its output, so every WebKit browser the tests launch sends
 * the page's media through a Web Audio gain of zero: the element plays, seeks and keeps
 * its `muted` and `volume`, but nothing reaches the speakers. (This file loads in every
 * worker, before the `browser` fixture launches WebKit.)
 */
const SILENT_MEDIA = () => {
  const routed = new WeakSet<HTMLMediaElement>();
  let audio: AudioContext | undefined;
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    if (!routed.has(this)) {
      routed.add(this);
      try {
        audio ??= new AudioContext();
        const silence = audio.createGain();
        silence.gain.value = 0;
        audio
          .createMediaElementSource(this)
          .connect(silence)
          .connect(audio.destination);
        void audio.resume();
      } catch {
        // Not routable (already routed elsewhere): leave it as the page set it.
      }
    }
    return play.call(this);
  };
};
// CI has no speakers, and the route delays the player's clock on its slower runners.
if (!process.env.CI) {
  const launchWebkit = webkit.launch.bind(webkit);
  webkit.launch = async (options) => {
    const browser = await launchWebkit(options);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (contextOptions) => {
      const context = await newContext(contextOptions);
      await context.addInitScript(SILENT_MEDIA);
      return context;
    };
    return browser;
  };
}
/** WebKit runs locally only on demand (`KBC_E2E_WEBKIT=1 pnpm e2e`); always in CI. */
const WITH_WEBKIT = !!process.env.CI || process.env['KBC_E2E_WEBKIT'] === '1';

/**
 * E2E against the real API on the fixture vault (KB_CHAT_SEARCH=fixture: no QMD,
 * no models) and the Angular dev server. Desktop 1440 px and mobile 390 px.
 */
export default defineConfig({
  testDir: './specs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: WEB_ORIGIN,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      testIgnore: MEDIA_SPECS,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'mobile',
      testIgnore: MEDIA_SPECS,
      use: { ...devices['Pixel 5'], viewport: { width: 390, height: 844 } },
    },
    // Media (KBC-034, phase-2 quality bar): Playwright's Chromium cannot decode AAC or
    // H.264, so media specs run in Google Chrome at both widths and in WebKit (Safari).
    {
      name: 'media-desktop',
      testMatch: MEDIA_SPECS,
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        viewport: { width: 1440, height: 900 },
        launchOptions: { args: MUTE_AUDIO },
      },
    },
    {
      name: 'media-mobile',
      testMatch: MEDIA_SPECS,
      use: {
        ...devices['Pixel 5'],
        channel: 'chrome',
        viewport: { width: 390, height: 844 },
        launchOptions: { args: MUTE_AUDIO },
      },
    },
    ...(WITH_WEBKIT
      ? [
          {
            name: 'media-webkit',
            testMatch: MEDIA_SPECS,
            use: {
              ...devices['Desktop Safari'],
              viewport: { width: 1440, height: 900 },
            },
          },
        ]
      : []),
  ],
  webServer: [
    {
      command: 'pnpm --filter @kb-chat/api run e2e:server',
      url: `http://localhost:${API_PORT}/health`,
      env: { PORT: API_PORT, WEB_ORIGIN },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `pnpm --filter @kb-chat/web exec ng serve --port ${WEB_PORT} --proxy-config ../../e2e/proxy.e2e.mjs`,
      env: { KBC_E2E_API_PORT: API_PORT },
      url: WEB_ORIGIN,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
