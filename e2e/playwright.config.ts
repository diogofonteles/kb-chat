import { defineConfig, devices } from '@playwright/test';

const API_PORT = '3117';
const WEB_PORT = '4317';
const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;

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
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 5'], viewport: { width: 390, height: 844 } },
    },
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
      command: `pnpm --filter @kb-chat/web exec ng serve --port ${WEB_PORT} --proxy-config ../../e2e/proxy.e2e.json`,
      url: WEB_ORIGIN,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
