import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Page, Route } from '@playwright/test';
import {
  expect,
  invite,
  ownerApi,
  pageAs,
  test,
  uniqueEmail,
} from './fixtures.js';
import { audioWithTracks, handle, trackRow } from './tracks-helpers.js';
import { separateVoices, transcribedAudio } from './voices-helpers.js';

// KBC-067 on the screen of KBC-066. The E2E server cannot script its fake model, so the
// proposal's routes answer here with the contract's shapes; everything on the page is real.
const RUN = '11111111-1111-4111-8111-111111111111';

const aiTrack = (
  index: number,
  span: { startMs: number; endMs: number; title: string | null },
) => ({
  id: `22222222-2222-4222-8222-00000000000${index}`,
  runId: RUN,
  source: 'ai',
  edited: false,
  firstSegment: index,
  lastSegment: index,
  ...span,
  kind: 'qa',
  askerVoice: 2,
  answererVoice: 1,
  askerSpeakerId: null,
  answererSpeakerId: null,
});

const FIRST = aiTrack(1, {
  startMs: 0,
  endMs: 15_000,
  title: 'Como o senhor chegou lá?',
});
const SECOND = aiTrack(2, { startMs: 15_000, endMs: 40_000, title: null });

const aRun = (mediaId: string, status: string, windowsDone: number) => ({
  id: RUN,
  mediaId,
  model: 'stub',
  tracks: windowsDone,
  status,
  windowsDone,
  windowsTotal: 2,
  estimateUsd: 0.02,
  spentUsd: status === 'done' ? 0.018 : 0.01,
  failure: status === 'failed' ? 'provider' : null,
  createdAt: '2026-11-04T05:00:00.000Z',
  finishedAt: status === 'running' ? null : '2026-11-04T05:01:00.000Z',
});

const ESTIMATE = {
  allowed: true,
  estimateUsd: 0.02,
  runCapUsd: 0.25,
  windows: 2,
  model: 'stub',
  refusal: null,
  month: { spentUsd: 1.5, capUsd: 10 },
};

const VOICES = [
  {
    voice: 1,
    name: 'Mestre Gabriel',
    audience: false,
    reason: 'é o autor do áudio e responde 9 de 10 perguntas',
  },
  {
    voice: 3,
    name: null,
    audience: true,
    reason: 'pergunta uma vez, da plateia',
  },
];

interface Scripted {
  /** Reads of the edit since the run started: the script moves on with them. */
  reads: number;
  started: boolean;
}

/** Answers the proposal's routes, and `GET …/edit` as the run goes, ending in `end`. */
async function script(page: Page, mediaId: string, end: 'done' | 'failed') {
  const state: Scripted = { reads: 0, started: false };
  await page.route(
    new RegExp(`/api/v1/media/${mediaId}/edit/proposals$`),
    async (route: Route) => {
      const { dryRun } = route.request().postDataJSON() as { dryRun?: boolean };
      if (dryRun) return route.fulfill({ json: ESTIMATE });
      state.started = true;
      return route.fulfill({
        status: 202,
        json: aRun(mediaId, 'running', 0),
      });
    },
  );
  await page.route(
    new RegExp(`/api/v1/media/${mediaId}/edit$`),
    async (route: Route) => {
      if (route.request().method() !== 'GET' || !state.started)
        return route.continue();
      state.reads += 1;
      const response = await route.fetch();
      const edit = (await response.json()) as { version: number };
      const stage = Math.min(state.reads, 3);
      const over = stage === 3;
      const failed = over && end === 'failed';
      await route.fulfill({
        response,
        json: {
          ...edit,
          version: edit.version + state.reads,
          started: true,
          tracks: failed ? [] : [FIRST, SECOND].slice(0, stage),
          run: failed
            ? null
            : aRun(mediaId, over ? 'done' : 'running', stage - 1),
          lastFailure: failed ? 'provider' : null,
          voices: over && !failed ? VOICES : [],
        },
      });
    },
  );
}

const startRun = async (page: Page) => {
  await page.getByRole('button', { name: 'Propor faixas com IA' }).click();
  await expect(page.getByText('Custa cerca de')).toContainText('0,02');
  await expect(page.getByText(/Este mês:/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirmar e propor' }).click();
  await expect(page.getByText(/Propondo… janela/)).toBeVisible();
};

const separated = async (owner: APIRequestContext) => {
  const media = await transcribedAudio(owner);
  await separateVoices(owner, media.id);
  return media;
};

test('KBC-067 AC-1, AC-2: estimate, windows, read-only, proposals, cost and suggestions', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await separated(owner);
  await script(page, media.id, 'done');
  await page.goto(`/midia/${media.id}/faixas`);
  await startRun(page);
  await expect(page.getByRole('slider')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Aprovar faixas' }),
  ).toBeDisabled();
  await expect(trackRow(page, 1)).toContainText('Proposta pela IA', {
    timeout: 20_000,
  });
  await expect(page.getByText(/Custou/)).toContainText('0,018', {
    timeout: 20_000,
  });
  await expect(page.getByText(/Nada é aplicado antes de você/)).toBeVisible();
  expect(
    await page
      .getByTestId('overview-block')
      .first()
      .evaluate((block) => getComputedStyle(block).borderStyle),
  ).toBe('dashed');
  await expect(page.getByText('Mestre Gabriel')).toBeVisible();
  await expect(
    page.getByRole('listitem').filter({ hasText: 'Voz 3:' }),
  ).toContainText('Voz 3: Pergunta da plateia (pergunta uma vez');
  await expect(page.getByRole('slider').first()).toBeVisible();
  const { violations } = await new AxeBuilder({ page })
    .include('app-track-editor-page')
    .analyze();
  expect(
    violations.filter((one) =>
      ['serious', 'critical'].includes(one.impact ?? ''),
    ),
  ).toEqual([]);
  await owner.dispose();
});

test('KBC-067 AC-6, FR-5: a failed run stays said, also after a reload', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await separated(owner);
  await script(page, media.id, 'failed');
  await page.goto(`/midia/${media.id}/faixas`);
  await startRun(page);
  await expect(page.getByText('Não foi possível propor.')).toBeVisible({
    timeout: 25_000,
  });
  await page.reload();
  await expect(page.getByText('Não foi possível propor.')).toBeVisible();
  await owner.dispose();
});

test('KBC-097: a retry says what it costs, also after a reload, and a dearer one waits for a press', async ({
  page,
}, testInfo) => {
  const owner = await ownerApi();
  const media = await separated(owner);
  const sent: { acceptedUsd?: number }[] = [];
  await page.route(
    new RegExp(`/api/v1/media/${media.id}/edit/proposals$`),
    async (route: Route) => {
      const body = route.request().postDataJSON() as {
        dryRun?: boolean;
        acceptedUsd?: number;
      };
      if (body.dryRun)
        return route.fulfill({
          json: sent.length
            ? { ...ESTIMATE, estimateUsd: 0.05, windows: 3, restarts: true }
            : ESTIMATE,
        });
      sent.push(body);
      return sent.length === 1
        ? route.fulfill({
            status: 409,
            json: {
              error: {
                code: 'MEDIA_CONFLICT',
                message: 'The estimate rose',
                details: { reason: 'estimate-rose', estimateUsd: 0.05 },
              },
            },
          })
        : route.fulfill({
            status: 202,
            json: aRun(media.id, 'running', 0),
          });
    },
  );
  await page.goto(`/midia/${media.id}/faixas`);
  await page.reload();
  await page.getByRole('button', { name: 'Propor faixas com IA' }).click();
  await expect(page.getByText('Custa cerca de')).toContainText('0,02');
  await expect(page.getByText(/recomeça do início/)).toBeHidden();
  await page.getByRole('button', { name: 'Confirmar e propor' }).click();

  await expect(page.getByText('Custa cerca de')).toContainText('0,05');
  await expect(page.getByText(/recomeça do início/)).toBeVisible();
  const notice = page.getByText(
    'O valor mudou. Nada foi gasto: confira o novo valor.',
  );
  await expect(notice).toBeVisible();
  // Above the actions: on a phone the bar at the bottom does not cover it (QA R2-5).
  const noticeBox = await notice.boundingBox();
  const confirmBox = await page
    .getByRole('button', { name: 'Confirmar e propor' })
    .boundingBox();
  expect(noticeBox && confirmBox).toBeTruthy();
  expect((noticeBox?.y ?? 0) + (noticeBox?.height ?? 0)).toBeLessThanOrEqual(
    confirmBox?.y ?? 0,
  );
  await expect(notice).toBeInViewport();
  const footBox = await page.locator('.foot').boundingBox();
  expect((noticeBox?.y ?? 0) + (noticeBox?.height ?? 0)).toBeLessThanOrEqual(
    footBox?.y ?? 0,
  );
  // The actions under it are clear of the bar too (QA round 3).
  for (const name of ['Confirmar e propor', 'Cancelar']) {
    const box = await page.getByRole('button', { name }).boundingBox();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(
      footBox?.y ?? 0,
    );
  }
  expect(sent).toEqual([{ dryRun: false, acceptedUsd: 0.02 }]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `../work/KBC-097/retry-restarts-${testInfo.project.name}.png`,
  });
  expect(
    await new AxeBuilder({ page }).include('.proposals').analyze(),
  ).toMatchObject({ violations: [] });

  await page.getByRole('button', { name: 'Confirmar e propor' }).click();
  await expect(page.getByText(/Propondo… janela/)).toBeVisible();
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual({ dryRun: false, acceptedUsd: 0.05 });
  await owner.dispose();
});

test('R-5: a read that fails does not leave the editor stuck', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await separated(owner);
  await script(page, media.id, 'done');
  await page.goto(`/midia/${media.id}/faixas`);
  await expect(
    page.getByRole('button', { name: 'Propor faixas com IA' }),
  ).toBeVisible();
  let refused = false;
  await page.route(
    new RegExp(`/api/v1/media/${media.id}/edit$`),
    async (route) => {
      if (route.request().method() === 'GET' && !refused) {
        refused = true;
        return route.abort();
      }
      return route.fallback();
    },
  );
  await startRun(page);
  await expect(page.getByText(/Custou/)).toBeVisible({ timeout: 25_000 });
  await expect(page.getByRole('slider').first()).toBeVisible();
  expect(refused).toBe(true);
  await owner.dispose();
});

test('R-5: without `media-edit-ai` the screen says why it is read-only, and comes back', async ({
  browser,
  viewport,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  const email = uniqueEmail('so-edita');
  await invite(owner, email, {
    topics: ['hermetismo'],
    features: ['media', 'media-edit'],
  });
  const page = await pageAs(browser, email, viewport);
  let reads = 0;
  await page.route(
    new RegExp(`/api/v1/media/${media.id}/edit$`),
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      reads += 1;
      const response = await route.fetch();
      const edit = (await response.json()) as { version: number };
      const running = reads < 3;
      return route.fulfill({
        response,
        json: {
          ...edit,
          version: edit.version + reads,
          run: running ? aRun(media.id, 'running', 1) : null,
        },
      });
    },
  );
  await page.goto(`/midia/${media.id}/faixas`);
  await expect(
    page.getByText(/Uma análise com IA está propondo/),
  ).toBeVisible();
  await expect(page.getByRole('slider')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Propor faixas com IA' }),
  ).toHaveCount(0);
  await expect(handle(page, 'Início da faixa 1')).toBeVisible({
    timeout: 25_000,
  });
  await expect(page.getByText(/Uma análise com IA está propondo/)).toHaveCount(
    0,
  );
  await page.context().close();
  await owner.dispose();
});
