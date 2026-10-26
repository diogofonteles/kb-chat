// Local validation screenshots against the running dev servers and the real vault.
import { chromium } from '@playwright/test';

const out = process.argv[2];
const widths = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];
const browser = await chromium.launch();
for (const { name, width, height } of widths) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto('http://localhost:4200/');
  await page.getByText('O que você quer estudar hoje?').waitFor();
  await page.screenshot({ path: `${out}/${name}-1-start.png` });
  await page
    .getByLabel('Sua pergunta')
    .fill('como se proteger de energias negativas');
  await page.getByRole('button', { name: 'Buscar' }).click();
  await page.locator('app-result-card').first().waitFor();
  await page.screenshot({ path: `${out}/${name}-2-results.png` });
  await page.locator('app-result-card').first().click();
  await page.getByRole('dialog').locator('.body').waitFor();
  await page.screenshot({ path: `${out}/${name}-3-document.png` });
  await page.close();
}
await browser.close();
