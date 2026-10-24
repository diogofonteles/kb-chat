import { expect, test, type Page } from '@playwright/test';

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
  await page.getByText('Buscar documentos').click();
  await page.reload();
  await expect(
    page.getByRole('radio', { name: 'Buscar documentos' }),
  ).toBeChecked();
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
  await page.getByText('Buscar documentos').click();
  await page.getByLabel('Sua pergunta').fill('ritmo');
  await page.getByRole('button', { name: 'Buscar' }).click();
  await expect(page.locator('app-result-card').first()).toBeVisible();
  await page.getByText('Pesquisa com IA').click();
  await expect(page.getByText(/Segundo o acervo/)).toBeVisible();
  await expect(page.locator('app-result-card')).toHaveCount(0);
  await page.getByText('Buscar documentos').click();
  await expect(page.locator('app-result-card').first()).toBeVisible();
});

test('AC-6: the search view never calls the AI, and the research view shows no cards', async ({
  page,
}) => {
  const researchCalls = countResearchCalls(page);
  await page.getByText('Buscar documentos').click();
  await page.getByLabel('Sua pergunta').fill('ritmo');
  await page.getByRole('button', { name: 'Buscar' }).click();
  await expect(page.locator('app-result-card').first()).toBeVisible();
  expect(researchCalls()).toBe(0);
  await expect(page.getByText(/Resposta gerada por IA/)).toHaveCount(0);
  await page.getByText('Pesquisa com IA').click();
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
  await (
    await sidebar(page)
  )
    .getByRole('button', { name: /natureza sétupla/ })
    .click();
  const restored = page.locator('app-research-message');
  await expect(restored.getByText(/Segundo o acervo/)).toBeVisible();
  await expect(
    restored.getByRole('link', { name: /^Fonte \d+:/ }).first(),
  ).toBeVisible();
  expect(researchCalls()).toBe(0);
});
