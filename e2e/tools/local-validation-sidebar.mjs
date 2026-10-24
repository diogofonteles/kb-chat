// KBC-005 local validation: side panel, history, collection switch and themes on the real vault.
import { chromium } from '@playwright/test';

const [out, base = 'http://localhost:4200'] = process.argv.slice(2);
const sizes = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];
const browser = await chromium.launch();
for (const { name, width, height } of sizes) {
  const page = await browser.newPage({ viewport: { width, height } });
  const mobile = width < 1024;
  const openMenu = async () => {
    if (mobile) await page.getByRole('button', { name: 'Menu' }).click();
  };
  const ask = async (question) => {
    await page.getByLabel('Sua pergunta').fill(question);
    await page.getByRole('button', { name: 'Buscar' }).click();
    await page.locator('app-result-card').first().waitFor({ timeout: 120_000 });
  };
  await page.goto(base);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByText('O que você quer estudar hoje?').waitFor();
  await ask('lei do ritmo');
  await openMenu();
  await page.getByRole('button', { name: /Nova conversa/ }).click();
  await ask('o que é a tábua de esmeralda');
  await openMenu();
  await page
    .getByText(/US\$ \d/)
    .first()
    .waitFor();
  await page.screenshot({ path: `${out}/${name}-1-history-light.png` });
  // On phones the drawer stays open while the theme changes.
  for (const theme of ['dark', 'esoteric']) {
    await page.getByLabel('Tema').selectOption(theme);
    await page.screenshot({ path: `${out}/${name}-2-${theme}.png` });
  }
  await page.getByLabel('Tema').selectOption('auto');
  const history = page.getByRole('navigation', { name: /Histórico/ });
  await history.getByRole('button', { name: /lei do ritmo/ }).click();
  await page.locator('app-result-card').first().waitFor({ timeout: 120_000 });
  await page.screenshot({ path: `${out}/${name}-3-restored.png` });
  await page.close();
}
await browser.close();
