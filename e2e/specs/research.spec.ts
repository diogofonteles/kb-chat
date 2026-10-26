import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

/**
 * "Pesquisa com IA" (KBC-008) against the stub agent (KB_CHAT_LLM=stub): it searches, finds
 * nothing, searches the question, reads the first hit and answers "Segundo o acervo, … [n]."
 */
const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

async function sidebar(page: Page) {
  if (!desktop(page)) await page.getByRole('button', { name: 'Menu' }).click();
  return desktop(page)
    ? page.getByRole('complementary', { name: 'Lateral' })
    : page.getByRole('dialog', { name: 'Menu' });
}

async function research(page: Page, question: string) {
  await page.getByLabel('Sua pergunta').fill(question);
  await page.getByRole('button', { name: 'Perguntar' }).click();
  const answer = page.locator('app-research-message').last();
  await expect(answer.getByText(/Segundo o acervo/)).toBeVisible();
  await expect(answer.getByText(/Resposta gerada por IA/)).toBeVisible();
  return answer;
}

/** Counts the calls to the agent, so a step can prove it made none. */
function countResearchCalls(page: Page): () => number {
  let calls = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/research'))
      calls += 1;
  });
  return () => calls;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test('opens in the research view with the provider configured, and remembers the choice', async ({
  page,
}) => {
  await expect(
    page.getByRole('radio', { name: /Pesquisa com IA/ }),
  ).toBeChecked();
  await expect(
    page.getByText('O que você quer pesquisar no acervo?'),
  ).toBeVisible();
  await expect(page.getByLabel('Como buscar')).toHaveCount(0);
  await page.getByRole('radio', { name: 'Buscar documentos' }).check();
  await page.reload();
  await expect(
    page.getByRole('radio', { name: 'Buscar documentos' }),
  ).toBeChecked();
});

test('KBC-011: "Rápido | Profundo" picks the profile of the next question and is remembered', async ({
  page,
}) => {
  await expect(page.getByRole('radio', { name: 'Rápido' })).toBeChecked();
  await page.getByRole('radio', { name: 'Profundo' }).check();
  await expect(page.getByRole('radio', { name: 'Profundo' })).toBeChecked();
  const asked = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && request.url().endsWith('/research'),
  );
  await research(page, 'natureza sétupla');
  expect(((await asked).postDataJSON() as { profile: string }).profile).toBe(
    'deep',
  );
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Profundo' })).toBeChecked();
});

const QUESTION = 'todas as obras citadas no acervo';

test('KBC-017 AC-9: "Exaustivo" explains itself, asks with the exhaustive profile and is saved with the turn', async ({
  page,
}) => {
  await page.getByRole('radio', { name: 'Exaustivo' }).check();
  await expect(page.getByRole('radio', { name: 'Exaustivo' })).toBeChecked();
  // Three profiles never push the page sideways (390 px, KBC-017 NFR-4).
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(0);
  if (desktop(page))
    await expect(
      page.getByText(/Varre o acervo inteiro.*pode levar vários minutos/),
    ).toBeVisible();
  const asked = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && request.url().endsWith('/research'),
  );
  const answer = await research(page, QUESTION);
  expect(((await asked).postDataJSON() as { profile: string }).profile).toBe(
    'exhaustive',
  );
  await expect(answer.getByText(/Custo:/)).toBeVisible();
  const axe = await new AxeBuilder({ page }).include('app-composer').analyze();
  expect(
    axe.violations.filter((v) =>
      ['serious', 'critical'].includes(v.impact ?? ''),
    ),
  ).toEqual([]);
  // The turn is saved with its profile (KBC-017 AC-14).
  await expect
    .poll(async () => {
      const list = await page.request.get('/api/v1/conversations');
      const { items } = (await list.json()) as {
        items: { id: string; title: string }[];
      };
      const mine = items.find((c) => c.title === QUESTION);
      if (!mine) return null;
      const saved = await page.request.get(`/api/v1/conversations/${mine.id}`);
      const body = (await saved.json()) as { turns: { profile?: string }[] };
      return body.turns.at(-1)?.profile ?? null;
    })
    .toBe('exhaustive');
});

test('ADR 0009: text written before a tool call leaves the answer and shows among the steps', async ({
  page,
}) => {
  const answer = await research(page, 'natureza sétupla');
  await expect(answer.locator('.answer')).not.toContainText('confiro');
  await answer.getByText(/Pesquisou 2 vezes · leu 1 documento/).click();
  await expect(
    answer.getByText(
      'Pensando: Um dos documentos parece tratar disso; confiro o trecho.',
    ),
  ).toBeVisible();
});

test('AC-2: a follow-up carries the previous question and answer, and answers below', async ({
  page,
}) => {
  const first = await research(page, 'natureza sétupla');
  await expect(
    first.getByText(/Pesquisou 2 vezes · leu 1 documento/),
  ).toBeVisible();
  const followUp = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && request.url().endsWith('/research'),
  );
  await page.getByLabel('Sua pergunta').fill('e o que mais?');
  await page.getByRole('button', { name: 'Perguntar' }).click();
  const body = (await followUp).postDataJSON() as {
    history: { question: string; answer: string }[];
  };
  expect(body.history).toHaveLength(1);
  expect(body.history[0]?.question).toBe('natureza sétupla');
  expect(body.history[0]?.answer).toMatch(/^Segundo o acervo/);
  const messages = page.locator('app-research-message');
  await expect(messages).toHaveCount(2);
  await expect(messages.nth(1).getByText(/Segundo o acervo/)).toBeVisible();
  const [top, bottom] = await Promise.all([
    messages.nth(0).boundingBox(),
    messages.nth(1).boundingBox(),
  ]);
  expect(top && bottom && top.y < bottom.y).toBe(true);
  // The conversation scrolls inside its column; the page itself never grows (owner's review).
  const page_ = await page.evaluate(() => ({
    scroll: document.scrollingElement?.scrollHeight ?? 0,
    view: window.innerHeight,
  }));
  expect(page_.scroll).toBeLessThanOrEqual(page_.view);
});

test('AC-3: a citation opens its document in the panel', async ({ page }) => {
  const answer = await research(page, 'natureza sétupla');
  await answer
    .getByRole('link', { name: /^Fonte \d+:/ })
    .first()
    .click();
  await expect(
    page.getByRole('dialog').getByRole('heading', { level: 2 }),
  ).toBeVisible();
});

test('AC-5: each view keeps its conversation when switching back and forth', async ({
  page,
}) => {
  await research(page, 'natureza sétupla');
  await page.getByRole('radio', { name: 'Buscar documentos' }).check();
  await page.getByLabel('Sua pergunta').fill('ritmo');
  await page.getByRole('button', { name: 'Buscar' }).click();
  await expect(page.locator('app-result-card').first()).toBeVisible();
  await page.getByRole('radio', { name: /Pesquisa com IA/ }).check();
  await expect(page.getByText(/Segundo o acervo/)).toBeVisible();
  await expect(page.locator('app-result-card')).toHaveCount(0);
  await page.getByRole('radio', { name: 'Buscar documentos' }).check();
  await expect(page.locator('app-result-card').first()).toBeVisible();
});

test('AC-6: the search view never calls the AI, and the research view shows no cards', async ({
  page,
}) => {
  const researchCalls = countResearchCalls(page);
  await page.getByRole('radio', { name: 'Buscar documentos' }).check();
  await page.getByLabel('Sua pergunta').fill('ritmo');
  await page.getByRole('button', { name: 'Buscar' }).click();
  await expect(page.locator('app-result-card').first()).toBeVisible();
  expect(researchCalls()).toBe(0);
  await expect(page.getByText(/Resposta gerada por IA/)).toHaveCount(0);
  await page.getByRole('radio', { name: /Pesquisa com IA/ }).check();
  await research(page, 'ritmo');
  expect(researchCalls()).toBe(1);
  await expect(page.locator('app-result-card')).toHaveCount(0);
});

test('AC-9: a research conversation restored from the history shows its saved answer without calling the AI', async ({
  page,
}) => {
  await research(page, 'natureza sétupla');
  await (
    await sidebar(page)
  )
    .getByRole('button', { name: /Nova conversa/ })
    .click();
  await expect(page.locator('app-research-message')).toHaveCount(0);
  const researchCalls = countResearchCalls(page);
  // The history is shared by every test of the run; this page lists its own save on top.
  const saved = (await sidebar(page))
    .getByRole('navigation', { name: 'Histórico' })
    .getByRole('button', { name: /natureza sétupla/ })
    .first();
  await expect(saved).toContainText('IA');
  await saved.click();
  const restored = page.locator('app-research-message');
  await expect(restored.getByText(/Segundo o acervo/)).toBeVisible();
  await expect(
    restored.getByRole('link', { name: /^Fonte \d+:/ }).first(),
  ).toBeVisible();
  expect(researchCalls()).toBe(0);
});

test('KBC-007 AC-4: a subscription turn shows "Incluído na sua assinatura" instead of a cost', async ({
  page,
}) => {
  // The shared E2E server answers with the per-token stub; the subscription runner itself
  // (a fake Claude Code over the turn's MCP endpoint) is covered by the API integration test.
  const events = [
    { type: 'step', step: { kind: 'search', text: 'Buscando “ritmo”' } },
    {
      type: 'sources',
      sources: [
        { n: 1, id: 'raw/articles/a-lei-do-ritmo.md', title: 'A Lei do Ritmo' },
      ],
    },
    { type: 'token', text: 'Segundo o acervo, tudo flui [1].', segment: 0 },
    {
      type: 'done',
      usd: 0,
      billing: 'subscription',
      model: 'claude-opus-5-5',
      interrupted: false,
      steps: 1,
    },
  ];
  await page.route('**/api/v1/topics/*/research', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: events
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
    }),
  );
  const answer = await research(page, 'ritmo');
  await expect(answer.getByText('Incluído na sua assinatura')).toBeVisible();
  await expect(answer.getByText(/Custo:/)).toHaveCount(0);
  await expect(answer.getByRole('link', { name: /^Fonte 1:/ })).toBeVisible();
});

test('a question stopped before any text stays in the history and restores as interrupted', async ({
  page,
}) => {
  // The agent never answers: "Parar" ends the turn before its first text.
  await page.route('**/api/v1/topics/*/research', () => undefined);
  const question = `parada antes ${Date.now()}`;
  await page.getByLabel('Sua pergunta').fill(question);
  await page.getByRole('button', { name: 'Perguntar' }).click();
  await page.getByRole('button', { name: 'Parar' }).click();
  const stopped = page.locator('app-research-message').last();
  await expect(
    stopped.getByText('Resposta interrompida antes de começar.'),
  ).toBeVisible();
  await expect(
    stopped.getByText(/O custo do que já foi processado/),
  ).toHaveCount(0);
  await expect(
    stopped.getByRole('button', { name: 'Tentar de novo' }),
  ).toBeVisible();
  await (
    await sidebar(page)
  )
    .getByRole('button', { name: /Nova conversa/ })
    .click();
  await (
    await sidebar(page)
  )
    .getByRole('navigation', { name: 'Histórico' })
    .getByRole('button', { name: new RegExp(question) })
    .click();
  await expect(
    page
      .locator('app-research-message')
      .getByText('Resposta interrompida antes de começar.'),
  ).toBeVisible();
});

test('a wide table in an answer scrolls sideways inside the answer', async ({
  page,
}) => {
  const table = [
    '| Princípio | Fonte | Polaridade | Vibração | Correspondência | Descrição |',
    '| --- | --- | --- | --- | --- | --- |',
    '| Mentalismo | Caibalion | Opostos | Movimento | Analogia | O Todo é mente [1] |',
  ].join('\n');
  const events = [
    {
      type: 'sources',
      sources: [{ n: 1, id: 'raw/articles/a-lei-do-ritmo.md', title: 'A Lei' }],
    },
    { type: 'token', text: `Segundo o acervo:\n\n${table}`, segment: 0 },
    {
      type: 'done',
      usd: 0.001,
      billing: 'per-token',
      model: 'stub/model',
      interrupted: false,
      steps: 1,
    },
  ];
  await page.route('**/api/v1/topics/*/research', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''),
    }),
  );
  const answer = await research(page, 'tabela');
  const box = answer.locator('.table-scroll');
  await expect(box.getByRole('table')).toBeVisible();
  const fits = await box.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  );
  if (!desktop(page)) expect(fits).toBe(false);
  await expect(answer.getByRole('cell', { name: 'Mentalismo' })).toBeVisible();
  const cell = answer.getByRole('cell', { name: 'Mentalismo' });
  // One line per word: the word is never split across lines.
  const { height, lineHeight } = await cell.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    lineHeight: parseFloat(getComputedStyle(element).lineHeight),
  }));
  expect(height).toBeLessThan(lineHeight * 2 + 16);
});
