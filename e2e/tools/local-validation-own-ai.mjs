// KBC-023 local validation: "Sua IA" (guide per option, OpenRouter connected by the fake,
// the Google key tested, the status card) at 1440 and 390 px, on the E2E servers.
// Usage: node e2e/tools/local-validation-own-ai.mjs http://localhost:4323 <dir>
import { chromium } from '@playwright/test';

const [base, out] = process.argv.slice(2);
const CSRF = { 'x-requested-with': 'kb-chat' };
const browser = await chromium.launch();

async function signIn(request, email) {
  const token = await request.post(`${base}/api/e2e/token`, {
    data: { email },
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

async function settings(page, width) {
  if (width < 1024) await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Configurações' }).click();
  return page.getByRole('dialog', { name: 'Configurações' });
}

const report = [];
for (const width of [1440, 390]) {
  const owner = await browser.newContext();
  await signIn(owner.request, 'owner@kb-chat.test');
  const email = `lv23-${width}-${Date.now()}@kb-chat.test`;
  const invited = await owner.request.post(`${base}/api/v1/people`, {
    data: { email },
    headers: CSRF,
  });
  const { id } = await invited.json();
  await owner.request.patch(`${base}/api/v1/people/${id}`, {
    data: {
      topics: ['hermetismo'],
      features: ['search', 'research', 'own-ai-settings'],
    },
    headers: CSRF,
  });
  await owner.close();
  const context = await browser.newContext({
    viewport: { width, height: 900 },
  });
  const page = await context.newPage();
  await page.route('https://accounts.google.com/**', (r) =>
    r.fulfill({ body: '' }),
  );
  await signIn(page.request, email);
  await page.goto(base);
  await page.getByRole('button', { name: 'Pular' }).click();
  let dialog = await settings(page, width);
  await dialog.getByRole('radio', { name: /^OpenRouter/ }).check();
  await page.waitForTimeout(400);
  await dialog
    .getByRole('region', { name: 'Como configurar' })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/openrouter-guide-${width}.png` });
  await dialog.getByRole('button', { name: 'Conectar OpenRouter' }).click();
  await page.waitForURL((url) => !url.search.includes('openrouter='));
  dialog = page.getByRole('dialog', { name: 'Configurações' });
  await dialog.getByText('Conta conectada.').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/openrouter-connected-${width}.png` });
  await dialog.getByRole('radio', { name: /Gemini/ }).check();
  await dialog.getByLabel(/Chave da API/).fill('AIza-lv-valid');
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await dialog.getByText('Salvo.').waitFor();
  await dialog.getByRole('button', { name: 'Testar conexão' }).click();
  await dialog.getByText(/Conexão funcionando/).waitFor();
  await dialog
    .getByRole('region', { name: 'Como configurar' })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/gemini-guide-${width}.png` });
  await dialog.getByRole('button', { name: 'Fechar configurações' }).click();
  dialog = await settings(page, width);
  await dialog.getByText('Quem atende você agora').waitFor();
  await page.waitForFunction(() => document.getAnimations().length === 0);
  await page.screenshot({ path: `${out}/status-${width}.png` });
  report.push(`own-ai ${width}: overflow ${await overflow(page)}`);
  await context.close();
}
await browser.close();
console.log(report.join('\n'));
