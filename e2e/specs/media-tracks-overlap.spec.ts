import type { Page, Route } from '@playwright/test';
import { expect, ownerApi, test } from './fixtures.js';
import { approve, audioWithTracks, trackRow } from './tracks-helpers.js';

// KBC-094 and KBC-095. No save can make an overlap, so the draft an older proposal left is
// answered here on the read; saves and approvals go to the real API.

/** Eleven tracks of 5 s: the third starts 42 ms before the second ends. */
const TRACKS = Array.from({ length: 11 }, (_, index) => ({
  startMs: index * 5_000,
  endMs: (index + 1) * 5_000,
  title: `Pergunta ${index + 1}`,
}));
const LONG_TRACKS = [
  { startMs: 0, endMs: 20_000, title: 'Primeira' },
  { startMs: 20_000, endMs: 40_000, title: 'Segunda' },
  { startMs: 40_000, endMs: 59_000, title: 'Terceira' },
];

/** Until a save goes through, the read answers with an overlap on the track at `index`. */
async function withOverlap(page: Page, mediaId: string, index: number) {
  await page.route(`**/api/v1/media/${mediaId}/edit`, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const real = await route.fetch();
    const edit = (await real.json()) as {
      version: number;
      tracks: { startMs: number }[];
    };
    const track = edit.tracks[index];
    if (edit.version === 1 && track) track.startMs -= 42;
    return route.fulfill({ json: edit });
  });
}

/** How many saves left the page. */
function countSaves(page: Page, mediaId: string) {
  const saves = { sent: 0 };
  page.on('request', (request) => {
    if (
      request.method() === 'PUT' &&
      request.url().endsWith(`/media/${mediaId}/edit`)
    )
      saves.sent += 1;
  });
  return saves;
}

const inView = async (page: Page, ordinal: number) => {
  const box = await trackRow(page, ordinal).boundingBox();
  const foot = await page.locator('.foot').boundingBox();
  const height = page.viewportSize()?.height ?? 0;
  expect(box, 'the row is on the page').not.toBeNull();
  expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.y ?? height) + 48).toBeLessThanOrEqual(foot?.y ?? height);
};

test('KBC-094: "Aprovar faixas" answers where the person is, and one press closes the overlap', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner, LONG_TRACKS.slice(0, 2));
  await withOverlap(page, media.id, 1);
  await page.goto(`/midia/${media.id}/faixas`);

  await page.getByRole('button', { name: 'Aprovar faixas' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Faixa 2: Sobreposta à anterior em 0,042 s',
  );
  await expect(trackRow(page, 2).getByRole('button').first()).toBeFocused();
  await inView(page, 2);

  await page
    .getByRole('button', { name: 'Encostar na faixa anterior' })
    .click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.foot .saved')).toBeVisible();
  await page.getByRole('button', { name: 'Aprovar faixas' }).click();
  await expect(
    page.getByRole('heading', { name: '2 faixas aplicadas.' }),
  ).toBeFocused();
  await owner.dispose();
});

test('KBC-094: with the list long, the press brings the problem into view', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner, TRACKS);
  await withOverlap(page, media.id, 9);
  await page.goto(`/midia/${media.id}/faixas`);
  await page.getByRole('button', { name: 'Aprovar faixas' }).click();
  await expect(trackRow(page, 10).getByRole('button').first()).toBeFocused();
  await inView(page, 10);
  await owner.dispose();
});

test('KBC-094: a save refused for a track names it and does not pile up', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner, LONG_TRACKS);
  await withOverlap(page, media.id, 2);
  const saves = countSaves(page, media.id);
  await page.goto(`/midia/${media.id}/faixas`);

  const title = page.getByRole('textbox', { name: 'Título' });
  await title.fill('Primeira, renomeada');
  await title.press('Enter');
  await expect(page.getByRole('alert')).toContainText(
    'Faixa 3: Sobreposta à anterior em 0,042 s',
  );
  await expect(page.getByRole('alert')).not.toContainText('Não consegui');
  await expect(page.getByText('Não salvo: corrija a faixa 3')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Tentar de novo' }),
  ).toHaveCount(0);
  expect(saves.sent).toBe(1);

  await title.fill('Primeira, de novo');
  await title.press('Enter');
  await page.waitForTimeout(1_500);
  expect(saves.sent).toBe(1);

  await trackRow(page, 3).getByRole('button').first().click();
  await page
    .getByRole('button', { name: 'Encostar na faixa anterior' })
    .click();
  await expect(page.locator('.foot .saved')).toBeVisible();
  expect(saves.sent).toBe(2);
  await owner.dispose();
});

test('KBC-095: step 4 says preparation is finished and offers no pending action', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  await approve(owner, media.id);
  await page.goto(`/midia/${media.id}/faixas`);
  await expect(page.getByTestId('step-text')).toContainText('Concluído');
  await expect(page.getByTestId('step-text')).not.toContainText('Aprovar');
  await expect(
    page.getByText('Preparação concluída: você não precisa fazer mais nada.'),
  ).toBeVisible();
  await expect(page.getByText('salvos sozinhos')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Ver no player' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Reabrir edição' }),
  ).toBeVisible();
  await owner.dispose();
});

test('KBC-095: a track number stays on one line, right-aligned, at any length', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  await approve(owner, media.id);
  await page.route(
    `**/api/v1/media/${media.id}/edit/subjects`,
    async (route: Route) => {
      const real = await route.fetch();
      const step = (await real.json()) as {
        tracks: { ordinal: number | null; title: string }[];
      };
      step.tracks.forEach((track, index) => {
        track.ordinal = [9, 16, 120][index] ?? null;
        track.title = 'Um título bem longo '.repeat(5).trim();
      });
      return route.fulfill({ json: step });
    },
  );
  await page.goto(`/midia/${media.id}/faixas`);
  const numbers = page.locator('app-track-subject-row .ordinal');
  await expect(numbers).toHaveCount(3);
  const boxes = await numbers.evaluateAll((all) =>
    all.map((one) => {
      const text = document.createRange();
      text.selectNodeContents(one);
      return {
        lines: text.getClientRects().length,
        right: Math.round(one.getBoundingClientRect().right),
      };
    }),
  );
  expect(boxes.map((one) => one.lines)).toEqual([1, 1, 1]);
  expect(new Set(boxes.map((one) => one.right)).size).toBe(1);
  await owner.dispose();
});
