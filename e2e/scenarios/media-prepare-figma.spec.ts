import type { Page } from '@playwright/test';
import { expect, test } from '../specs/fixtures.js';
import {
  ALVARO,
  TOPIC,
  TRANSCRIBER_OFF,
  WIDTHS,
  contextAt,
  go,
  playInterview,
  seedPlayerWorld,
  shoot,
  shotsDone,
  type PlayerWorld,
} from './figma-player-world.js';

/**
 * The states of "Preparar áudio" (media-prepare-*) in the v2 · Mídia — Preparar, Faixas e
 * Limites frames, at 1440×900 and 390×844, on the frames' own sample data
 * (figma-player-world.ts, the interview playing at 0:22 below): the capture recipe of the
 * Figma inventory check (figma-recreation/tools/inventory/check.sh prepare). It only reaches
 * each state and saves it: the behaviour is proven by e2e/specs/media-preparation.spec.ts and
 * media-v2-prepare.spec.ts.
 *
 * Step 1 ("Palestra de abertura do ciclo"), "Nada a preparar" (the recording) and "Sem
 * permissão" (who only listens) are the server's own. Step 2 of "Aula para preparar" is a
 * pipeline moment no E2E server reaches (no transcriber, no worker, the fake model): its four
 * states — concluded, running, proposing, failed — come as the contract's shape, as
 * e2e/specs/media-preparation.spec.ts serves them. Needs a fresh E2E server.
 * `KBC_FIDELITY_SHOTS=<dir>` saves `<state-id>[@mobile].png`.
 */

test.describe.configure({ timeout: 600_000 });
// A step that cannot be taken fails at once, not at the end of the test's ten minutes.
test.use({ actionTimeout: 15_000 });

let world: PlayerWorld;
test.beforeAll(async () => {
  test.setTimeout(600_000);
  world = await seedPlayerWorld();
});

/* The guided flow's step 2 as the contract has it. */
const stage = (over: Record<string, unknown>) => ({
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
  restarts: false,
  ...over,
});
const done = (name: string) => stage({ stage: name, state: 'done' });
const DONE = ['upload', 'convert', 'transcribe', 'speakers'].map(done);
/** "Vozes achadas: 2": the answerer 41 s, the audience 12 s. */
const VOICES = [
  { voice: 1, speakingMs: 41_000, name: ALVARO, audience: false },
  { voice: 2, speakingMs: 12_000, name: null, audience: true },
];
const proposed = (index: number, startMs: number, endMs: number) => ({
  id: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`,
  title: `Pergunta ${index}`,
  startMs,
  endMs,
  asker: { name: null, voice: 2, audience: true },
  answerer: { name: ALVARO, voice: 1, audience: false },
  status: 'proposed',
});

/** "Aula para preparar" on step 2, as `over` has it. */
async function stepTwo(
  page: Page,
  w: PlayerWorld,
  over: Record<string, unknown>,
): Promise<void> {
  const id = w.byCode['AP'] ?? '';
  await page.context().unroute(`**/api/v1/media/${id}/preparation`);
  await page.context().route(`**/api/v1/media/${id}/preparation`, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: {
            mediaId: id,
            title: 'Aula para preparar',
            topic: TOPIC,
            author: null,
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
            voices: VOICES,
            suggestions: [],
            refusedVoices: [],
            nameReviews: [],
            tracks: [],
            next: null,
            canSwitchToManual: false,
            transcriber: 'off',
            transcriberOffSince: TRANSCRIBER_OFF,
            ...over,
          },
        })
      : route.continue(),
  );
}

/** Out to the library and back in: the preparation page reads its state as it opens. */
async function reopen(page: Page, path: string): Promise<void> {
  await go(page, '/biblioteca');
  await go(page, path);
}

test('"Preparar áudio": step 1, step 2 in its four moments, nothing left, no permission', async ({
  browser,
}) => {
  const ap = `/midia/${world.byCode['AP']}/preparar`;
  for (const width of WIDTHS) {
    const { context, page } = await contextAt(browser, width);
    await playInterview(page, world);

    await go(page, `/midia/${world.byCode['PA']}/preparar`);
    await expect(
      page.getByRole('button', { name: 'Preparar', exact: true }),
    ).toBeVisible();
    await shoot(page, 'media-prepare-choose', { width, top: true });

    await go(page, `/midia/${world.byCode['PR']}/preparar`);
    await expect(page.getByText(/já está transcrito/).first()).toBeVisible();
    await shoot(page, 'media-prepare-nothing-left', { width, top: true });

    await stepTwo(page, world, {
      plan: {
        transcribe: false,
        speakers: false,
        tracks: 'manual',
        subjects: false,
        acceptedUsd: null,
      },
      stages: [done('upload'), done('convert')],
      separation: null,
      voices: [],
      next: 'validate',
    });
    await reopen(page, ap);
    await expect(
      page.getByRole('button', { name: 'Validar faixas' }).first(),
    ).toBeVisible();
    await shoot(page, 'media-prepare-concluded', { width, top: true });

    await stepTwo(page, world, {
      stages: [
        done('upload'),
        done('convert'),
        stage({
          stage: 'transcribe',
          state: 'running',
          percent: 35,
          cuts: { done: 14, total: 40 },
        }),
        stage({ stage: 'speakers', state: 'waiting' }),
        stage({ stage: 'tracks', state: 'waiting' }),
      ],
    });
    await reopen(page, ap);
    await expect(page.getByText(/cortes 14 de 40/).first()).toBeVisible();
    await shoot(page, 'media-prepare-running', { width, top: true });

    await stepTwo(page, world, {
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
      ],
      tracks: [proposed(1, 5_000, 15_000), proposed(2, 15_000, 40_000)],
    });
    await reopen(page, ap);
    await expect(page.getByText('Pergunta 2').first()).toBeVisible();
    await shoot(page, 'media-prepare-proposing', { width, top: true });

    await stepTwo(page, world, {
      stages: [
        ...DONE,
        stage({
          stage: 'tracks',
          state: 'failed',
          failure: 'provider',
          canRetry: true,
          estimateUsd: 0.02,
          windows: { done: 1, total: 3 },
          spentUsd: 0.0012,
        }),
      ],
      tracks: [proposed(1, 5_000, 15_000)],
      canSwitchToManual: true,
    });
    await reopen(page, ap);
    await expect(
      page.getByText(/o provedor de IA não respondeu/).first(),
    ).toBeVisible();
    await shoot(page, 'media-prepare-failed', { width, top: true });
    await context.close();

    const listener = await contextAt(browser, width, world.listener);
    await playInterview(listener.page, world);
    await go(listener.page, ap);
    await expect(
      listener.page.getByText(/não tem permissão para editar/).first(),
    ).toBeVisible();
    await shoot(listener.page, 'media-prepare-forbidden', { width, top: true });
    await listener.context.close();
  }
});

test.afterAll(() => shotsDone());
