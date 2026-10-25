// KBC-014 local validation: sign-up without Google, a master's pending requests and code
// sign-in, against a dev API whose email and SMS go to its log (no RESEND_API_KEY,
// KB_CHAT_SMS=log). Codes are read from that log.
// Usage: node e2e/tools/local-validation-access.mjs <out-dir> <base-url> <api-log> <owner-email>
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const [out, base, apiLog, ownerEmail] = process.argv.slice(2);

/** The newest code the log adapter wrote for `to`, once more than `seen` messages exist. */
async function codeFor(to, seen = 0) {
  for (let tries = 0; tries < 60; tries += 1) {
    const lines = (await readFile(apiLog, 'utf8'))
      .split('\n')
      .filter((line) => line.includes('not sent (development log adapter)'))
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.to === to);
    if (lines.length > seen) return /\b(\d{6})\b/.exec(lines.at(-1).text)[1];
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no code for ${to}`);
}

const countFor = async (to) =>
  (await readFile(apiLog, 'utf8'))
    .split('\n')
    .filter(
      (line) => line.includes('not sent') && line.includes(`"to":"${to}"`),
    ).length;

async function signInWithCode(page, email) {
  await page.goto(base);
  await page.getByRole('button', { name: 'Entrar com código' }).click();
  const seen = await countFor(email);
  await page.getByLabel('Seu e-mail').fill(email);
  await page.getByRole('button', { name: 'Enviar código' }).click();
  await page.getByLabel('Código').fill(await codeFor(email, seen));
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByLabel('Sua pergunta').waitFor();
}

const browser = await chromium.launch();
// One owner session for both widths: sends are limited per email and per address (BR-5).
const ownerContext = await browser.newContext();
await ownerContext.route('https://accounts.google.com/**', (route) =>
  route.abort(),
);
await signInWithCode(await ownerContext.newPage(), ownerEmail);
for (const { name, width, height } of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  const shot = (page, step) =>
    page.screenshot({ path: `${out}/${name}-${step}.png`, fullPage: true });
  const email = `lv-${name}-${Date.now()}@example.com`;
  const person = await browser.newPage({ viewport: { width, height } });
  await person.route('https://accounts.google.com/**', (route) =>
    route.abort(),
  );
  await person.goto(base);
  await person.getByRole('button', { name: 'Entrar com código' }).waitFor();
  await shot(person, '1-login');

  await person.getByRole('button', { name: 'Entrar com código' }).click();
  await shot(person, '2-code-channels');

  await person.getByRole('button', { name: '← Voltar' }).click();
  await person
    .getByRole('button', { name: 'Pedir acesso sem conta Google' })
    .click();
  await person.getByLabel('Celular').fill('12');
  await person.getByRole('button', { name: 'Enviar código' }).click();
  await shot(person, '3-signup-errors');
  await person.getByLabel('E-mail').fill(email);
  await person.getByLabel('Nome', { exact: true }).fill('Maria Luísa');
  await person.getByLabel('Sobrenome').fill('de Albuquerque Cavalcanti');
  await person.getByLabel('Celular').fill('(81) 99999-0000');
  await person.getByRole('button', { name: 'Enviar código' }).click();
  await person.getByLabel('Código').fill(await codeFor(email));
  await shot(person, '4-signup-code');
  await person.getByRole('button', { name: 'Confirmar' }).click();
  await person.getByText(/Solicitação enviada/).waitFor();
  await shot(person, '5-signup-done');

  const owner = await ownerContext.newPage();
  await owner.setViewportSize({ width, height });
  await owner.goto(base);
  await owner.getByLabel('Sua pergunta').waitFor();
  if (width < 1024) await owner.getByRole('button', { name: 'Menu' }).click();
  await shot(owner, '6-badge');
  await owner.getByRole('button', { name: /Pessoas e permissões/ }).click();
  await owner
    .getByRole('heading', { name: /Solicitações pendentes/ })
    .waitFor();
  // Let the dialog's opening fade finish before the picture.
  await owner.waitForTimeout(500);
  await shot(owner, '7-requests');
  const item = owner.getByRole('listitem').filter({ hasText: email });
  await item.getByRole('button', { name: 'Recusar' }).click();
  await shot(owner, '8-refuse-confirm');
  await item.getByRole('button', { name: 'Cancelar' }).click();
  await item.getByRole('button', { name: 'Aprovar' }).click();
  await owner.getByText(/Acesso aprovado/).waitFor();
  await shot(owner, '9-approved');

  await signInWithCode(person, email);
  await person
    .getByText('Nenhum acervo foi liberado para você ainda')
    .waitFor();
  await shot(person, '10-signed-in');
  await person.close();
  await owner.close();
}
await browser.close();
