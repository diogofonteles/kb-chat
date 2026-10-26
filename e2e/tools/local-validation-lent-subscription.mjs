// KBC-024 local validation: the owner lends his subscription (terms confirmation), the person's
// notice in Settings and the answer's footer, at 1440 and 390 px, on the E2E servers.
// Usage: node e2e/tools/local-validation-lent-subscription.mjs http://localhost:4324 <dir>
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
  const ownerPage = await pageFor('owner@kb-chat.test', width);
  const email = `lv24-${width}-${Date.now()}@kb-chat.test`;
  const invited = await ownerPage.request.post(`${base}/api/v1/people`, {
    data: { email },
    headers: CSRF,
  });
  const { id } = await invited.json();
  await ownerPage.request.patch(`${base}/api/v1/people/${id}`, {
    data: {
      topics: ['hermetismo'],
      features: ['search', 'research', 'own-ai-settings'],
    },
    headers: CSRF,
  });
  await ownerPage.goto(base);
  let dialog = await settings(ownerPage, width);
  await dialog.getByRole('button', { name: 'Pessoas e permissões' }).click();
  await dialog.getByRole('button', { name: new RegExp(email) }).click();
  const fieldset = dialog.getByRole('group', { name: 'IA da aplicação' });
  await fieldset
    .getByLabel('Qual IA atende esta pessoa')
    .selectOption({ label: 'Assinatura do Claude (administrador)' });
  await fieldset.getByRole('alert').scrollIntoViewIfNeeded();
  await settled(ownerPage);
  await ownerPage.screenshot({ path: `${out}/lend-confirm-${width}.png` });
  report.push(`owner ${width}: overflow ${await overflow(ownerPage)}`);
  await fieldset.getByRole('button', { name: 'Ceder assim mesmo' }).click();
  await dialog.getByText('Histórico da IA').click();
  await dialog.getByText(/termos confirmados/).scrollIntoViewIfNeeded();
  await settled(ownerPage);
  await ownerPage.screenshot({ path: `${out}/lend-history-${width}.png` });
  await ownerPage.context().close();

  const person = await pageFor(email, width);
  await person.goto(base);
  await person.getByRole('button', { name: 'Pular' }).click();
  dialog = await settings(person, width);
  await dialog.getByText('Quem atende você agora').waitFor();
  await settled(person);
  await person.screenshot({ path: `${out}/lent-notice-${width}.png` });
  report.push(`person ${width}: overflow ${await overflow(person)}`);
  await dialog.getByRole('button', { name: 'Fechar configurações' }).click();
  if (width < 1024)
    await person.getByRole('button', { name: 'Fechar menu' }).click();
  await person.getByLabel('Sua pergunta').fill('o que é o mentalismo?');
  await person.getByRole('button', { name: 'Perguntar' }).click();
  await person.getByText('Incluído na assinatura do administrador').waitFor();
  await person
    .getByText('Incluído na assinatura do administrador')
    .scrollIntoViewIfNeeded();
  await settled(person);
  await person.screenshot({ path: `${out}/lent-answer-${width}.png` });
  await person.context().close();
}
await browser.close();
console.log(report.join('\n'));
