// KBC-020 local validation: the "Autoria" control, the authorship badges on cards, in the
// document panel and on the sources of an answer (E2E servers: fixture vault, stub model;
// the mixed-sources answer is a recorded stream), at 1440 and 390 px.
// Usage: node e2e/tools/local-validation-authorship.mjs http://localhost:4220 <dir>
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

const overflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

const MIXED = [
  {
    type: 'sources',
    sources: [
      {
        n: 1,
        id: 'raw/articles/a-lei-do-ritmo.md',
        title: 'A Lei do Ritmo',
        authorship: 'mestre-laercio',
        author: 'José Laércio do Egito',
      },
      {
        n: 2,
        id: 'raw/articles/arvore-da-vida.md',
        title: 'A Árvore da Vida',
        authorship: 'outros-autores',
      },
      {
        n: 3,
        id: 'wiki/concepts/Ritmo.md',
        title: 'Ritmo',
        authorship: 'sintese',
      },
    ],
  },
  {
    type: 'token',
    text: '**Mestre Laércio:** o ritmo rege todas as coisas [1].\n\n**Outros autores:** a Cabala descreve a árvore da vida [2]; a síntese do acervo resume o tema [3].',
    segment: 0,
  },
  {
    type: 'done',
    usd: 0,
    billing: 'subscription',
    model: 'stub',
    interrupted: false,
    steps: 1,
  },
];

for (const [name, viewport] of [
  ['desktop', { width: 1440, height: 900 }],
  ['mobile', { width: 390, height: 844 }],
]) {
  const page = await browser.newPage({ viewport });
  await signIn(page);
  await page.addInitScript(() =>
    localStorage.setItem('kb-chat.view', 'search'),
  );
  await page.goto(`${base}/`);
  await page
    .getByLabel('Como buscar')
    .selectOption({ label: 'Por significado' });
  await page.getByLabel('Sua pergunta').fill('natureza');
  await page.getByRole('button', { name: 'Buscar' }).click();
  await page.locator('app-result-card').first().waitFor();
  await page.screenshot({ path: `${out}/${name}-1-todos.png` });
  const control = page.getByRole('radiogroup', { name: 'Autoria' });
  const options = await control
    .getByRole('radio')
    .evaluateAll((radios) =>
      radios.map((radio) =>
        radio.closest('label')?.innerText.replace(/\s+/g, ' ').trim(),
      ),
    );
  console.log(
    `${name}: options ${JSON.stringify(options)}, overflow ${await overflow(page)}px`,
  );

  await control.getByRole('radio', { name: /Mestre Laércio/ }).check();
  await page.getByText(/1 documento · Por significado/).waitFor();
  await page.screenshot({ path: `${out}/${name}-2-mestre.png` });
  await page
    .locator('app-result-card')
    .first()
    .getByRole('button')
    .first()
    .click();
  await page.getByRole('dialog').getByText('José Laércio do Egito').waitFor();
  await page.screenshot({ path: `${out}/${name}-3-panel.png` });
  console.log(`${name}: panel overflow ${await overflow(page)}px`);

  await page.evaluate(() => localStorage.setItem('kb-chat.view', 'research'));
  await page.route('**/api/v1/topics/*/research', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: MIXED.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    }),
  );
  await page.goto(`${base}/`);
  await page
    .getByLabel('Sua pergunta')
    .fill('o que o Mestre ensina sobre o ritmo?');
  await page.getByRole('button', { name: 'Perguntar' }).click();
  await page.getByText(/Resposta gerada por IA/).waitFor();
  await page.screenshot({
    path: `${out}/${name}-4-sources.png`,
    fullPage: true,
  });
  const headings = await page
    .locator('app-research-message h4')
    .allInnerTexts();
  console.log(
    `${name}: source groups ${JSON.stringify(headings)}, overflow ${await overflow(page)}px`,
  );

  // The real stub turn: tools over the fixture vault, sources carry the authorship.
  await page.unroute('**/api/v1/topics/*/research');
  await page.goto(`${base}/`);
  await page.getByLabel('Sua pergunta').fill('natureza sétupla');
  await page.getByRole('button', { name: 'Perguntar' }).click();
  await page.getByText(/Resposta gerada por IA/).waitFor();
  const chip = await page
    .locator('app-research-message .source')
    .first()
    .innerText();
  console.log(
    `${name}: stub turn source chip "${chip.replace(/\s+/g, ' ').trim()}"`,
  );
  await page.screenshot({
    path: `${out}/${name}-5-stub-turn.png`,
    fullPage: true,
  });
  await page.close();
}
await browser.close();
