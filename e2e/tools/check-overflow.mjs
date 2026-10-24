// Checks horizontal overflow at 390 px on the running dev servers (real vault), with a filter applied.
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const overflow = () =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
await page.goto('http://localhost:4200/');
await page.getByLabel('Sua pergunta').fill('proteção espiritual');
await page.getByRole('button', { name: 'Buscar' }).click();
await page.locator('app-result-card').first().waitFor();
console.log('overflow without filter:', await overflow());
await page.getByRole('button', { name: 'Filtros', exact: true }).click();
const sheet = page.getByRole('dialog', { name: 'Filtros' });
await sheet.getByRole('checkbox', { name: /Forças Negativas/ }).check();
await sheet.getByRole('button', { name: 'Aplicar' }).click();
await page.getByRole('button', { name: /Remover Assuntos/ }).waitFor();
console.log('overflow with filter:', await overflow());
await page.screenshot({ path: process.argv[2] });
await browser.close();
