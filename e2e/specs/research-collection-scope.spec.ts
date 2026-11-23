import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { chooseCollectionSlug } from './shell-helpers.js';

/**
 * "Pesquisa com IA" only ever reaches the collection in use (ADR 0028): with Hermetismo
 * chosen, the stub agent (KB_CHAT_LLM=stub: it searches, reads the first hit and cites it)
 * never finds nor cites Alquimia's "A Pedra Filosofal", even when the question names only it.
 */
const ALQUIMIA_ID = 'raw/articles/a-pedra-filosofal.md';
/** The title as the catalog writes it: the question's echo (lower case) never matches. */
const ALQUIMIA_TITLE = /A Pedra Filosofal/;

interface Asked {
  readonly url: string;
  readonly stream: string;
  readonly answer: ReturnType<Page['locator']>;
}

/** Asks with the collection in use; the research call's URL and its whole event stream. */
async function ask(page: Page, question: string): Promise<Asked> {
  const responded = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/research'),
  );
  await page.getByLabel('Sua pergunta').fill(question);
  await page.getByRole('button', { name: 'Perguntar' }).click();
  const response = await responded;
  const answer = page.locator('app-research-message').last();
  await expect(answer.getByText(/Resposta gerada por IA/)).toBeVisible();
  return { url: response.url(), stream: await response.text(), answer };
}

/** The sources the turn sent, from its `sources` events. */
function sourcesIn(stream: string): { id: string; title: string }[] {
  return stream
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => {
      try {
        return JSON.parse(line.slice(5)) as {
          type?: string;
          sources?: { id: string; title: string }[];
        };
      } catch {
        return {};
      }
    })
    .flatMap((event) =>
      event.type === 'sources' ? (event.sources ?? []) : [],
    );
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test('with Hermetismo chosen, a question only Alquimia answers finds and cites nothing of Alquimia', async ({
  page,
}) => {
  await chooseCollectionSlug(page, 'hermetismo');
  const { url, stream, answer } = await ask(
    page,
    'pedra filosofal e transmutação',
  );
  expect(new URL(url).pathname).toBe('/api/v1/topics/hermetismo/research');
  await expect(
    answer.getByText(
      'Procurei no acervo e não encontrei documentos sobre isso.',
    ),
  ).toBeVisible();
  expect(stream).not.toContain(ALQUIMIA_ID);
  expect(stream).not.toMatch(ALQUIMIA_TITLE);
  expect(sourcesIn(stream)).toEqual([]);
  await expect(answer).not.toContainText(ALQUIMIA_TITLE);
});

test('with Hermetismo chosen, the answer cites only Hermetismo sources', async ({
  page,
}) => {
  await chooseCollectionSlug(page, 'hermetismo');
  const { stream, answer } = await ask(page, 'o ritmo e a pedra filosofal');
  await expect(answer.getByText(/Segundo o acervo/)).toBeVisible();
  const sources = sourcesIn(stream);
  expect(sources.length).toBeGreaterThan(0);
  // Every source is a Hermetismo document, read through its own collection's API.
  for (const source of sources) {
    expect(source.id).not.toBe(ALQUIMIA_ID);
    const read = await page.request.get(
      `/api/v1/topics/hermetismo/documents/${encodeURIComponent(source.id)}`,
    );
    expect(read.status(), source.id).toBe(200);
  }
  expect(stream).not.toMatch(ALQUIMIA_TITLE);
  await expect(answer).not.toContainText(ALQUIMIA_TITLE);
});

test("Hermetismo's API refuses Alquimia's document by id or path", async ({
  page,
}) => {
  // One width (KBC-169): the phone project would only repeat it.
  test.skip(
    test.info().project.name === 'mobile',
    'not about the layout: the API answers the same at any width',
  );
  for (const id of [ALQUIMIA_ID, `../alquimia/${ALQUIMIA_ID}`]) {
    const read = await page.request.get(
      `/api/v1/topics/hermetismo/documents/${encodeURIComponent(id)}`,
    );
    // Not found, or refused as an invalid id: never the document.
    expect([400, 404], id).toContain(read.status());
  }
});

test('control: with Alquimia chosen, the same question cites "A Pedra Filosofal"', async ({
  page,
}) => {
  await chooseCollectionSlug(page, 'alquimia');
  const { url, stream, answer } = await ask(
    page,
    'pedra filosofal e transmutação',
  );
  expect(new URL(url).pathname).toBe('/api/v1/topics/alquimia/research');
  await expect(answer.getByText(/Segundo o acervo/)).toBeVisible();
  expect(sourcesIn(stream).map((source) => source.id)).toContain(ALQUIMIA_ID);
});
