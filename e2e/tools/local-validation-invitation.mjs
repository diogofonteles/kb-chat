// KBC-026 local validation: the invitation e-mail, its status in "Pessoas e permissões" and
// the limited resend, against a dev API whose e-mail goes to its log (no SMTP or Resend).
// Usage: node e2e/tools/local-validation-invitation.mjs <out-dir> <base-url> <api-log> <owner-email>
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const [out, base, apiLog, ownerEmail] = process.argv.slice(2);

/** Every message the log adapter wrote for `to`, oldest first. */
async function mailFor(to) {
  return (await readFile(apiLog, 'utf8'))
    .split('\n')
    .filter((line) => line.includes('not sent (development log adapter)'))
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.to === to);
}

async function codeFor(to, seen) {
  for (let tries = 0; tries < 60; tries += 1) {
    const mail = await mailFor(to);
    if (mail.length > seen) return /\b(\d{6})\b/.exec(mail.at(-1).text)[1];
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no code for ${to}`);
}

async function signInWithCode(page, email) {
  await page.goto(base);
  await page.getByRole('button', { name: 'Entrar com código' }).click();
  const seen = (await mailFor(email)).length;
  await page.getByLabel('Seu e-mail').fill(email);
  await page.getByRole('button', { name: 'Enviar código' }).click();
  await page.getByLabel('Código').fill(await codeFor(email, seen));
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByLabel('Sua pergunta').waitFor();
}

async function openPeople(page, desktop) {
  await page.goto(base);
  if (!desktop) await page.getByRole('button', { name: 'Menu' }).click();
  const side = desktop
    ? page.getByRole('complementary', { name: 'Lateral' })
    : page.getByRole('dialog', { name: 'Menu' });
  await side.getByRole('button', { name: /Pessoas e permissões/ }).click();
  return page.getByRole('dialog', { name: 'Configurações' });
}

const browser = await chromium.launch({ args: ['--mute-audio'] });
const ownerContext = await browser.newContext();
await ownerContext.route('https://accounts.google.com/**', (r) => r.abort());
const owner = await ownerContext.newPage();
await signInWithCode(owner, ownerEmail);
// A fresh state dir is a first run: the owner finishes the onboarding wizard once (KBC-007).
const wizard = owner.getByRole('dialog');
for (let step = 0; step < 3; step += 1)
  await wizard.getByRole('button', { name: 'Continuar' }).click();
await wizard.getByRole('button', { name: 'Concluir' }).click();
await wizard.waitFor({ state: 'hidden' });
const report = [];

for (const { name, width, height } of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  await owner.setViewportSize({ width, height });
  const shot = (step) =>
    owner.screenshot({ path: `${out}/${name}-${step}.png` });
  const shotOf = (locator, step) =>
    locator.screenshot({ path: `${out}/${name}-${step}.png` });
  const desktop = width >= 1024;
  const sent = `lv-sent-${name}-${Date.now()}@example.com`;
  const quiet = `lv-quiet-${name}-${Date.now()}@example.com`;

  let dialog = await openPeople(owner, desktop);
  await dialog.getByLabel('Convidar por e-mail').fill(sent);
  await shot('1-form');
  await dialog.getByRole('button', { name: 'Convidar' }).click();
  const sentItem = dialog.getByRole('listitem').filter({ hasText: sent });
  await sentItem.getByText('Convite enviado em').waitFor();
  await shotOf(sentItem, '2-sent');
  const [mail] = await mailFor(sent);
  report.push(`${name} e-mail: ${mail.subject}\n${mail.text}`);

  await sentItem.getByRole('button', { name: 'Reenviar convite' }).click();
  await sentItem.getByText('Este convite foi enviado há pouco').waitFor();
  await shotOf(sentItem, '3-limited');
  await shot('3-limited-viewport');
  report.push(
    `${name} after resend: ${(await mailFor(sent)).length} e-mail(s)`,
  );

  await dialog.getByLabel('Convidar por e-mail').fill(quiet);
  await dialog
    .getByRole('checkbox', { name: 'Não enviar e-mail de convite' })
    .check();
  await dialog.getByRole('button', { name: 'Convidar' }).click();
  const quietItem = dialog.getByRole('listitem').filter({ hasText: quiet });
  await quietItem.getByText('Convite criado sem e-mail').waitFor();
  await shotOf(quietItem, '4-skipped');
  report.push(`${name} skipped: ${(await mailFor(quiet)).length} e-mail(s)`);

  const guestContext = await browser.newContext({
    viewport: { width, height },
  });
  await guestContext.route('https://accounts.google.com/**', (r) => r.abort());
  await signInWithCode(await guestContext.newPage(), quiet);
  await guestContext.close();

  dialog = await openPeople(owner, desktop);
  const active = dialog.getByRole('listitem').filter({ hasText: quiet });
  await active.getByText('Ativo').waitFor();
  await shotOf(active, '5-active');
  await shot('6-list');
  const overflow = await owner.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  report.push(`${name} horizontal overflow: ${overflow}`);
  await owner.keyboard.press('Escape');
}

await browser.close();
console.log(report.join('\n\n'));
