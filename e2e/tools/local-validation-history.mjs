// KBC-029 local validation: a question in the history as soon as it is sent, a reload in the
// middle of the research, "Parar" and a failure, at 1440 and 390 px, on the E2E servers (the
// stub agent is slow with "[lento]" in the question and fails with "[falha]").
// Usage: node e2e/tools/local-validation-history.mjs http://localhost:4229 <dir>
import { chromium } from '@playwright/test';

const [base, out] = process.argv.slice(2);
const CSRF = { 'x-requested-with': 'kb-chat' };
const browser = await chromium.launch({ args: ['--mute-audio'] });

async function signIn(request) {
  const token = await request.post(`${base}/api/e2e/token`, {
    data: { email: 'owner@kb-chat.test' },
    headers: CSRF,
  });
  const { credential } = await token.json();
  await request.post(`${base}/api/v1/auth/google`, {
    data: { credential },
    headers: CSRF,
  });
}

const overflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

async function shot(page, name) {
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(name, 'overflow', await overflow(page));
}

async function run({ name, width, height }) {
  const context = await browser.newContext({
    baseURL: base,
    viewport: { width, height },
  });
  const page = await context.newPage();
  await signIn(page.request);
  const mobile = width < 1024;
  const menu = async () => {
    if (mobile) await page.getByRole('button', { name: 'Menu' }).click();
  };
  const closeMenu = async () => {
    if (mobile) await page.keyboard.press('Escape');
  };
  const ask = async (question, button = 'Perguntar') => {
    await page.getByLabel('Sua pergunta').fill(question);
    await page.getByRole('button', { name: button }).click();
  };
  await page.goto('/');
  await page.getByLabel('Sua pergunta').waitFor();

  // 1. Submit: the conversation is at the top of the history at once, "pesquisando…".
  await ask(`natureza sétupla [lento] ${name}`);
  await page.getByRole('button', { name: 'Parar' }).waitFor();
  await menu();
  await page.getByText('pesquisando…').first().waitFor();
  await shot(page, `1-submitted-pesquisando-${width}`);
  await closeMenu();

  // 2. Reload in the middle: the conversation comes back and the answer arrives.
  await page.reload();
  await page.getByRole('button', { name: 'Parar' }).waitFor();
  await shot(page, `2-reloaded-running-${width}`);
  await page
    .locator('app-research-message')
    .getByText(/Segundo o acervo/)
    .waitFor({ timeout: 30_000 });
  await shot(page, `3-reloaded-answered-${width}`);

  // 3. "Parar": the question stays as "interrompida", with "Tentar de novo".
  await menu();
  await page.getByRole('button', { name: /Nova conversa/ }).click();
  await ask(`polaridade [lento] ${name}`);
  await page.getByRole('button', { name: 'Parar' }).click();
  await menu();
  await page.getByText('interrompida').first().waitFor();
  await shot(page, `4-stopped-interrompida-${width}`);
  await closeMenu();

  // 4. A failure: "falhou" in the history, the error and "Tentar de novo" on screen.
  await menu();
  await page.getByRole('button', { name: /Nova conversa/ }).click();
  await ask(`vibração [falha] ${name}`);
  await page.getByRole('button', { name: 'Tentar de novo' }).waitFor();
  await shot(page, `5-failed-${width}`);
  await menu();
  await page.getByText('falhou').first().waitFor();
  await shot(page, `6-failed-falhou-history-${width}`);
  await context.close();
}

for (const size of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
])
  await run(size);
await browser.close();
