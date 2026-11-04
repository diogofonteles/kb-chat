import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Page, Route } from '@playwright/test';
import {
  CSRF,
  expect,
  invite,
  ownerApi,
  pageAs,
  test,
  uniqueEmail,
} from './fixtures.js';
import { uniqueTag, useTheme } from './media-helpers.js';
import { approve, audioWithTracks } from './tracks-helpers.js';

// KBC-069. The E2E server cannot script its fake model, so the suggestion's routes answer here
// with the contract's shapes; subjects chosen by hand go through the real API.

const SUBJECTS = '/api/v1/topics/hermetismo/subjects';
const CABALA = '77777777-7777-4777-8777-000000000001';
const NEW = '77777777-7777-4777-8777-000000000002';
const RUN = '77777777-7777-4777-8777-000000000003';

const ESTIMATE = {
  allowed: true,
  estimateUsd: 0.004,
  runCapUsd: 0.25,
  windows: 1,
  model: 'stub',
  refusal: null,
  month: { spentUsd: 1.5, capUsd: 10 },
};

const aRun = (mediaId: string, status: string) => ({
  id: RUN,
  mediaId,
  status,
  model: 'stub',
  estimateUsd: 0.004,
  spentUsd: 0.003,
  failure: null,
  createdAt: '2026-11-04T05:00:00.000Z',
  finishedAt: status === 'done' ? '2026-11-04T05:01:00.000Z' : null,
});

const SUGGESTIONS = [
  { id: CABALA, kind: 'concept', name: 'Cabala' },
  { id: NEW, kind: 'new', name: 'Sete Raios' },
];

interface StepRead {
  tracks: { suggestions: unknown[]; suggestedSummary: string | null }[];
  run: unknown;
  canSuggest: boolean;
}

/** Answers the run's routes; once it ran, the first track reads with its chips. */
async function scriptRun(
  page: Page,
  mediaId: string,
  estimate: object = ESTIMATE,
) {
  const state = { ran: false };
  await page.route(
    `**/api/v1/media/${mediaId}/edit/subject-proposals`,
    async (route: Route) => {
      const { dryRun } = route.request().postDataJSON() as { dryRun: boolean };
      if (dryRun) return route.fulfill({ json: estimate });
      state.ran = true;
      return route.fulfill({
        status: 202,
        json: aRun(mediaId, 'running'),
      });
    },
  );
  await page.route(
    `**/api/v1/media/${mediaId}/edit/subjects`,
    async (route: Route) => {
      const real = await route.fetch();
      const step = (await real.json()) as StepRead;
      const [first] = step.tracks;
      if (!state.ran || !first) return route.fulfill({ json: step });
      first.suggestions = SUGGESTIONS;
      first.suggestedSummary = 'Uma pergunta sobre a Cabala.';
      return route.fulfill({
        json: { ...step, run: aRun(mediaId, 'done'), canSuggest: false },
      });
    },
  );
}

async function approvedAudio(owner: APIRequestContext) {
  const media = await audioWithTracks(owner);
  await approve(owner, media.id);
  return media;
}

const track = (page: Page, ordinal: number) =>
  page
    .getByRole('list', { name: 'Assuntos por faixa' })
    .getByRole('listitem')
    .filter({ has: page.locator('app-track-subject-row') })
    .nth(ordinal - 1);

const askSuggestion = async (page: Page) => {
  await page.getByRole('button', { name: 'Sugerir assuntos com IA' }).click();
  await expect(page.getByText('Custa cerca de')).toBeVisible();
  await page.getByRole('button', { name: 'Confirmar e sugerir' }).click();
};

const stepTracks = async (owner: APIRequestContext, mediaId: string) => {
  const read = await owner.get(`/api/v1/media/${mediaId}/edit/subjects`);
  return (
    (await read.json()) as {
      tracks: {
        mediaId: string;
        version: number;
        subjects: { name: string }[];
      }[];
    }
  ).tracks;
};

test('FR-4, AC-1: a person adds a subject, creates one, and asks for chips priced first', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await approvedAudio(owner);
  await scriptRun(page, media.id);
  await page.goto(`/midia/${media.id}/faixas`);
  await expect(page.getByRole('heading', { name: 'Assuntos' })).toBeVisible();

  const first = track(page, 1);
  await expect(first).toContainText('Nenhum assunto ainda');
  const field = first.getByRole('combobox', {
    name: 'Adicionar assunto à faixa 1',
  });
  await field.fill('ritm');
  await page.getByRole('option', { name: 'Ritmo' }).click();
  await expect(
    first.getByRole('button', { name: 'Remover assunto Ritmo' }),
  ).toBeVisible();

  const free = `Assunto ${uniqueTag()}`;
  await field.fill(free);
  await page.getByRole('option', { name: `Criar assunto «${free}»` }).click();
  await expect(
    first.getByRole('button', { name: `Remover assunto ${free}` }),
  ).toBeVisible();

  await page.reload();
  await expect(
    track(page, 1).getByRole('button', { name: `Remover assunto ${free}` }),
  ).toBeVisible();
  await askSuggestion(page);
  await page.reload();
  const again = track(page, 1);
  await expect(again.getByText('Novo assunto: «Sete Raios»')).toBeVisible();
  await expect(
    again.getByRole('button', { name: 'Aceitar sugestão Cabala' }),
  ).toBeVisible();
  await expect(
    again.getByRole('button', { name: 'Recusar sugestão Sete Raios' }),
  ).toBeVisible();
  await expect(again.getByText('Uma pergunta sobre a Cabala.')).toBeVisible();
  await expect(page.getByText('Custou')).toBeVisible();
  await owner.dispose();
});

test('NG-30: adding by keyboard keeps the focus in the field, and a decision does not open the list over the summary', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await approvedAudio(owner);
  await page.goto(`/midia/${media.id}/faixas`);
  const first = track(page, 1);
  const field = first.getByRole('combobox', {
    name: 'Adicionar assunto à faixa 1',
  });
  await field.focus();
  await page.keyboard.type('ritm');
  await page.keyboard.press('Enter');
  const remove = first.getByRole('button', { name: 'Remover assunto Ritmo' });
  await expect(remove).toBeVisible();
  await expect(field).toBeFocused();

  await remove.click();
  await expect(remove).toHaveCount(0);
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute('aria-expanded', 'false');
  await expect(first.getByRole('listbox')).toBeHidden();
  await owner.dispose();
});

test('AC-3: a sixth subject is refused on the screen', async ({ page }) => {
  const owner = await ownerApi();
  const media = await approvedAudio(owner);
  const [first] = await stepTracks(owner, media.id);
  if (!first) throw new Error('no track');
  const created = await Promise.all(
    [1, 2, 3, 4, 5].map(async (number) => {
      const answer = await owner.post(SUBJECTS, {
        data: { name: `Limite ${number} ${uniqueTag()}` },
        headers: CSRF,
      });
      expect(answer.status(), await answer.text()).toBe(201);
      return (await answer.json()) as { id: string };
    }),
  );
  const saved = await owner.put(`/api/v1/media/${first.mediaId}/subjects`, {
    data: {
      subjects: created.map(({ id }) => ({ kind: 'free', id })),
      summary: null,
    },
    headers: { ...CSRF, 'if-match': `"${first.version}"` },
  });
  expect(saved.status(), await saved.text()).toBe(200);

  await page.goto(`/midia/${media.id}/faixas`);
  const row = track(page, 1);
  await row
    .getByRole('combobox', { name: 'Adicionar assunto à faixa 1' })
    .fill('cabala');
  await page.getByRole('option', { name: 'Cabala' }).click();
  await expect(row.getByRole('alert')).toHaveText('Até 5 assuntos por faixa');
  await expect(row.getByRole('button', { name: /^Remover/ })).toHaveCount(5);
  await owner.dispose();
});

test('AC-4: a repeated subject is not offered to create, and the API refuses it', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await approvedAudio(owner);
  const name = `Burrachéira ${uniqueTag()}`;
  const made = await owner.post(SUBJECTS, { data: { name }, headers: CSRF });
  expect(made.status()).toBe(201);
  const again = await owner.post(SUBJECTS, {
    data: { name: name.toUpperCase().replace('É', 'E') },
    headers: CSRF,
  });
  expect(again.status()).toBe(409);

  await page.goto(`/midia/${media.id}/faixas`);
  await track(page, 1)
    .getByRole('combobox', { name: 'Adicionar assunto à faixa 1' })
    .fill(name.toLowerCase().replace('é', 'e'));
  await expect(page.getByRole('option', { name })).toBeVisible();
  await expect(
    page.getByRole('option', { name: /^Criar assunto/ }),
  ).toHaveCount(0);
  await owner.dispose();
});

test('AC-7: the monthly cap stops the suggestion and the screen says why', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await approvedAudio(owner);
  await scriptRun(page, media.id, {
    ...ESTIMATE,
    allowed: false,
    refusal: 'monthly-cap',
  });
  await page.goto(`/midia/${media.id}/faixas`);
  await page.getByRole('button', { name: 'Sugerir assuntos com IA' }).click();
  await expect(
    page.getByText('O teto mensal da mídia foi atingido.'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Confirmar e sugerir' }),
  ).toHaveCount(0);
  await owner.dispose();
});

test('AC-6: the column needs media-classify, and the suggestion media-edit-ai', async ({
  browser,
  viewport,
}) => {
  const owner = await ownerApi();
  const media = await approvedAudio(owner);
  const editor = uniqueEmail('editor');
  const classifier = uniqueEmail('classifier');
  await invite(owner, editor, {
    topics: ['hermetismo'],
    features: ['media', 'media-edit', 'media-edit-ai'],
  });
  await invite(owner, classifier, {
    topics: ['hermetismo'],
    features: ['media', 'media-edit', 'media-classify'],
  });

  const editing = await pageAs(browser, editor, viewport);
  await editing.goto(`/midia/${media.id}/faixas`);
  await expect(
    editing.getByRole('button', { name: 'Reabrir edição' }),
  ).toBeVisible();
  await expect(editing.getByRole('heading', { name: 'Assuntos' })).toHaveCount(
    0,
  );

  const classifying = await pageAs(browser, classifier, viewport);
  await classifying.goto(`/midia/${media.id}/faixas`);
  await expect(track(classifying, 1)).toBeVisible();
  await expect(
    classifying.getByRole('button', { name: 'Sugerir assuntos com IA' }),
  ).toHaveCount(0);
  await editing.context().close();
  await classifying.context().close();
  await owner.dispose();
});

test('the track page shows its subjects to who classifies, and not to who only listens', async ({
  page,
  browser,
  viewport,
}) => {
  const owner = await ownerApi();
  const media = await approvedAudio(owner);
  await expect
    .poll(
      async () => {
        const edit = await owner.get(`/api/v1/media/${media.id}/edit`);
        return ((await edit.json()) as { preparation: unknown }).preparation;
      },
      { timeout: 30_000 },
    )
    .toBeNull();
  const [first] = await stepTracks(owner, media.id);
  if (!first) throw new Error('no track');
  const saved = await owner.put(`/api/v1/media/${first.mediaId}/subjects`, {
    data: {
      subjects: [{ kind: 'concept', name: 'Cabala' }],
      summary: 'Sobre a Cabala.',
    },
    headers: { ...CSRF, 'if-match': `"${first.version}"` },
  });
  expect(saved.status(), await saved.text()).toBe(200);

  await page.goto(`/midia/${first.mediaId}`);
  const shown = page.getByRole('region', { name: 'Assuntos da faixa' });
  await expect(shown).toContainText('Cabala');
  await expect(shown).toContainText('Sobre a Cabala.');

  const listener = uniqueEmail('listener');
  await invite(owner, listener, {
    topics: ['hermetismo'],
    features: ['media', 'media-tracks'],
  });
  const listening = await pageAs(browser, listener, viewport);
  await listening.goto(`/midia/${first.mediaId}`);
  await expect(
    listening.getByRole('heading', { name: 'Primeira pergunta' }),
  ).toBeVisible();
  await expect(
    listening.getByRole('region', { name: 'Assuntos da faixa' }),
  ).toHaveCount(0);
  await listening.context().close();
  await owner.dispose();
});

for (const theme of ['light', 'dark', 'esoteric'] as const) {
  test(`AC-9: chips and the column pass axe in the ${theme} theme`, async ({
    page,
  }) => {
    await useTheme(page, theme);
    const owner = await ownerApi();
    const media = await approvedAudio(owner);
    await scriptRun(page, media.id);
    await page.goto(`/midia/${media.id}/faixas`);
    await askSuggestion(page);
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Aceitar sugestão Cabala' }),
    ).toBeVisible();
    const { violations } = await new AxeBuilder({ page })
      .include('app-track-subjects')
      .analyze();
    expect(
      violations.filter((one) =>
        ['serious', 'critical'].includes(one.impact ?? ''),
      ),
    ).toEqual([]);
    await owner.dispose();
  });
}
