// Screenshots of Configurações and of the first-run wizard (KBC-007), desktop and phone.
// Usage: node tools/shot-settings.mjs http://localhost:4317 <out-dir>
import { chromium } from '@playwright/test';

const [base, out] = process.argv.slice(2);
const VIEW = {
  exists: false,
  preferences: { searchMode: 'all', theme: 'auto', defaultView: 'research' },
  ai: { provider: null, keys: {}, dailyCapUsd: 1 },
};

async function settled(page) {
  await page.waitForFunction(() => document.getAnimations().length === 0);
}

async function shootSettings(page, name) {
  await page.goto(base);
  if (name === 'mobile')
    await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Configurações' }).click();
  const dialog = page.getByRole('dialog', { name: 'Configurações' });
  await dialog.getByRole('radio', { name: /OpenAI API/ }).check();
  await settled(page);
  await page.screenshot({ path: `${out}/${name}-settings-ai.png` });
  await dialog.getByRole('button', { name: 'Preferências' }).click();
  await dialog.getByLabel('Acervo padrão').waitFor();
  await page.screenshot({ path: `${out}/${name}-settings-preferences.png` });
}

async function shootWizard(page, name) {
  await page.route('**/api/v1/settings', (route) =>
    route.fulfill({ json: VIEW }),
  );
  await page.goto(base);
  await page
    .getByRole('heading', { name: 'Como a IA vai responder?' })
    .waitFor();
  await settled(page);
  await page.screenshot({ path: `${out}/${name}-wizard-1.png` });
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.screenshot({ path: `${out}/${name}-wizard-2.png` });
}

const browser = await chromium.launch({ args: ['--mute-audio'] });
for (const [name, width, height, scheme] of [
  ['desktop', 1440, 900, 'light'],
  ['mobile', 390, 844, 'light'],
  ['desktop-dark', 1440, 900, 'dark'],
]) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: scheme,
  });
  const kind = name.startsWith('mobile') ? 'mobile' : 'desktop';
  await shootSettings(await context.newPage(), name === kind ? kind : name);
  await shootWizard(await context.newPage(), name);
  await context.close();
}
await browser.close();
