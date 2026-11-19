import { defineConfig, devices, webkit } from '@playwright/test';
import { requireFittingNode } from '../tools/check-node.mjs';
import { privateTemp } from '../tools/test-temp.mjs';

// A Node whose SQLite lacks FTS5 stops here, naming the Node to use, before the servers
// start (the workers load this file too: the runner has checked already).
if (!process.env['TEST_WORKER_INDEX']) requireFittingNode();
// Here and not in a global setup: the web servers start before it.
privateTemp();

// Overridable so a second checkout (a worktree) can run beside the default ports.
const API_PORT = process.env['KBC_E2E_API_PORT'] ?? '3117';
const WEB_PORT = process.env['KBC_E2E_WEB_PORT'] ?? '4317';
const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;
/** The media specs: they need a browser that plays AAC (see the media projects). */
const MEDIA_SPECS = /media-.*\.spec\.ts$/;
/** The specs that also run in WebKit at both widths (with KBC_E2E_WEBKIT=1, and in CI). */
const WEBKIT_SPECS = /v2-shell-works\.spec\.ts$/;
/** v2 · Conversa's controls and scroll, also run in WebKit (see the chat-webkit projects). */
const CHAT_WEBKIT_SPECS = /(v2-chat-interactions|content-scroll)\.spec\.ts$/;
/** content-scroll's pages of other areas (Configurações, Biblioteca, catalog) stay out. */
const NOT_CHAT = /pages in the main panel/;
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
          // The shell, the entry screens and the public pages work in Safari too: scroll,
          // controls, fields, menus (v2 fidelity, KBC-124/KBC-125).
          {
            name: 'webkit-desktop',
            testMatch: WEBKIT_SPECS,
            use: {
              ...devices['Desktop Safari'],
              viewport: { width: 1440, height: 900 },
            },
          },
          {
            name: 'webkit-mobile',
            testMatch: WEBKIT_SPECS,
            use: {
              ...devices['iPhone 13'],
              // Playwright's mobile WebKit refuses the wheel, the only scroll it can send:
              // a 390 touch screen without the mobile flag keeps the phone layout.
              isMobile: false,
              viewport: { width: 390, height: 844 },
            },
          },
          // v2 · Conversa in Safari at both widths (KBC-126/KBC-127): its controls and the
          // scroll of its text.
          {
            name: 'chat-webkit-desktop',
            testMatch: CHAT_WEBKIT_SPECS,
            grepInvert: NOT_CHAT,
            use: {
              ...devices['Desktop Safari'],
              viewport: { width: 1440, height: 900 },
            },
          },
          // Safari's engine at a phone's width, with touch: Playwright's mobile WebKit has
          // no wheel, and the scroll checks turn the wheel (content-scroll.spec).
          {
            name: 'chat-webkit-mobile',
            testMatch: CHAT_WEBKIT_SPECS,
            grepInvert: NOT_CHAT,
            use: {
              ...devices['Desktop Safari'],
              viewport: { width: 390, height: 844 },
              hasTouch: true,
            },
          },
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
