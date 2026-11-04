// KBC-031 local validation: the owner's "Assinatura do ChatGPT" card in ⚙ Sua IA on the E2E
// servers (Codex behind the real runner, with the fake Codex), at 1440 and 390 px. Real states:
// off in "IA da aplicação" (fresh server), then on and tested through the runner. The runner's
// logged-out and down states are proven by the API tests; here their copy is shown by
// answering /api/v1/ai/providers with that reason.
// With `invite`: the owner lends his Claude subscription in "Configurar agora" (confirmation,
// then the confirmed note), at both widths.
// Usage: node e2e/tools/local-validation-subscription-card.mjs http://localhost:4231 <dir> [invite]
import { chromium } from '@playwright/test';

const [base, out, mode = 'card'] = process.argv.slice(2);
const CSRF = { 'x-requested-with': 'kb-chat' };
const browser = await chromium.launch({ args: ['--mute-audio'] });

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

async function ownerPage(width) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
  });
  const page = await context.newPage();
  await page.route('https://accounts.google.com/**', (r) =>
    r.fulfill({ body: '' }),
  );
  await signIn(page.request, 'owner@kb-chat.test');
  return page;
}

/** Opens ⚙ Sua IA and returns the ChatGPT card. */
async function chatgptCard(page, width) {
  await page.goto(base);
  if (width < 1024) await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Configurações' }).click();
  const dialog = page.getByRole('dialog', { name: 'Configurações' });
  const radio = dialog.getByRole('radio', { name: /Assinatura do ChatGPT/ });
  await radio.waitFor();
  const card = dialog.locator('label.card', {
    has: page.locator('input[value="chatgpt-subscription"]'),
  });
  await card.scrollIntoViewIfNeeded();
  await settled(page);
  return { dialog, radio, card };
}

/** Answers the providers list with one reason for the ChatGPT card (copy only). */
async function withReason(page, reason) {
  await page.route('**/api/v1/ai/providers', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const item of body.items)
      if (item.id === 'chatgpt-subscription')
        Object.assign(item, { available: false, reason });
    await route.fulfill({ response, json: body });
  });
}

const report = [];
const shot = async (page, card, name, width) => {
  await card.screenshot({ path: `${out}/card-${name}-${width}.png` });
  report.push({
    name,
    width,
    text: (await card.innerText()).replace(/\s+/g, ' ').trim(),
    overflow: await overflow(page),
  });
};

async function validateInvite() {
  for (const width of [1440, 390]) {
    const page = await ownerPage(width);
    await page.goto(base);
    if (width < 1024) await page.getByRole('button', { name: 'Menu' }).click();
    await page
      .getByRole('button', { name: /Pessoas e permissões/ })
      .first()
      .click();
    const dialog = page.getByRole('dialog', { name: 'Configurações' });
    await dialog.getByRole('button', { name: 'Configurar agora' }).click();
    const preset = dialog.locator('#invite-preset');
    const select = preset.getByLabel('Qual IA atende a pessoa');
    await select.selectOption({ label: 'Claude do administrador' });
    const confirm = preset.getByRole('group', {
      name: 'Ceder a assinatura do Claude a quem você está convidando?',
    });
    await confirm.scrollIntoViewIfNeeded();
    await settled(page);
    await page.screenshot({ path: `${out}/invite-lend-confirm-${width}.png` });
    // "Convidar" waits, and says why, while the terms are open (design R1-2).
    await dialog
      .getByLabel('Convidar por e-mail')
      .fill('validacao@kb-chat.test');
    const send = dialog.getByRole('button', { name: 'Convidar' });
    await send.scrollIntoViewIfNeeded();
    await settled(page);
    await page.screenshot({ path: `${out}/invite-lend-waits-${width}.png` });
    report.push({
      name: 'invite-waits',
      width,
      disabled: await send.isDisabled(),
      describedBy: await send.getAttribute('aria-describedby'),
      overflow: await overflow(page),
    });
    await confirm.scrollIntoViewIfNeeded();
    report.push({
      name: 'invite-confirm',
      width,
      focused: await confirm
        .getByRole('button', { name: 'Cancelar' })
        .evaluate((button) => button === document.activeElement),
      overflow: await overflow(page),
    });
    await confirm.getByRole('button', { name: 'Ceder assim mesmo' }).click();
    const note = preset.getByText('Termos da assinatura do Claude confirmados');
    await note.scrollIntoViewIfNeeded();
    await settled(page);
    await page.screenshot({
      path: `${out}/invite-lend-confirmed-${width}.png`,
    });
    report.push({
      name: 'invite-confirmed',
      width,
      overflow: await overflow(page),
    });
    await page.context().close();
  }
}

if (mode === 'invite') {
  await validateInvite();
  await browser.close();
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

for (const width of [1440, 390]) {
  const page = await ownerPage(width);
  const off = await chatgptCard(page, width);
  report.push({ disabledWhenOff: await off.radio.isDisabled(), width });
  await shot(page, off.card, 'house-off', width);
  await page.context().close();
}

const owner = await ownerPage(1440);
await owner.request.put(`${base}/api/v1/house-ai`, {
  data: { codexEnabled: true },
  headers: CSRF,
});
await owner.context().close();

for (const width of [1440, 390]) {
  const page = await ownerPage(width);
  const on = await chatgptCard(page, width);
  await on.radio.check();
  await on.dialog.getByRole('button', { name: 'Testar conexão' }).click();
  const result = on.dialog.getByText(/Conexão funcionando/);
  await result.waitFor();
  await result.scrollIntoViewIfNeeded();
  await settled(page);
  await page.screenshot({ path: `${out}/card-on-tested-${width}.png` });
  report.push({
    name: 'on-tested',
    width,
    text: await result.innerText(),
    overflow: await overflow(page),
  });
  await page.context().close();
  for (const reason of ['login-required', 'sandbox-unavailable']) {
    const shown = await ownerPage(width);
    await withReason(shown, reason);
    const { card } = await chatgptCard(shown, width);
    await shot(shown, card, reason, width);
    await shown.context().close();
  }
}

await browser.close();
console.log(JSON.stringify(report, null, 2));
