// KBC-022 local validation: "IA da aplicação" (connect through the fake OpenRouter), the
// person's AI access and the bulk bar in "Pessoas e permissões", the status card, a free
// house answer and a spent quota, at 1440 and 390 px (E2E servers, fake OpenRouter).
// Usage: node e2e/tools/local-validation-house-ai.mjs http://localhost:4323 <dir>
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

async function settingsAt(page, width, section) {
  if (width < 1024) await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Configurações' }).click();
  const dialog = page.getByRole('dialog', { name: 'Configurações' });
  await dialog.getByRole('button', { name: section }).click();
  return dialog;
}

const report = [];
for (const width of [1440, 390]) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
  });
  const page = await context.newPage();
  await page.route('https://accounts.google.com/**', (r) =>
    r.fulfill({ body: '' }),
  );
  await signIn(page.request, 'owner@kb-chat.test');
  await page.goto(base);
  let dialog = await settingsAt(page, width, 'IA da aplicação');
  await dialog
    .getByRole('button', { name: /Conectar (OpenRouter|outra conta)/ })
    .click();
  await page.waitForURL((url) => !url.search.includes('openrouter='));
  dialog = page.getByRole('dialog', { name: 'Configurações' });
  await dialog.getByText('Conta conectada.').waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/house-${width}.png`, fullPage: false });
  await dialog
    .locator('.content')
    .evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.screenshot({ path: `${out}/house-bottom-${width}.png` });
  report.push(`house ${width}: overflow ${await overflow(page)}`);

  const email = `lv-${width}-${Date.now()}@kb-chat.test`;
  const invited = await page.request.post(`${base}/api/v1/people`, {
    data: { email },
    headers: CSRF,
  });
  const { id } = await invited.json();
  await page.request.patch(`${base}/api/v1/people/${id}`, {
    data: {
      topics: ['hermetismo'],
      features: ['search', 'research'],
      ai: { appAi: 'house', dailyResearches: 2 },
    },
    headers: CSRF,
  });
  await dialog.getByRole('button', { name: 'Pessoas e permissões' }).click();
  await dialog.getByRole('button', { name: new RegExp(email) }).click();
  await dialog.getByText('Qual IA atende esta pessoa').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/person-ai-${width}.png` });
  await dialog
    .getByText('IA da aplicação para várias pessoas')
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/bulk-${width}.png` });
  await dialog
    .getByRole('button', { name: 'Aplicar a todos os usuários' })
    .click();
  await page.screenshot({ path: `${out}/bulk-confirm-${width}.png` });
  await dialog.getByRole('button', { name: 'Cancelar' }).first().click();
  const daily = dialog.getByLabel('Pesquisas por dia (vazio = padrão)');
  await daily.fill('-1');
  await daily.press('Tab');
  await daily.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/person-error-${width}.png` });
  report.push(`people ${width}: overflow ${await overflow(page)}`);

  const person = await browser.newContext({ viewport: { width, height: 900 } });
  const p = await person.newPage();
  await p.route('https://accounts.google.com/**', (r) =>
    r.fulfill({ body: '' }),
  );
  await signIn(p.request, email);
  await p.goto(base);
  for (const profile of ['Profundo', 'Rápido']) {
    await p.getByRole('radio', { name: profile }).check();
    await p
      .getByLabel('Sua pergunta')
      .fill(`o que é o mentalismo? (${profile})`);
    await p.getByRole('button', { name: 'Perguntar' }).click();
    await p
      .locator('app-research-message')
      .last()
      .locator('.footer, .error')
      .first()
      .waitFor();
  }
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${out}/answers-${width}.png`, fullPage: true });
  report.push(`answers ${width}: overflow ${await overflow(p)}`);
  await person.close();
  await context.close();
}
await browser.close();
console.log(report.join('\n'));
