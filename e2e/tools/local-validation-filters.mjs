// KBC-002 local validation: filters against the running dev servers and the real vault.
import { chromium } from '@playwright/test';

const out = process.argv[2];
const browser = await chromium.launch({ args: ['--mute-audio'] });
const ask = async (page) => {
  await page.goto('http://localhost:4200/');
  await page.getByLabel('Sua pergunta').fill('proteção espiritual');
  await page.getByRole('button', { name: 'Buscar' }).click();
  await page.locator('app-result-card').first().waitFor();
};

const desktop = await browser.newPage({
  viewport: { width: 1440, height: 900 },
});
await ask(desktop);
await desktop.getByRole('button', { name: /^Assuntos/ }).click();
await desktop.screenshot({ path: `${out}/desktop-1-popover.png` });
await desktop.getByRole('checkbox', { name: /Forças Negativas/ }).check();
await desktop.getByRole('button', { name: /Remover Assuntos/ }).waitFor();
await desktop.keyboard.press('Escape');
await desktop.locator('.popover').waitFor({ state: 'detached' });
await desktop.screenshot({ path: `${out}/desktop-2-filtered.png` });

const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
await ask(mobile);
await mobile.screenshot({ path: `${out}/mobile-1-results.png` });
await mobile.getByRole('button', { name: 'Filtros', exact: true }).click();
await mobile.screenshot({ path: `${out}/mobile-2-sheet.png` });
await browser.close();
