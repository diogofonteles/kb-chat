// Screenshot of the start screen and of a conversation, for the layout check.
import { chromium } from '@playwright/test';

const [base, out] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--mute-audio'] });
for (const [name, width, height] of [
  ['desktop', 1440, 900],
  ['mobile', 390, 844],
]) {
  const page = await browser.newPage({
    viewport: { width, height },
    colorScheme: 'dark',
  });
  await page.goto(base);
  await page.getByText('O que você quer estudar hoje?').waitFor();
  await page.screenshot({ path: `${out}/${name}-home.png` });
  await page.getByLabel('Sua pergunta').fill('princípios herméticos');
  await page.keyboard.press('Enter');
  await page.locator('app-result-card').first().waitFor();
  await page.screenshot({ path: `${out}/${name}-after.png` });
  await page.close();
}
await browser.close();
