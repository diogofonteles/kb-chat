// KBC-018 local validation: an exhaustive turn whose orchestrator delegates to two
// sub-researchers (E2E servers: fixture vault, stub model), steps expanded, at 1440 and
// 390 px. Usage: node e2e/tools/local-validation-subagents.mjs http://localhost:4218 <dir>
import { chromium } from '@playwright/test';

const [base, out] = process.argv.slice(2);
const browser = await chromium.launch();

async function signIn(page) {
  const token = await page.request.post(`${base}/api/e2e/token`, {
    data: { email: 'owner@kb-chat.test' },
    headers: { 'x-requested-with': 'kb-chat' },
  });
  const { credential } = await token.json();
  await page.request.post(`${base}/api/v1/auth/google`, {
    data: { credential },
    headers: { 'x-requested-with': 'kb-chat' },
  });
}

for (const [name, viewport] of [
  ['desktop', { width: 1440, height: 900 }],
  ['mobile', { width: 390, height: 844 }],
]) {
  const page = await browser.newPage({ viewport });
  await signIn(page);
  await page.goto(`${base}/`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('radio', { name: 'Exaustivo' }).check();
  await page.getByLabel('Sua pergunta').fill('todas as obras sobre o ritmo');
  await page.getByRole('button', { name: 'Perguntar' }).click();
  await page.getByText(/Resposta gerada por IA/).waitFor();
  const summary = page.locator('details.steps summary').last();
  const line = await summary.innerText();
  await summary.click();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  await page.screenshot({
    path: `${out}/${name}-subagents.png`,
    fullPage: true,
  });
  console.log(`${name}: summary "${line.trim()}", overflow ${overflow}px`);
  await page.close();
}
await browser.close();
