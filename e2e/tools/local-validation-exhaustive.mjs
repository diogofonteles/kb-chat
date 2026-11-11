// KBC-017 local validation: the "Exaustivo" profile in the composer at 1440 and 390 px,
// against the E2E servers (fixture vault, stub model). Signs in as the E2E owner, asks with
// the exhaustive profile, reports horizontal overflow and the request profile, and saves
// screenshots. Usage: node e2e/tools/local-validation-exhaustive.mjs http://localhost:4217 <dir>
import { chromium } from '@playwright/test';

const [base, out] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--mute-audio'] });

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
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  await page.screenshot({ path: `${out}/${name}-composer.png` });
  const asked = page.waitForRequest(
    (r) => r.method() === 'POST' && r.url().endsWith('/research'),
  );
  await page
    .getByLabel('Sua pergunta')
    .fill('todas as obras citadas no acervo');
  await page.getByRole('button', { name: 'Perguntar' }).click();
  const profile = (await asked).postDataJSON().profile;
  await page.getByText(/Resposta gerada por IA/).waitFor();
  await page.screenshot({ path: `${out}/${name}-answer.png`, fullPage: true });
  console.log(`${name}: overflow ${overflow}px, profile ${profile}`);
  await page.close();
}
await browser.close();
