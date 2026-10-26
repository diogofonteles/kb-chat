// Visible walkthrough of a real AI answer (real vault + OpenRouter) for the owner to watch.
import { chromium, expect } from '@playwright/test';

const [base, shot] = process.argv.slice(2);
const browser = await chromium.launch({ headless: false, slowMo: 300 });
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  colorScheme: 'dark',
});
await page.goto(base);
await page
  .getByLabel('Sua pergunta')
  .pressSequentially('quais são os princípios herméticos?', { delay: 35 });
await page.keyboard.press('Enter');
const ai = page.locator('app-ai-answer');
const button = ai.getByRole('button', { name: /Responder com IA/ });
await expect(button).toBeVisible({ timeout: 20_000 });
await page.waitForTimeout(800);
await button.click();
await expect(ai.getByText(/Custo: US\$/)).toBeVisible({ timeout: 60_000 });
await page.screenshot({ path: shot });
await ai
  .getByRole('link', { name: /^Fonte 1:/ })
  .first()
  .click();
await expect(page.getByRole('dialog')).toBeVisible();
await page.waitForTimeout(3000);
console.log('answer:', (await ai.locator('.answer').innerText()).slice(0, 600));
console.log(await ai.locator('.footer').innerText());
await browser.close();
