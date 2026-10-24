// KBC-006 local validation: start suggestions on the real vault and the usage log it produces.
import { chromium } from '@playwright/test';

const [out, base = 'http://localhost:4200'] = process.argv.slice(2);
const browser = await chromium.launch();
for (const { name, width, height } of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(base);
  const group = page.getByRole('group', { name: 'Comece por um assunto:' });
  await group.getByRole('button').first().waitFor();
  await page.screenshot({ path: `${out}/${name}-1-suggestions.png` });
  await group.getByRole('button').nth(3).click();
  await page.locator('app-result-card').first().waitFor({ timeout: 120_000 });
  await page.locator('app-result-card').nth(1).click();
  await page.getByRole('dialog').locator('.body').waitFor();
  await page.screenshot({ path: `${out}/${name}-2-opened.png` });
  await page.close();
}
await browser.close();
