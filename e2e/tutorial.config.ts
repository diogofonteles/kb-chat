import { defineConfig, devices } from '@playwright/test';
import { requireFittingNode } from '../tools/check-node.mjs';
import { privateTemp } from '../tools/test-temp.mjs';

// A Node whose SQLite lacks FTS5 stops here, naming the Node to use, before the servers
// start (the workers load this file too: the runner has checked already).
if (!process.env['TEST_WORKER_INDEX']) requireFittingNode();
privateTemp();

// The tutorial's screenshots (KBC-032): `pnpm tutorial:screenshots`. Its own ports, so it runs
// beside `pnpm e2e` and the dev servers; a fresh E2E server (fixture vault, fake AI) each run.
const API_PORT = process.env['KBC_E2E_API_PORT'] ?? '3118';
const WEB_PORT = process.env['KBC_E2E_WEB_PORT'] ?? '4318';
const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;
const reuse = process.env['KBC_TUTORIAL_REUSE'] === '1';

export default defineConfig({
  testDir: './tutorial',
  testMatch: 'capture.ts',
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  timeout: 120_000,
  expect: { timeout: 20_000 },
  use: {
    ...devices['Desktop Chrome'],
    baseURL: WEB_ORIGIN,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    colorScheme: 'light',
    // Off the machine's speakers (see MUTE_AUDIO in playwright.config.ts).
    launchOptions: { args: ['--mute-audio'] },
  },
  webServer: [
    {
      command: 'pnpm --filter @kb-chat/api run e2e:server',
      url: `http://localhost:${API_PORT}/health`,
      env: { PORT: API_PORT, WEB_ORIGIN },
      reuseExistingServer: reuse,
      timeout: 60_000,
    },
    {
      command: `pnpm --filter @kb-chat/web exec ng serve --port ${WEB_PORT} --no-live-reload --no-hmr --proxy-config ../../e2e/proxy.e2e.mjs`,
      env: { KBC_E2E_API_PORT: API_PORT },
      url: WEB_ORIGIN,
      reuseExistingServer: reuse,
      timeout: 180_000,
    },
  ],
});
