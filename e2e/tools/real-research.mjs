// Real research turns against the running app (owner's provider), with screenshots.
import { chromium } from '@playwright/test';

const [out, base] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(base);
const t0 = Date.now();
const ask = async (question, n) => {
  await page.getByLabel('Sua pergunta').fill(question);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(8000);
  await page.screenshot({ path: `${out}/${n}-working.png` });
  await page
    .locator('[aria-busy="true"]')
    .first()
    .waitFor({ state: 'detached', timeout: 240_000 })
    .catch(() => {});
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/${n}-done.png`, fullPage: false });
  console.log(n, 'done in', Math.round((Date.now() - t0) / 1000), 's');
};
await page.screenshot({ path: `${out}/0-start.png` });
await ask('quais são os princípios herméticos?', 1);
await ask('me diga então quais são os 5 princípios ocultos', 2);
const texts = await page.locator('app-research-message').allInnerTexts();
console.log(texts.at(-1)?.slice(0, 1500));
await browser.close();
