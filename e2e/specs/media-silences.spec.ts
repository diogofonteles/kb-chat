import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, ownerApi } from './fixtures.js';
import {
  audioState,
  listenerTest as test,
  toneWithPauses,
  uniqueTag,
  uploadReady,
  useTheme,
  type UploadedMedia,
} from './media-helpers.js';

/**
 * KBC-044: "Encurtar silêncios". The lecture is a tone with pauses of known length (s):
 * 3 s at 6–9, 3.5 s at 9.5–13 (where AC-4 jumps in), 3 s at 15–18 and 0.5 s at 20–20.5.
 */
const PAUSES = [
  [6, 9],
  [9.5, 13],
  [15, 18],
  [20, 20.5],
] as const;

interface Pause {
  readonly startMs: number;
  readonly endMs: number;
}

let lecture: UploadedMedia;

// One worker per project runs this file: its media are made once in `beforeAll`, which
// fully parallel would repeat in every worker that picks a test of the file (up to eight
// conversions of the same recordings, queued with every other spec's).
test.describe.configure({ mode: 'default' });

test.beforeAll(async () => {
  const owner = await ownerApi();
  lecture = await uploadReady(owner, {
    title: `Silêncios ${uniqueTag()}`,
    seconds: 30,
    source: toneWithPauses(30, PAUSES),
  });
  // The worker measures the silences after the conversion (FR-1).
  await expect
    .poll(
      async () =>
        (
          (await (
            await owner.get(`/api/v1/media/${lecture.id}/silences`)
          ).json()) as { status: string }
        ).status,
      { timeout: 30_000 },
    )
    .toBe('ready');
  await owner.dispose();
});

/** The map as the player reads it, with the listener's session. */
async function pausesOf(page: Page): Promise<Pause[]> {
  const answer = await page.request.get(`/api/v1/media/${lecture.id}/silences`);
  expect(answer.status()).toBe(200);
  return ((await answer.json()) as { intervals: Pause[] }).intervals;
}

async function openPlayer(page: Page) {
  await page.goto(`/midia/${lecture.id}`);
  await expect(page.getByRole('button', { name: 'Tocar' })).toBeEnabled();
}

async function openSilences(page: Page) {
  await page.getByRole('button', { name: 'Mais opções' }).click();
  await page.getByRole('menuitem', { name: /^Encurtar silêncios/ }).click();
  return page.getByRole('dialog', { name: 'Encurtar silêncios' });
}

async function turnOn(page: Page) {
  const dialog = await openSilences(page);
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/media/preferences') &&
      response.request().method() === 'PUT',
  );
  await dialog.getByRole('checkbox', { name: 'Encurtar silêncios' }).check();
  expect((await saved).status()).toBe(200);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}

/** Samples the element's `currentTime` (ms) every 20 ms from now on (NFR-2). */
async function startSampling(page: Page) {
  await page.evaluate(() => {
    const element = document.querySelector<HTMLMediaElement>(
      '[data-media-engine]',
    );
    const samples: number[] = [];
    Object.assign(window, { kbcSamples: samples });
    setInterval(
      () => samples.push(Math.round((element?.currentTime ?? 0) * 1000)),
      20,
    );
  });
}

const samplesOf = (page: Page): Promise<number[]> =>
  page.evaluate(
    () => (window as unknown as { kbcSamples: number[] }).kbcSamples,
  );

/** Each forward jump of more than 0.5 s between two samples: [before, after]. */
const jumpsIn = (samples: readonly number[]): [number, number][] =>
  samples.flatMap((now, index) => {
    const next = samples[index + 1];
    return next !== undefined && next - now > 500 ? [[now, next]] : [];
  });

async function playUntil(page: Page, seconds: number) {
  await page.getByRole('button', { name: 'Tocar' }).click();
  await expect
    .poll(async () => (await audioState(page)).currentTime, {
      timeout: 30_000,
    })
    .toBeGreaterThan(seconds);
}

test('AC-2 and NFR-2: on, the 3 s pause is jumped 0.15 s in, to 0.15 s before its end', async ({
  page,
}) => {
  await openPlayer(page);
  const [first] = await pausesOf(page);
  if (!first) throw new Error('the lecture has no pause');
  await turnOn(page);
  await startSampling(page);
  await playUntil(page, first.endMs / 1000 + 0.5);
  const [jump] = jumpsIn(await samplesOf(page));
  if (!jump) throw new Error('no jump over the pause');
  const [before, after] = jump;
  // NFR-2: the jump happens by 150 ms into the pause (one 20 ms sample of slack).
  expect(before - first.startMs).toBeLessThanOrEqual(170);
  // It lands 0.15 s before the end (a sample may come up to 20 ms later, at 2×: 40).
  expect(after).toBeGreaterThanOrEqual(first.endMs - 150);
  expect(after).toBeLessThan(first.endMs);
  test.info().annotations.push({
    type: 'NFR-2',
    description: `jumped ${before - first.startMs} ms into the pause, landed ${first.endMs - after} ms before its end`,
  });
  await page.getByRole('button', { name: 'Pausar' }).click();
  const dialog = await openSilences(page);
  await expect(dialog.getByText(/Tempo economizado nesta mídia/)).toContainText(
    /Tempo economizado nesta mídia: 0:0[3-6]/,
  );
});

test('AC-3: off, playing goes through the pauses with no jump', async ({
  page,
}) => {
  await openPlayer(page);
  const [first] = await pausesOf(page);
  if (!first) throw new Error('the lecture has no pause');
  const dialog = await openSilences(page);
  await expect(
    dialog.getByRole('checkbox', { name: 'Encurtar silêncios' }),
  ).not.toBeChecked();
  await page.keyboard.press('Escape');
  await startSampling(page);
  await playUntil(page, first.endMs / 1000 + 0.3);
  expect(jumpsIn(await samplesOf(page))).toEqual([]);
});

test('AC-4: a jump of the person into a pause is respected; the next pause is shortened', async ({
  page,
}) => {
  await openPlayer(page);
  const pauses = await pausesOf(page);
  const [, second, third] = pauses;
  if (!second || !third) throw new Error('the lecture has too few pauses');
  await turnOn(page);
  // The slider's → moves 5 s: twice lands at 10 s, inside the 9.5–13 s pause.
  const slider = page.getByRole('slider', { name: 'Posição' });
  await slider.focus();
  await slider.press('ArrowRight');
  await slider.press('ArrowRight');
  await expect
    .poll(async () => Math.round((await audioState(page)).currentTime))
    .toBe(10);
  await startSampling(page);
  await playUntil(page, third.endMs / 1000 + 0.3);
  const jumps = jumpsIn(await samplesOf(page));
  // The pause the person jumped into is heard to its end; only the next one is jumped.
  expect(jumps).toHaveLength(1);
  expect(jumps[0]?.[0]).toBeGreaterThan(third.startMs);
});

test('AC-7: with silences shortened, the bar, the times and the saved position stay on the original timeline', async ({
  page,
}) => {
  await openPlayer(page);
  await turnOn(page);
  await playUntil(page, 10);
  await page.getByRole('button', { name: 'Pausar' }).click();
  const at = (await audioState(page)).currentTime;
  // The elapsed time and the slider say the media's own second, past the skipped pauses.
  await expect(page.locator('.elapsed')).toHaveText(
    `0:${String(Math.floor(at)).padStart(2, '0')}`,
  );
  await expect(page.getByRole('slider', { name: 'Posição' })).toHaveAttribute(
    'aria-valuenow',
    String(Math.floor(at)),
  );
  await expect
    .poll(async () => {
      const item = (await (
        await page.request.get(`/api/v1/media/${lecture.id}`)
      ).json()) as { positionMs: number };
      return Math.abs(item.positionMs - at * 1000);
    })
    .toBeLessThan(1_000);
});

for (const theme of ['light', 'dark', 'esoteric'] as const) {
  test(`the "Encurtar silêncios" dialog passes axe in the ${theme} theme`, async ({
    page,
  }) => {
    await useTheme(page, theme);
    await openPlayer(page);
    const dialog = await openSilences(page);
    await expect(
      dialog.getByText(/Tempo economizado nesta mídia/),
    ).toContainText('Tempo economizado nesta mídia: 0:00');
    const violations = (
      await new AxeBuilder({ page }).analyze()
    ).violations.filter((violation) =>
      ['serious', 'critical'].includes(violation.impact ?? ''),
    );
    expect(violations).toEqual([]);
  });
}
