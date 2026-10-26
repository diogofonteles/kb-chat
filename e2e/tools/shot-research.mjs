// Screenshots of both views (KBC-008) at 1440 and 390 px, for the layout check.
// The research stream is replayed from a fixed SSE script, so it works before the API lands.
// Usage: node e2e/tools/shot-research.mjs http://localhost:4317 work/KBC-008/screens
import { chromium } from '@playwright/test';

const [base, out] = process.argv.slice(2);
const sse = (...events) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
const ANSWER = sse(
  {
    type: 'step',
    step: { kind: 'search', text: 'Buscando “princípios ocultos”' },
  },
  {
    type: 'step',
    step: { kind: 'search', text: 'Buscando “natureza sétupla”' },
  },
  { type: 'step', step: { kind: 'read', text: 'Lendo “A Natureza Sétupla”' } },
  {
    type: 'sources',
    sources: [
      {
        n: 1,
        id: 'raw/articles/a-natureza-setupla.md',
        title: 'A Natureza Sétupla',
      },
      { n: 2, id: 'raw/articles/a-lei-do-ritmo.md', title: 'A Lei do Ritmo' },
    ],
  },
  {
    type: 'token',
    text:
      'Segundo o acervo, a natureza humana é **sétupla**: sete princípios, do corpo físico ao espírito [1].\n\n' +
      '- Os três inferiores formam a parte mortal;\n- os quatro superiores, a parte imortal [1].\n\n' +
      'O ritmo rege a passagem entre eles, como um pêndulo [2]. A ideia aparece também na teosofia (fora do acervo).',
  },
  { type: 'done', usd: 0.0042, model: 'stub', interrupted: false, steps: 3 },
);

const browser = await chromium.launch();
for (const [name, width, height] of [
  ['desktop', 1440, 900],
  ['mobile', 390, 844],
]) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.route('**/research', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: ANSWER,
    }),
  );
  await page.goto(base);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByText('O que você quer pesquisar no acervo?').waitFor();
  await page.screenshot({ path: `${out}/${name}-research-start.png` });
  await page
    .getByLabel('Sua pergunta')
    .fill('quais são os princípios ocultos?');
  await page.getByRole('button', { name: 'Perguntar' }).click();
  await page.getByText(/Resposta gerada por IA/).waitFor();
  await page.getByText(/Pesquisou 2 vezes/).click();
  await page.screenshot({ path: `${out}/${name}-research-answer.png` });
  await page.getByText(/Resposta gerada por IA/).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/${name}-research-answer-end.png` });
  await page.getByRole('radio', { name: 'Buscar documentos' }).check();
  await page.getByText('O que você quer estudar hoje?').waitFor();
  await page.screenshot({ path: `${out}/${name}-search-start.png` });
  await page.getByLabel('Sua pergunta').fill('ritmo');
  await page.keyboard.press('Enter');
  await page.locator('app-result-card').first().waitFor();
  await page.screenshot({ path: `${out}/${name}-search-results.png` });
  await page.close();
}
await browser.close();
