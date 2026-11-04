import AxeBuilder from '@axe-core/playwright';
import type {
  Browser,
  Locator,
  Page,
  APIRequestContext,
} from '@playwright/test';
import type { Feature, MediaPreparation } from '@kb-chat/contracts';
import {
  CSRF,
  expect,
  invite,
  ownerApi,
  pageWith,
  test,
  uniqueEmail,
} from './fixtures.js';
import { makeMp3, uniqueTag, useTheme } from './media-helpers.js';
import { TURNS, seedTranscript, transcribedAudio } from './voices-helpers.js';

// KBC-072, the guided flow's steps 1 and 2 (T20). Uploads, conversion, plans and stages are
// real; the transcript and the turns are stored as a transcriber would. The E2E server cannot
// script its fake model, so the paid stage's states come as the contract's shape.

const EDITOR: Feature[] = ['search', 'media', 'media-upload', 'media-edit'];

type Viewport = { width: number; height: number } | null;

interface Person {
  readonly page: Page;
  readonly owner: APIRequestContext;
}

async function person(
  browser: Browser,
  viewport: Viewport,
  features: Feature[] = EDITOR,
): Promise<Person> {
  const email = uniqueEmail('editor');
  const owner = await ownerApi();
  await invite(owner, email, { topics: ['hermetismo'], features });
  return { page: await pageWith(browser, email, { viewport }), owner };
}

async function openUpload(page: Page): Promise<Locator> {
  await page.goto('/midia');
  await page.getByRole('button', { name: 'Enviar áudio' }).first().click();
  return page.getByRole('dialog', { name: 'Enviar áudio' });
}

async function chooseFile(dialog: Locator, title: string): Promise<void> {
  await dialog
    .locator('input[type="file"]')
    .setInputFiles(makeMp3(title.replace(/\W+/g, '-'), 60));
  await dialog.getByRole('textbox', { name: 'Título' }).fill(title);
}

const mediaIdFrom = (page: Page): string => {
  const match = /\/midia\/([^/]+)\/preparar/.exec(page.url());
  if (!match?.[1]) throw new Error(`not on step 2: ${page.url()}`);
  return match[1];
};

/** Sends the audio with what is ticked and lands on step 2. */
async function sendGuided(page: Page, dialog: Locator): Promise<string> {
  await dialog.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(page).toHaveURL(/\/preparar$/);
  await expect(page.getByTestId('step-text')).toContainText(/2.*Processar/);
  return mediaIdFrom(page);
}

const waitReady = (page: Page) =>
  expect(
    page
      .getByRole('list', { name: 'Etapas' })
      .getByRole('listitem')
      .filter({ has: page.getByText('Conversão', { exact: true }) }),
  ).toContainText('Feito', { timeout: 60_000 });

test('AC-1, AC-5, AC-8: choose, follow step 2 and go to step 3 by a press', async ({
  browser,
  viewport,
}) => {
  const { page, owner } = await person(browser, viewport);
  const dialog = await openUpload(page);
  await chooseFile(dialog, `Palestra ${uniqueTag()}`);

  await expect(
    dialog.getByRole('checkbox', { name: 'Transcrever' }),
  ).toBeChecked();
  await expect(
    dialog.getByRole('checkbox', { name: 'Indicar quem está falando' }),
  ).toBeChecked();
  await expect(
    dialog.getByRole('radio', { name: 'Não dividir agora' }),
  ).toBeChecked();
  const ai = dialog.getByRole('radio', { name: 'Propor as faixas com IA' });
  await expect(ai).toHaveAttribute('aria-disabled', 'true');
  await expect(dialog.locator('#prep-ai-hint')).toContainText(
    'Você não tem permissão',
  );

  await dialog
    .getByRole('checkbox', { name: 'Indicar quem está falando' })
    .uncheck();
  await dialog
    .getByRole('radio', { name: 'Vou marcar as faixas eu mesmo' })
    .check();
  await expect(dialog.getByTestId('plan-summary')).toContainText(
    'você valida as faixas',
  );
  const id = await sendGuided(page, dialog);

  await expect(
    page.getByText('Disponível quando o processamento terminar.'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Validar faixas' }),
  ).toHaveCount(0);
  await waitReady(page);
  await seedTranscript(owner, id);
  await page.goto(`/midia/${id}/faixas`);
  await expect(page).toHaveURL(/\/preparar$/);

  const validate = page.getByRole('button', { name: 'Validar faixas' });
  await expect(validate).toBeVisible({ timeout: 10_000 });
  await expect(page).toHaveURL(/\/preparar$/);
  await validate.click();
  await expect(page).toHaveURL(/\/faixas$/);
  await expect(page.getByTestId('step-text')).toContainText(
    /3.*Validar faixas/,
  );
  await owner.dispose();
});

test('AC-2: unticking "Transcrever" takes the rest, with the warning', async ({
  browser,
  viewport,
}) => {
  const { page, owner } = await person(browser, viewport);
  const dialog = await openUpload(page);
  await dialog.getByRole('checkbox', { name: 'Transcrever' }).uncheck();
  await expect(
    dialog.getByText(
      'Sem a transcrição não dá para indicar quem fala nem dividir em faixas.',
    ),
  ).toBeVisible();
  await expect(
    dialog.getByRole('checkbox', { name: 'Indicar quem está falando' }),
  ).not.toBeChecked();
  await expect(
    dialog.getByRole('radio', { name: 'Vou marcar as faixas eu mesmo' }),
  ).toHaveAttribute('aria-disabled', 'true');
  await owner.dispose();
});

test('AC-3, AC-4: the value is in sight, and a paid choice is not remembered', async ({
  browser,
  viewport,
}) => {
  const { page, owner } = await person(browser, viewport, [
    ...EDITOR,
    'media-edit-ai',
  ]);
  await page.route('**/api/v1/media/preparation-options*', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      options: Record<string, object>;
    };
    await route.fulfill({
      response,
      json: {
        ...body,
        options: {
          ...body.options,
          ai: { done: false, refusal: null, minutes: null },
        },
        aiEstimateUsd: new URL(route.request().url()).searchParams.has(
          'durationMs',
        )
          ? 0.02
          : null,
        monthRemainingUsd: 8.4,
      },
    });
  });
  const dialog = await openUpload(page);
  await chooseFile(dialog, `Palestra ${uniqueTag()}`);
  const ai = dialog.getByRole('radio', { name: 'Propor as faixas com IA' });
  await expect(ai).not.toHaveAttribute('aria-disabled', 'true');
  await expect(ai).not.toBeChecked();
  await ai.check();
  await expect(dialog.getByTestId('plan-summary')).toContainText('0,02');
  await expect(dialog.locator('#prep-ai-hint')).toContainText('restam');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await owner.dispose();
});

test('AC-15: only "Transcrever" goes back to the list as ever', async ({
  browser,
  viewport,
}) => {
  const { page, owner } = await person(browser, viewport, [
    'search',
    'media',
    'media-upload',
  ]);
  const dialog = await openUpload(page);
  const title = `Palestra ${uniqueTag()}`;
  await chooseFile(dialog, title);
  await expect(dialog.getByTestId('step-text')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(page.getByText(title)).toBeVisible();
  await expect(page).toHaveURL(/\/midia$/);
  await owner.dispose();
});

test('AC-9, AC-10: not dividing skips step 3; leaving shows where it stopped', async ({
  browser,
  viewport,
}) => {
  const { page, owner } = await person(browser, viewport);
  const dialog = await openUpload(page);
  const title = `Palestra ${uniqueTag()}`;
  await chooseFile(dialog, title);
  const id = await sendGuided(page, dialog);
  await expect(page.getByText('3 Validar faixas — não pedido')).toBeAttached();
  await waitReady(page);
  await seedTranscript(owner, id);
  await page.reload();
  await expect(page.getByText('Vozes').first()).toBeVisible();

  await page.getByRole('link', { name: 'Sair e continuar depois' }).click();
  await page.goto('/midia');
  const row = page.getByRole('listitem').filter({ hasText: title });
  await expect(row.getByText('Preparação parada no passo 2')).toBeVisible();
  await row.getByRole('link', { name: 'Continuar' }).click();
  await expect(page).toHaveURL(/\/preparar$/);

  const done = await owner.post(`/api/e2e/media/${id}/diarization`, {
    data: { turns: TURNS },
    headers: CSRF,
  });
  expect(done.status(), await done.text()).toBe(204);
  await page.reload();
  await expect(page.getByText('Vozes achadas: 3')).toBeVisible();
  await page.getByRole('button', { name: 'Concluir' }).click();
  await expect(page).toHaveURL(new RegExp(`/midia/${id}$`));
  await owner.dispose();
});

test('AC-16: an audio already sent offers only what is missing', async ({
  browser,
  viewport,
}) => {
  const { page, owner } = await person(browser, viewport);
  const media = await transcribedAudio(owner);
  await page.goto(`/midia/${media.id}`);
  await page.getByRole('link', { name: 'Preparar áudio' }).click();
  await expect(page.getByTestId('step-text')).toContainText(/1.*Enviar/);
  await expect(page.getByRole('checkbox', { name: 'Transcrever' })).toHaveCount(
    0,
  );
  await page
    .getByRole('radio', { name: 'Vou marcar as faixas eu mesmo' })
    .check();
  await page.getByRole('button', { name: 'Preparar' }).click();
  await expect(page.getByTestId('step-text')).toContainText(/2.*Processar/);
  await owner.dispose();
});

/** The stages of a run in sequence, on the real page of a real audio. */
const stage = (over: object) => ({
  percent: null,
  cuts: null,
  ahead: null,
  blockedBy: null,
  failure: null,
  canRetry: false,
  windows: null,
  reservedUsd: null,
  spentUsd: null,
  estimateUsd: null,
  ...over,
});

const DONE = [
  stage({ stage: 'upload', state: 'done' }),
  stage({ stage: 'convert', state: 'done' }),
  stage({ stage: 'transcribe', state: 'done' }),
  stage({ stage: 'speakers', state: 'done' }),
];

const track = (index: number, startMs: number, endMs: number) => ({
  id: `22222222-2222-4222-8222-00000000000${index}`,
  title: `Pergunta ${index}`,
  startMs,
  endMs,
  asker: { name: null, voice: 2, audience: true },
  answerer: { name: 'Mestre Gabriel', voice: 1, audience: false },
  status: 'proposed',
});

/** Serves `readings`, one per read, the last one from then on. */
async function script(
  page: Page,
  id: string,
  readings: readonly Partial<MediaPreparation>[],
): Promise<void> {
  let read = 0;
  await page.route(`**/api/v1/media/${id}/preparation`, (route) => {
    const body = readings[Math.min(read, readings.length - 1)];
    read += 1;
    return route.fulfill({
      json: {
        mediaId: id,
        title: 'Palestra de 1998',
        topic: 'hermetismo',
        author: 'Mestre Gabriel',
        step: 2,
        skipped: false,
        finished: false,
        plan: {
          transcribe: true,
          speakers: true,
          tracks: 'ai',
          subjects: false,
          acceptedUsd: 0.02,
        },
        stages: DONE,
        separation: 1,
        voices: [
          {
            voice: 1,
            speakingMs: 2_460_000,
            name: 'Mestre Gabriel',
            audience: false,
          },
          { voice: 2, speakingMs: 360_000, name: null, audience: true },
        ],
        suggestions: [],
        tracks: [],
        next: null,
        canSwitchToManual: false,
        transcriber: 'on',
        transcriberOffSince: null,
        ...body,
      },
    });
  });
}

test('AC-6, AC-7: the cuts go up, tracks appear and can be heard while the rest goes on', async ({
  browser,
  viewport,
}) => {
  const { page, owner } = await person(browser, viewport);
  const media = await transcribedAudio(owner);
  const running = (done: number) =>
    stage({
      stage: 'tracks',
      state: 'running',
      percent: done * 25,
      windows: { done, total: 4 },
      reservedUsd: 0.02,
      spentUsd: 0.01,
    });
  await script(page, media.id, [
    {
      stages: [
        ...DONE.slice(0, 2),
        stage({
          stage: 'transcribe',
          state: 'running',
          percent: 35,
          cuts: { done: 14, total: 40 },
        }),
        stage({ stage: 'speakers', state: 'waiting' }),
        stage({ stage: 'tracks', state: 'waiting' }),
      ] as MediaPreparation['stages'],
    },
    { stages: [...DONE, running(1)] as MediaPreparation['stages'] },
    {
      stages: [...DONE, running(2)] as MediaPreparation['stages'],
      tracks: [track(1, 5_000, 15_000)] as MediaPreparation['tracks'],
    },
  ]);
  await page.goto(`/midia/${media.id}/preparar`);
  await expect(
    page.getByRole('progressbar', { name: 'Transcrição' }),
  ).toHaveAttribute('aria-valuetext', 'Transcrição: 35 por cento');
  await expect(page.getByText('(cortes 14 de 40)')).toBeVisible();

  const heard = page.getByRole('button', { name: 'Ouvir a faixa 1' });
  const appeared = Date.now();
  await expect(heard).toBeVisible({ timeout: 10_000 });
  expect(Date.now() - appeared).toBeLessThan(10_000);
  await expect(page.getByText('Proposta pela IA')).toBeVisible();
  await expect(page.getByText(/Reservado/)).toContainText('gasto');
  await expect(page.getByText('Vozes achadas: 2')).toBeVisible();

  await heard.click();
  await expect
    .poll(
      () =>
        page
          .locator('audio')
          .evaluate((element: HTMLAudioElement) => element.currentTime),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(5);
  await expect(
    page.getByRole('button', { name: 'Parar a faixa 1' }),
  ).toBeVisible();
  await owner.dispose();
});

test('AC-11: a failure keeps the work and offers both ways out', async ({
  browser,
  viewport,
}) => {
  const { page, owner } = await person(browser, viewport);
  const media = await transcribedAudio(owner);
  await script(page, media.id, [
    {
      stages: [
        ...DONE,
        stage({
          stage: 'tracks',
          state: 'failed',
          failure: 'provider',
          canRetry: true,
          estimateUsd: 0.02,
        }),
      ] as MediaPreparation['stages'],
      tracks: [track(1, 5_000, 15_000)] as MediaPreparation['tracks'],
      canSwitchToManual: true,
    },
  ]);
  await page.goto(`/midia/${media.id}/preparar`);
  await expect(
    page.getByText('Falhou: o provedor de IA não respondeu.'),
  ).toBeVisible();
  await expect(page.getByText('Pergunta 1')).toBeVisible();
  await expect(page.getByText(/Tentar de novo custa cerca de/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Tentar de novo' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Marcar as faixas eu mesmo' }),
  ).toBeVisible();
  await owner.dispose();
});

for (const theme of ['light', 'dark', 'esoteric'] as const)
  test(`AC-17: steps 1 and 2 pass axe in the ${theme} theme`, async ({
    browser,
    viewport,
  }) => {
    const { page, owner } = await person(browser, viewport);
    await useTheme(page, theme);
    const dialog = await openUpload(page);
    await expect(
      dialog.getByRole('checkbox', { name: 'Transcrever' }),
    ).toBeVisible();
    const inPanel = await new AxeBuilder({ page }).analyze();
    expect(
      inPanel.violations.filter(
        ({ impact }) => impact === 'serious' || impact === 'critical',
      ),
    ).toEqual([]);
    await dialog.getByRole('button', { name: 'Cancelar' }).click();

    const media = await transcribedAudio(owner);
    await script(page, media.id, [
      {
        stages: [
          ...DONE,
          stage({
            stage: 'tracks',
            state: 'running',
            percent: 50,
            windows: { done: 2, total: 4 },
            reservedUsd: 0.02,
            spentUsd: 0.01,
          }),
        ] as MediaPreparation['stages'],
        tracks: [track(1, 5_000, 15_000)] as MediaPreparation['tracks'],
      },
    ]);
    await page.goto(`/midia/${media.id}/preparar`);
    await expect(page.getByText('Pergunta 1')).toBeVisible();
    const onPage = await new AxeBuilder({ page }).analyze();
    expect(
      onPage.violations.filter(
        ({ impact }) => impact === 'serious' || impact === 'critical',
      ),
    ).toEqual([]);
    await owner.dispose();
  });
