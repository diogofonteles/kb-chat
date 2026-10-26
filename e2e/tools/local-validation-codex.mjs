// KBC-027 local validation: the Codex card in "IA da aplicação", lending the ChatGPT
// subscription (OpenAI terms) and the person's notice and answer, at 1440 and 390 px, on
// the E2E servers (Codex through the real runner, with the fake Codex).
// Usage: node e2e/tools/local-validation-codex.mjs http://localhost:4326 <dir>
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
const settled = (page) =>
  page.waitForFunction(() => document.getAnimations().length === 0);

async function settings(page, width) {
  if (width < 1024) await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Configurações' }).click();
  return page.getByRole('dialog', { name: 'Configurações' });
}

async function pageFor(email, width) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
  });
  const page = await context.newPage();
  await page.route('https://accounts.google.com/**', (r) =>
    r.fulfill({ body: '' }),
  );
  await signIn(page.request, email);
  return page;
}

const report = [];
for (const width of [1440, 390]) {
  const owner = await pageFor('owner@kb-chat.test', width);
  await owner.goto(base);
  let dialog = await settings(owner, width);
  await dialog.getByRole('button', { name: 'IA da aplicação' }).click();
  const block = dialog.getByRole('region', {
    name: 'Assinatura do ChatGPT (Codex)',
  });
  await block.getByText('Logado no servidor.').waitFor();
  const toggle = block.getByRole('checkbox', {
    name: 'Ligar a assinatura do ChatGPT (Codex)',
  });
  if (!(await toggle.isChecked())) await toggle.check();
  await block.scrollIntoViewIfNeeded();
  await settled(owner);
  await owner.screenshot({ path: `${out}/codex-card-${width}.png` });
  report.push(`card ${width}: overflow ${await overflow(owner)}`);

  const email = `lv27-${width}-${Date.now()}@kb-chat.test`;
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
  await dialog.getByRole('button', { name: 'Pessoas e permissões' }).click();
  await dialog.getByRole('button', { name: new RegExp(email) }).click();
  const fieldset = dialog.getByRole('group', { name: 'IA da aplicação' });
  await fieldset
    .getByLabel('Qual IA atende esta pessoa')
    .selectOption({ label: 'ChatGPT do administrador' });
  await fieldset
    .getByRole('button', { name: 'Cancelar' })
    .scrollIntoViewIfNeeded();
  await settled(owner);
  await owner.screenshot({ path: `${out}/lend-gpt-confirm-${width}.png` });
  await fieldset.getByRole('button', { name: 'Ceder assim mesmo' }).click();
  await dialog.getByRole('status').filter({ hasText: 'Salvo.' }).waitFor();
  await owner.context().close();

  const person = await pageFor(email, width);
  await person.goto(base);
  await person.getByRole('button', { name: 'Pular' }).click();
  dialog = await settings(person, width);
  await dialog.getByText('Quem atende você agora').waitFor();
  await settled(person);
  await person.screenshot({ path: `${out}/lent-gpt-notice-${width}.png` });
  report.push(`person ${width}: overflow ${await overflow(person)}`);
  await dialog.getByRole('button', { name: 'Fechar configurações' }).click();
  if (width < 1024)
    await person.getByRole('button', { name: 'Fechar menu' }).click();
  await person.getByLabel('Sua pergunta').fill('o que é o ritmo?');
  await person.getByRole('button', { name: 'Perguntar' }).click();
  const footer = person.getByText(
    'IA da aplicação (assinatura do ChatGPT do administrador)',
  );
  await footer.waitFor();
  await footer.scrollIntoViewIfNeeded();
  await settled(person);
  await person.screenshot({ path: `${out}/lent-gpt-answer-${width}.png` });
  await person.context().close();
}
await browser.close();
console.log(report.join('\n'));
