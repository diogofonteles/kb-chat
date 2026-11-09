import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page, Route } from '@playwright/test';
import { expect, ownerApi, test } from './fixtures.js';
import { uniqueTag, uploadReady, useTheme } from './media-helpers.js';
import { seedDraft, trackRow } from './tracks-helpers.js';
import { rawOf, seedTranscript } from './transcript-helpers.js';

// KBC-092: the track's text on steps 2 and 3 of "Preparar áudio", with the spoken word
// painted while the screen's own listening plays it. The transcript is real (seeded with
// known word times, 0.3 s apart); step 2's stages come as the contract's shape.

const BEFORE = 'antes de tudo isso';
/** Starts at 29.4 s: "agora" (30 s) and "dentro" (30.3 s) are track 2's. */
const EDGE_IN = 'ainda antes agora dentro';
const FIRST_LINE = 'o que está em cima';
const NO_TIMES = 'Este trecho veio sem tempos por palavra.';
const WORD_COUNT = 40;
const LONG_LINE = Array.from(
  { length: WORD_COUNT },
  (_, i) => `termo${i}`,
).join(' ');
const LONG_LINE_AT = 50;
const LONG_WORD = `uma ${'Pneumoultramicroscopicossilicovulcanoconiotico'.repeat(2)} aqui`;
/** Starts at 69.4 s: "fora" starts at 1:10, so it is track 3's (AC-1). */
const EDGE_OUT = 'quase fim fora daqui';
const FILLER = Array.from({ length: 28 }, (_, i) => ({
  at: Number((72 + i * 1.3).toFixed(1)),
  text: `Linha ${i} de enchimento`,
}));

function lectureRaw() {
  const raw = rawOf([
    { at: 10, text: BEFORE },
    { at: 29.4, text: EDGE_IN },
    { at: 40, text: FIRST_LINE },
    { at: 45, text: NO_TIMES },
    { at: LONG_LINE_AT, text: LONG_LINE },
    { at: 63, text: LONG_WORD },
    { at: 69.4, text: EDGE_OUT },
    ...FILLER,
  ]);
  const [chunk] = raw.chunks;
  if (!chunk) throw new Error('no chunk');
  const segments = chunk.result.segments.map((segment) =>
    segment.text.trim() === NO_TIMES ? { ...segment, words: [] } : segment,
  );
  return { chunks: [{ ...chunk, result: { segments } }] };
}

const TRACKS = [
  { startMs: 0, endMs: 30_000, title: 'Primeira pergunta' },
  { startMs: 30_000, endMs: 70_000, title: 'Segunda pergunta' },
  { startMs: 70_000, endMs: 110_000, title: 'Terceira pergunta' },
];
/** Step 2 only: a stretch with no speech (AC-10). */
const SILENT = { startMs: 110_000, endMs: 118_000, title: 'Silêncio' };

interface Media {
  readonly id: string;
  readonly title: string;
}

let lecture: Media;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  const owner = await ownerApi();
  lecture = await uploadReady(owner, {
    title: `Texto da faixa ${uniqueTag()}`,
    seconds: 120,
    bitrate: '32k',
    readyWithinMs: 120_000,
  });
  await seedTranscript(owner, { id: lecture.id, raw: lectureRaw() });
  await seedDraft(owner, lecture.id, TRACKS);
  await owner.dispose();
});

/* ---------- Step 2, its stages as the contract's shape ---------- */

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

const stagesWith = (transcribe: string | null) => [
  stage({ stage: 'upload', state: 'done' }),
  stage({ stage: 'convert', state: 'done' }),
  ...(transcribe ? [stage({ stage: 'transcribe', state: transcribe })] : []),
  stage({ stage: 'tracks', state: 'done' }),
];

const prepTrack = (
  index: number,
  { startMs, endMs, title }: { startMs: number; endMs: number; title: string },
) => ({
  id: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
  title,
  startMs,
  endMs,
  asker: null,
  answerer: null,
  status: 'proposed',
});

interface Step2 {
  /** The transcription stage's state; null for a plan without one. */
  transcribe: string | null;
  readonly tracks?: readonly (typeof SILENT)[];
}

/** Serves step 2 of `media` from `step` as it is at each read (a test may change it). */
async function openStep2(page: Page, media: Media, step: Step2) {
  await page.route(`**/api/v1/media/${media.id}/preparation`, (route) =>
    route.fulfill({
      json: {
        mediaId: media.id,
        title: media.title,
        topic: 'hermetismo',
        author: null,
        step: 2,
        skipped: false,
        finished: false,
        plan: {
          transcribe: step.transcribe !== null,
          speakers: false,
          tracks: 'ai',
          subjects: false,
          acceptedUsd: 0.02,
        },
        stages: stagesWith(step.transcribe),
        separation: null,
        voices: [],
        suggestions: [],
        tracks: (step.tracks ?? [...TRACKS, SILENT]).map((one, index) =>
          prepTrack(index + 1, one),
        ),
        next: null,
        canSwitchToManual: false,
        transcriber: 'on',
        transcriberOffSince: null,
      },
    }),
  );
  await page.goto(`/midia/${media.id}/preparar`);
  await expect(
    page.getByRole('button', { name: 'Ouvir a faixa 1' }),
  ).toBeVisible();
  // The listening's audio comes with the item, read apart from the (routed) preparation:
  // a press before it is there plays nothing (KBC-090's page, outside this item).
  await expect(audition(page)).toBeAttached();
}

/** Step 3 with `ordinal` selected. */
async function openStep3(page: Page, ordinal: number) {
  await page.goto(`/midia/${lecture.id}/faixas`);
  await trackRow(page, ordinal).getByRole('button').first().click();
  await expect(textOf(page, ordinal)).toBeVisible();
}

const textOf = (page: Page, ordinal: number) =>
  page.getByRole('region', { name: `Texto da faixa ${ordinal}` });

const textButton = (page: Page, ordinal: number) =>
  page.getByRole('button', { name: new RegExp(`texto da faixa ${ordinal}$`) });

const audition = (page: Page) =>
  page.locator('audio[hidden]:not([data-media-engine])').first();

/** The word painted now in a track's text; null with none. */
const spokenWord = (page: Page) =>
  page.evaluate(() => {
    interface Registry {
      get(name: string): Iterable<Range> | undefined;
    }
    const registry = (CSS as unknown as { highlights: Registry }).highlights;
    const [range] = Array.from(registry.get('track-word') ?? []);
    return range?.toString() ?? null;
  });

const auditionState = (page: Page) =>
  audition(page).evaluate((element) => ({
    time: (element as HTMLAudioElement).currentTime,
    paused: (element as HTMLAudioElement).paused,
  }));

/**
 * Waits for the listening to really play. `paused` turns false as play() is called, but the
 * screen seeks to the range only once the metadata is in, which would undo a seek made
 * before it; and a loaded WebKit can take seconds to get there. Once the audio moves on, not
 * seeking, the range's seek is done.
 */
async function untilPlaying(page: Page) {
  await expect.poll(async () => (await auditionState(page)).paused).toBe(false);
  const moved = await audition(page).evaluate(async (element) => {
    const audio = element as HTMLAudioElement;
    const until = performance.now() + 15_000;
    let last: number | null = null;
    while (performance.now() < until && !audio.paused) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (audio.seeking) last = null;
      else if (last !== null && audio.currentTime > last) return true;
      else last = audio.currentTime;
    }
    return false;
  });
  expect(moved, 'the listening plays on').toBe(true);
}

/** Waits for the listening to play, then moves it, as the audio going on would. */
async function playingAt(page: Page, seconds: number) {
  await untilPlaying(page);
  await audition(page).evaluate((element, at) => {
    (element as HTMLAudioElement).currentTime = at;
  }, seconds);
}

/**
 * Moves the listening to `seconds` at half speed and records, frame by frame, each word
 * painted until `last` is painted after `first`: a word lasts 0.3 s, too short to catch by
 * polling from the test, so nothing here hangs on timing (QE-16). Returns the words from
 * the last `first` on.
 */
async function paintedFrom(
  page: Page,
  seconds: number,
  [first, last]: readonly [string, string],
): Promise<(string | null)[]> {
  await untilPlaying(page);
  const painted = await audition(page).evaluate(
    async (element, { at, first, last }) => {
      interface Registry {
        get(name: string): Iterable<Range> | undefined;
      }
      const registry = (CSS as unknown as { highlights: Registry }).highlights;
      const audio = element as HTMLAudioElement;
      audio.playbackRate = 0.5;
      audio.currentTime = at;
      const seen: (string | null)[] = [];
      const until = performance.now() + 15_000;
      while (performance.now() < until) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (audio.seeking) continue;
        const [range] = Array.from(registry.get('track-word') ?? []);
        const word = range?.toString() ?? null;
        if (seen.at(-1) !== word) seen.push(word);
        if (word === last && seen.includes(first)) break;
      }
      return seen;
    },
    { at: seconds, first, last },
  );
  return painted.slice(painted.lastIndexOf(first));
}

const lineTexts = (region: Locator) =>
  region
    .locator('.line')
    .evaluateAll((lines) => lines.map((line) => line.textContent));

/* ---------- Step 2 ---------- */

test('AC-1, AC-15: "Ver texto" by keyboard shows only track 2’s speech, and is announced', async ({
  page,
}, testInfo) => {
  await openStep2(page, lecture, { transcribe: 'done' });
  await page.getByRole('button', { name: 'Ouvir a faixa 2' }).focus();
  await page.keyboard.press('Tab');
  const button = textButton(page, 2);
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Enter');
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(button).toHaveAccessibleName('Esconder texto da faixa 2');
  const region = textOf(page, 2);
  await expect(button).toHaveAttribute(
    'aria-controls',
    (await region.getAttribute('id')) ?? 'none',
  );
  await expect(region).toContainText('agora dentro');
  await expect(region).toContainText(FIRST_LINE);
  await expect(region).toContainText('quase fim');
  await expect(region).not.toContainText('ainda antes');
  await expect(region).not.toContainText('fora daqui');
  // The words are no elements, so no Tab stops (AC-15).
  await expect(region.locator('.line *')).toHaveCount(0);
  await expect(button).toBeFocused();
  await saveEvidence(page, `${testInfo.project.name}-step2-text`);
});

test('AC-2, AC-15: "Ouvir" opens the text and "está" is marked between its start and that of "em"', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openStep2(page, lecture, { transcribe: 'done' });
  await page.getByRole('button', { name: 'Ouvir a faixa 2' }).click();
  await expect(textOf(page, 2)).toBeVisible();
  await textButton(page, 2).focus();
  expect(await paintedFrom(page, 40.3, ['está', 'em'])).toEqual(['está', 'em']);
  // The highlight moving never moves the focus.
  await expect(textButton(page, 2)).toBeFocused();
  // AC-8: a segment without word times is marked whole, with no error.
  await playingAt(page, 45.5);
  await expect(textOf(page, 2).locator('.line.speaking')).toHaveText(NO_TIMES);
  await expect.poll(() => spokenWord(page)).toBeNull();
  expect(errors).toEqual([]);
});

test('AC-3: one text open at a time, and closing it keeps the audio playing', async ({
  page,
}) => {
  await openStep2(page, lecture, { transcribe: 'done' });
  await textButton(page, 1).click();
  await expect(textOf(page, 1)).toBeVisible();
  await page.getByRole('button', { name: 'Ouvir a faixa 3' }).click();
  await expect(textOf(page, 3)).toBeVisible();
  await expect(textOf(page, 1)).toHaveCount(0);
  await expect.poll(async () => (await auditionState(page)).paused).toBe(false);
  await textButton(page, 3).click();
  await expect(textOf(page, 3)).toHaveCount(0);
  expect((await auditionState(page)).paused).toBe(false);
  await expect(
    page.getByRole('button', { name: 'Parar a faixa 3' }),
  ).toBeVisible();
});

test('AC-10: a track over a stretch without speech says so', async ({
  page,
}) => {
  await openStep2(page, lecture, { transcribe: 'done' });
  await textButton(page, 4).click();
  await expect(textOf(page, 4)).toHaveText(
    'Nenhuma fala transcrita neste trecho.',
  );
});

/** The media item as the page reads it, with its transcription replaced. */
async function itemWith(page: Page, media: Media, transcription: object) {
  await page.route(`**/api/v1/media/${media.id}`, async (route: Route) => {
    const response = await route.fetch();
    const item = (await response.json()) as { transcription: object };
    await route.fulfill({
      response,
      json: {
        ...item,
        transcription: { ...item.transcription, ...transcription },
      },
    });
  });
}

const STATES = [
  {
    name: 'waiting for the transcriber',
    transcribe: 'queued',
    transcription: { status: 'waiting', version: null, confidence: null },
    says: 'O texto aparece quando a transcrição terminar.',
  },
  {
    name: 'transcribing',
    transcribe: 'running',
    transcription: { status: 'transcribing', version: null, confidence: null },
    says: 'O texto aparece quando a transcrição terminar.',
  },
  {
    name: 'failed',
    transcribe: 'failed',
    transcription: { status: 'failed', version: null, confidence: null },
    says: 'A transcrição falhou: não há texto para mostrar.',
  },
  {
    name: 'never transcribed',
    transcribe: null,
    transcription: { status: 'none', version: null, confidence: null },
    says: 'Este áudio não foi transcrito.',
  },
] as const;

for (const state of STATES)
  test(`AC-9: with the transcription ${state.name}, the text says so in words`, async ({
    page,
  }) => {
    const asked: string[] = [];
    page.on('request', (request) => {
      if (/\/transcript(\?|\/words)/.test(request.url()))
        asked.push(request.url());
    });
    await itemWith(page, lecture, state.transcription);
    await openStep2(page, lecture, { transcribe: state.transcribe });
    await textButton(page, 2).click();
    await expect(textOf(page, 2)).toHaveText(state.says);
    expect(asked).toEqual([]);
  });

test('AC-11: a transcript that cannot be read offers "Tentar de novo", and the rest goes on', async ({
  page,
}) => {
  let refuse = true;
  await page.route(
    new RegExp(`/api/v1/media/${lecture.id}/transcript\\?`),
    (route) =>
      refuse ? route.fulfill({ status: 500, body: '{}' }) : route.continue(),
  );
  await openStep2(page, lecture, { transcribe: 'done' });
  await textButton(page, 2).click();
  await expect(textOf(page, 2)).toContainText('Não consegui carregar o texto.');
  // The rest of the screen goes on: "Ouvir" plays, and opens that track's text.
  await page.getByRole('button', { name: 'Ouvir a faixa 1' }).click();
  await expect(
    page.getByRole('button', { name: 'Parar a faixa 1' }),
  ).toBeVisible();
  await expect(textOf(page, 1)).toContainText('Não consegui carregar o texto.');
  refuse = false;
  await page
    .getByRole('button', { name: 'Tentar de novo: carregar o texto' })
    .click();
  await expect(textOf(page, 1)).toContainText(BEFORE);
  // The button is gone with the error: the focus goes to the text, not to the page.
  await expect(textOf(page, 1)).toBeFocused();
});

test('AC-12: a new transcript while the text is open replaces it, with no old word marked', async ({
  page,
}) => {
  const NEWER = 'versão nova da fala inteira';
  let newer = false;
  await page.route(
    new RegExp(`/api/v1/media/${lecture.id}/transcript\\?`),
    async (route) => {
      if (!newer) return route.continue();
      return route.fulfill({
        json: {
          mediaId: lecture.id,
          version: 2,
          confidence: 'normal',
          segments: [{ startMs: 40_000, endMs: 41_500, text: NEWER }],
        },
      });
    },
  );
  await page.route(
    new RegExp(`/api/v1/media/${lecture.id}/transcript/words`),
    async (route) => {
      if (!newer) return route.continue();
      return route.fulfill({
        json: {
          mediaId: lecture.id,
          version: 2,
          words: NEWER.split(' ').map((text, index) => ({
            segment: 0,
            startMs: 40_000 + index * 300,
            endMs: 40_000 + index * 300 + 240,
            text,
          })),
        },
      });
    },
  );
  // A newer transcription runs: the current text stays until it ends.
  const step: Step2 = { transcribe: 'running' };
  await openStep2(page, lecture, step);
  await page.getByRole('button', { name: 'Ouvir a faixa 2' }).click();
  await expect(textOf(page, 2)).toContainText(FIRST_LINE);
  expect(await paintedFrom(page, 40.3, ['está', 'em'])).toEqual(['está', 'em']);
  newer = true;
  step.transcribe = 'done';
  await expect(textOf(page, 2)).toHaveText(NEWER, { timeout: 10_000 });
  expect(await paintedFrom(page, 40.3, ['da', 'fala'])).toEqual(['da', 'fala']);
});

/* ---------- Step 3 ---------- */

test('AC-4, AC-18: step 3 shows the selected track’s text, the spoken word, and the whole transcript on demand', async ({
  page,
}, testInfo) => {
  await openStep3(page, 2);
  const region = textOf(page, 2);
  expect(await lineTexts(region)).toContain(FIRST_LINE);
  await expect(region).not.toContainText(BEFORE);
  await page.getByRole('button', { name: '▶ Ouvir' }).click();
  expect(await paintedFrom(page, 40.3, ['está', 'em'])).toEqual(['está', 'em']);
  await saveEvidence(page, `${testInfo.project.name}-step3-text`);

  await page.getByRole('button', { name: 'Ver transcrição completa' }).click();
  await expect(region).toContainText(BEFORE);
  await expect(region.locator('.line.inside').first()).toHaveText(EDGE_IN);
  expect(await paintedFrom(page, 40.3, ['está', 'em'])).toEqual(['está', 'em']);
  await saveEvidence(page, `${testInfo.project.name}-step3-whole`);
  await page.getByRole('button', { name: 'Ver só a faixa' }).click();
  await expect(region).not.toContainText(BEFORE);
  expect((await auditionState(page)).paused).toBe(false);
});

test('AC-18: with nothing playing, the whole transcript opens at the track’s first line', async ({
  page,
}) => {
  await openStep3(page, 3);
  const region = textOf(page, 3);
  await page.getByRole('button', { name: 'Ver transcrição completa' }).click();
  await expect(region).toContainText(BEFORE);
  const first = region.locator('.line.inside').first();
  await expect(first).toHaveText(EDGE_OUT);
  // Track 3 starts far below the block's top: it has to scroll there, and not past it.
  expect(await settledTop(region)).toBeGreaterThan(0);
  expect(await lineInBlock(first)).toBe(true);
});

/** The block's scrollTop once it stayed put for 10 frames. */
const settledTop = (region: Locator) =>
  region.evaluate(async (block) => {
    let still = 0;
    let last = block.scrollTop;
    while (still < 10) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      still = block.scrollTop === last ? still + 1 : 0;
      last = block.scrollTop;
    }
    return last;
  });

/** The line's top lies inside its block's visible box. */
const lineInBlock = (line: Locator) =>
  line.evaluate((element) => {
    const block = element.closest('[role="region"]');
    if (!block) return false;
    const box = block.getBoundingClientRect();
    const top = element.getBoundingClientRect().top;
    return top >= box.top && top < box.bottom;
  });

interface Sample {
  readonly at: number;
  readonly word: string | null;
}

/** "agora" runs from 30 s to 30.3 s: give or take a frame and NFR-1's 120 ms, it is painted here. */
const onTheFirstWord = ({ at }: Sample) => at >= 30.13 && at < 30.28;

/**
 * Clicks "Ouvir o início" (28 s to 33 s) and records, frame by frame, the time and the
 * painted word from when it plays until the audio is past "agora" or stops, not for a fixed
 * time from the click.
 */
async function listenToTheStart(page: Page): Promise<Sample[]> {
  await page.getByRole('button', { name: 'Ouvir o início' }).click();
  await untilPlaying(page);
  return audition(page).evaluate(async (element) => {
    interface Registry {
      get(name: string): Iterable<Range> | undefined;
    }
    const registry = (CSS as unknown as { highlights: Registry }).highlights;
    const audio = element as HTMLAudioElement;
    const found: Sample[] = [];
    const until = performance.now() + 15_000;
    while (
      performance.now() < until &&
      !audio.paused &&
      audio.currentTime < 30.4
    ) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const [range] = Array.from(registry.get('track-word') ?? []);
      found.push({ at: audio.currentTime, word: range?.toString() ?? null });
    }
    return found;
  });
}

test('AC-5: "Ouvir o início" marks nothing before the start and the first word as it starts', async ({
  page,
}) => {
  await openStep3(page, 2);
  const samples = await listenToTheStart(page);
  // A loaded WebKit can move currentTime in 0.2 s steps, over the 0.15 s that must show
  // "agora": then it listens again (the button is back once the range ends) until a frame
  // lands there. Every frame of every listening is checked below.
  for (let again = 0; again < 2 && !samples.some(onTheFirstWord); again++) {
    samples.push(...(await listenToTheStart(page)));
  }
  const before = samples.filter(({ at }) => at < 29.95);
  expect(before.length).toBeGreaterThan(10);
  expect(before.every(({ word }) => word === null)).toBe(true);
  const first = samples.filter(onTheFirstWord);
  expect(first.length).toBeGreaterThan(0);
  expect(first.every(({ word }) => word === 'agora')).toBe(true);
});

test('AC-7: while the AI proposes, the selected track’s text is there to read', async ({
  page,
}) => {
  await page.route(
    new RegExp(`/api/v1/media/${lecture.id}/edit$`),
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const edit = (await response.json()) as object;
      return route.fulfill({
        response,
        json: {
          ...edit,
          run: {
            id: '44444444-4444-4444-8444-444444444444',
            mediaId: lecture.id,
            model: 'stub',
            tracks: 1,
            status: 'running',
            windowsDone: 1,
            windowsTotal: 2,
            estimateUsd: 0.02,
            spentUsd: 0.01,
            failure: null,
            createdAt: '2026-11-04T05:00:00.000Z',
            finishedAt: null,
          },
        },
      });
    },
  );
  await page.goto(`/midia/${lecture.id}/faixas`);
  await expect(page.getByText(/Propondo.*janela 1 de 2/)).toBeVisible();
  await trackRow(page, 2).getByRole('button').first().click();
  await expect(textOf(page, 2)).toContainText(FIRST_LINE);
  await expect(page.getByRole('textbox', { name: 'Título' })).toHaveCount(0);
});

test('AC-13: the block follows the word inside itself, never the page, and not for 5 s after the person scrolled', async ({
  page,
}) => {
  await openStep3(page, 3);
  const region = textOf(page, 3);
  await page.getByRole('button', { name: '▶ Ouvir' }).click();
  await expect.poll(async () => (await auditionState(page)).paused).toBe(false);
  const pageAt = await page.evaluate(() => window.scrollY);
  // Line 17 of the filler, far below the block's first lines.
  await playingAt(page, 95);
  await expect.poll(() => spokenWord(page)).not.toBeNull();
  await expect
    .poll(() => region.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(pageAt);
  await expectHeldThenFollowed(region);
  expect(await page.evaluate(() => window.scrollY)).toBe(pageAt);
});

test('AC-13, AC-14: each line, once in view, is as tall as its words: none is cut', async ({
  page,
}) => {
  await openStep3(page, 3);
  const region = textOf(page, 3);
  await expect(region).toContainText(FILLER.at(-1)?.text ?? '');
  await region.scrollIntoViewIfNeeded();
  // Most of the block starts out of view: a line sized by a guess until it is seen must
  // still take its words' height when it is, or it clips them and shifts what follows.
  const cut = await region.evaluate(async (block) => {
    const frame = () =>
      new Promise((resolve) => requestAnimationFrame(resolve));
    const found: { text: string | null; line: number; words: number }[] = [];
    for (const line of Array.from(block.querySelectorAll('.line'))) {
      block.scrollTop =
        line.getBoundingClientRect().top -
        block.getBoundingClientRect().top +
        block.scrollTop;
      await frame();
      await frame();
      const words = document.createRange();
      words.selectNodeContents(line);
      const lineHeight = line.getBoundingClientRect().height;
      const wordsHeight = words.getBoundingClientRect().height;
      if (lineHeight + 1 < wordsHeight)
        found.push({
          text: line.textContent,
          line: lineHeight,
          words: wordsHeight,
        });
    }
    return found;
  });
  expect(cut).toEqual([]);
});

/**
 * Once the block's own scrolling settled, the person scrolls it to the top while the word
 * plays further down: it stays exactly there while the words go on for 5 s (FR-4), then
 * follows the word again. Sampled on every frame, so nothing waits for a fixed time.
 */
async function expectHeldThenFollowed(region: Locator): Promise<void> {
  const samples = await region.evaluate(async (block, ownMs) => {
    interface Registry {
      get(name: string): Iterable<Range> | undefined;
    }
    const registry = (CSS as unknown as { highlights: Registry }).highlights;
    const frame = () =>
      new Promise((resolve) => requestAnimationFrame(resolve));
    // The block's smooth scroll to the word is over: 10 frames in the same place.
    let still = 0;
    let last = block.scrollTop;
    while (still < 10) {
      await frame();
      still = block.scrollTop === last ? still + 1 : 0;
      last = block.scrollTop;
    }
    block.dispatchEvent(new WheelEvent('wheel', { deltaY: -1_000 }));
    block.scrollTop = 0;
    const from = performance.now();
    const seen: { ms: number; top: number; word: string | null }[] = [];
    while (performance.now() - from < ownMs + 5_000) {
      await frame();
      const [range] = Array.from(registry.get('track-word') ?? []);
      const ms = performance.now() - from;
      seen.push({ ms, top: block.scrollTop, word: range?.toString() ?? null });
      if (ms > ownMs && block.scrollTop > 100) break;
    }
    return seen;
  }, 5_000);
  const held = samples.filter(({ ms }) => ms < 5_000);
  const words = new Set(held.map(({ word }) => word));
  // Following would have moved it hundreds of pixels on any of these words.
  expect(words.size).toBeGreaterThanOrEqual(3);
  expect(held.filter(({ top }) => top !== 0)).toEqual([]);
  const back = samples.find(({ top }) => top > 100);
  expect(back?.ms ?? 0).toBeGreaterThanOrEqual(5_000);
}

test('AC-14: on a phone a long text with a huge word fits, with no sideways scroll', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openStep2(page, lecture, { transcribe: 'done' });
  await textButton(page, 2).click();
  const region = textOf(page, 2);
  await expect(region).toContainText('Pneumoultra');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const box = await region.boundingBox();
  expect(box?.height ?? 0).toBeLessThanOrEqual(844 * 0.4 + 1);
  expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= 390).toBe(
    true,
  );
  const buttons = await textButton(page, 2).boundingBox();
  expect(buttons?.height ?? 0).toBeGreaterThanOrEqual(44);
  await saveEvidence(page, `${testInfo.project.name}-step2-phone`);
});

for (const theme of ['light', 'dark', 'esoteric'] as const)
  test(`AC-16: the word has underline and weight, with contrast and no motion, in the ${theme} theme`, async ({
    page,
  }, testInfo) => {
    await useTheme(page, theme);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openStep2(page, lecture, { transcribe: 'done' });
    await page.getByRole('button', { name: 'Ouvir a faixa 2' }).click();
    const region = textOf(page, 2);
    expect(await paintedFrom(page, 40.3, ['está', 'em'])).toEqual([
      'está',
      'em',
    ]);
    const look = await region
      .locator('.line')
      .nth(1)
      .evaluate((line) => {
        const style = getComputedStyle(line, '::highlight(track-word)');
        const opaque = (value: string) => {
          const canvas = document.createElement('canvas').getContext('2d');
          if (!canvas) throw new Error('no canvas');
          canvas.fillStyle = value;
          canvas.fillRect(0, 0, 1, 1);
          return Array.from(canvas.getImageData(0, 0, 1, 1).data).slice(0, 3);
        };
        const root = getComputedStyle(line);
        const block = line.parentElement as HTMLElement;
        return {
          line: style.textDecorationLine,
          thickness: style.textDecorationThickness,
          shadow: style.textShadow,
          transition: root.transitionDuration,
          scroll: getComputedStyle(block).scrollBehavior,
          text: opaque(root.getPropertyValue('--color-text')),
          underline: opaque(root.getPropertyValue('--color-accent-strong')),
          background: opaque(getComputedStyle(block).backgroundColor),
        };
      });
    if (testInfo.project.name !== 'media-webkit') {
      expect(look.line).toContain('underline');
      expect(look.thickness).toBe('3px');
      expect(look.shadow).not.toBe('none');
    }
    // The app's reduced-motion rule leaves at most 0.01 ms.
    expect(Number.parseFloat(look.transition)).toBeLessThanOrEqual(0.00001);
    expect(look.scroll).not.toBe('smooth');
    expect(contrast(look.text, look.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(look.underline, look.background)).toBeGreaterThanOrEqual(3);
    const violations = (
      await new AxeBuilder({ page }).include('app-preparation-tracks').analyze()
    ).violations.filter((violation) =>
      ['serious', 'critical'].includes(violation.impact ?? ''),
    );
    expect(violations).toEqual([]);
    await saveEvidence(page, `${testInfo.project.name}-step2-${theme}`);
  });

test('AC-17: the marked word differs from the spoken one by at most 120 ms, one write per word at most', async ({
  page,
}) => {
  await openStep2(page, lecture, { transcribe: 'done' });
  await page.getByRole('button', { name: 'Ouvir a faixa 2' }).click();
  await playingAt(page, LONG_LINE_AT - 0.4);
  await expect
    .poll(async () => (await auditionState(page)).time)
    .toBeGreaterThan(LONG_LINE_AT + 0.5);
  const { samples, delaysMs, changes, writes, skipped } = await page.evaluate(
    async ({ startMs, stepMs, words }) => {
      interface Registry {
        get(name: string): Iterable<Range> | undefined;
      }
      const registry = (CSS as unknown as { highlights: Registry }).highlights;
      const audio = document.querySelector<HTMLAudioElement>(
        'audio[hidden]:not([data-media-engine])',
      );
      const block = document.querySelector('app-track-text');
      let writes = 0;
      const observer = new MutationObserver((records) => {
        writes += records.length;
      });
      if (block)
        observer.observe(block, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      const delays: number[] = [];
      let samples = 0;
      let changes = 0;
      let last: string | null = null;
      const skipped = { frozen: 0, stalled: 0, outside: 0 };
      const endMs = startMs + words * stepMs;
      // Every frame until the line's last word is spoken or the audio stops, not a fixed time.
      const until = performance.now() + 20_000;
      let previous = performance.now();
      let previousTime = audio?.currentTime ?? 0;
      while (
        performance.now() < until &&
        audio &&
        !audio.paused &&
        audio.currentTime * 1000 < endMs
      ) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const frameAt = performance.now();
        // A frame after the page itself froze (a loaded machine), or with the audio waiting
        // for data, shows nothing about the highlight: those are not samples. readyState
        // alone cannot say the audio waits: after a seek while playing, Linux WebKit stays
        // at 2 while currentTime runs normally (as in media-transcript's NFR-1).
        const frozen = frameAt - previous > 100;
        const stalled =
          audio.readyState < 3 && audio.currentTime <= previousTime;
        previous = frameAt;
        previousTime = audio.currentTime;
        skipped.frozen += Number(frozen);
        skipped.stalled += Number(stalled);
        if (frozen || stalled || audio.paused) continue;
        const nowMs = audio.currentTime * 1000;
        const spoken = Math.floor((nowMs - startMs) / stepMs);
        if (spoken < 0 || spoken >= words) {
          skipped.outside++;
          continue;
        }
        const [range] = Array.from(registry.get('track-word') ?? []);
        const text = range?.toString() ?? null;
        if (text !== last) changes++;
        last = text;
        const shown = Number(text?.replace('termo', '') ?? -1);
        samples++;
        if (shown === spoken) continue;
        const startOf = (word: number) => startMs + word * stepMs;
        delays.push(
          shown < spoken ? nowMs - startOf(spoken) : startOf(shown) - nowMs,
        );
      }
      observer.disconnect();
      return { samples, delaysMs: delays, changes, writes, skipped };
    },
    { startMs: LONG_LINE_AT * 1000, stepMs: 300, words: WORD_COUNT },
  );
  expect(
    samples,
    `frames skipped: ${JSON.stringify(skipped)}`,
  ).toBeGreaterThanOrEqual(100);
  const worst = Math.max(0, ...delaysMs);
  process.stdout.write(
    `KBC-092 NFR-1: worst ${Math.round(worst)} ms over ${samples} samples; ${writes} DOM writes for ${changes} word changes\n`,
  );
  expect(worst).toBeLessThanOrEqual(120);
  expect(changes).toBeGreaterThan(10);
  expect(writes).toBeLessThanOrEqual(changes);
});

test('NFR-3, AC-13: on a 60 min track the text shows within 300 ms, the highlight costs at most 2 ms per frame, and the block follows the word inside itself', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'media-desktop',
    'Measured once, on the desktop notebook profile',
  );
  test.setTimeout(420_000);
  const owner = await ownerApi();
  const long = await uploadReady(owner, {
    title: `Faixa de 60 min ${uniqueTag()}`,
    seconds: 3_600,
    bitrate: '32k',
    readyWithinMs: 300_000,
  });
  const lines = Array.from({ length: 600 }, (_, i) => ({
    at: i * 6,
    text: `Trecho ${i} fala do assunto ${i} com palavras comuns ${i}.`,
  }));
  await seedTranscript(owner, { id: long.id, raw: rawOf(lines) });
  await owner.dispose();
  await openStep2(page, long, {
    transcribe: 'done',
    tracks: [{ startMs: 0, endMs: 3_600_000, title: 'A palestra inteira' }],
  });
  await page.evaluate(() => {
    const seen = new MutationObserver(() => {
      if (document.querySelector('app-track-text .line')) {
        (window as unknown as { firstLineAt: number }).firstLineAt =
          performance.now();
        seen.disconnect();
      }
    });
    seen.observe(document.body, { childList: true, subtree: true });
  });
  await textButton(page, 1).click();
  await expect(textOf(page, 1).locator('.line').first()).toBeVisible();
  const shownMs = await page.evaluate(() => {
    const [entry] = performance
      .getEntriesByType('resource')
      .filter((one) =>
        /\/transcript\?/.test(one.name),
      ) as PerformanceResourceTiming[];
    const at = (window as unknown as { firstLineAt: number }).firstLineAt;
    return at - (entry?.responseEnd ?? at);
  });
  await expect(textOf(page, 1).locator('.line')).toHaveCount(600);
  await page.getByRole('button', { name: 'Ouvir a faixa 1' }).click();
  await expect.poll(async () => (await auditionState(page)).paused).toBe(false);
  const throttle = Number(process.env['KBC_E2E_CPU_THROTTLE'] ?? '1');
  if (throttle > 1)
    await (
      await page.context().newCDPSession(page)
    ).send('Emulation.setCPUThrottlingRate', { rate: throttle });
  const open = await frameCost(page);
  await textButton(page, 1).click();
  await expect(textOf(page, 1)).toHaveCount(0);
  const closed = await frameCost(page);
  const extraMs = open.busyMsPerFrame - closed.busyMsPerFrame;
  const report = `CPU x${throttle}: first lines ${Math.round(shownMs)} ms after the transcript; open ${JSON.stringify(open)}, closed ${JSON.stringify(closed)}, extra ${extraMs.toFixed(2)} ms per frame`;
  process.stdout.write(`KBC-092 NFR-3: ${report}\n`);
  testInfo.annotations.push({ type: 'frame cost', description: report });
  expect(shownMs).toBeLessThanOrEqual(300);
  expect(open.frames).toBeGreaterThan(120);
  if (!process.env['CI']) expect(extraMs).toBeLessThanOrEqual(2);

  // AC-13 on the 60 min track: a jump to its middle is followed inside the block, never
  // by the page, and the person's own scroll holds it for 5 s.
  await textButton(page, 1).click();
  const region = textOf(page, 1);
  await expect(region.locator('.line')).toHaveCount(600);
  const pageAt = await page.evaluate(() => window.scrollY);
  await playingAt(page, 1_800);
  await expect.poll(() => wordInBlock(region), { timeout: 10_000 }).toBe(true);
  expect(await page.evaluate(() => window.scrollY)).toBe(pageAt);
  await expectHeldThenFollowed(region);
  expect(await page.evaluate(() => window.scrollY)).toBe(pageAt);
});

/** The painted word lies inside the block's visible box. */
const wordInBlock = (region: Locator) =>
  region.evaluate((block) => {
    interface Registry {
      get(name: string): Iterable<Range> | undefined;
    }
    const registry = (CSS as unknown as { highlights: Registry }).highlights;
    const [range] = Array.from(registry.get('track-word') ?? []);
    if (!range) return false;
    const word = range.getBoundingClientRect();
    const box = block.getBoundingClientRect();
    return word.top >= box.top && word.bottom <= box.bottom;
  });

interface FrameCost {
  readonly frames: number;
  readonly busyMsPerFrame: number;
  readonly layouts: number;
}

interface TraceEvent {
  readonly name: string;
  readonly ph: string;
  readonly tid: number;
  readonly dur?: number;
}

/** The main thread's work per animation frame in 6 s of playback, from a Chrome trace. */
async function frameCost(page: Page): Promise<FrameCost> {
  const browser = page.context().browser();
  if (!browser) throw new Error('no browser');
  await browser.startTracing(page, {
    categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'],
  });
  await page.evaluate(
    () => new Promise((resolve) => setTimeout(resolve, 6_000)),
  );
  const trace = JSON.parse((await browser.stopTracing()).toString()) as {
    traceEvents: TraceEvent[];
  };
  const frames = trace.traceEvents.filter(
    (event) => event.name === 'FireAnimationFrame',
  );
  const counts = new Map<number, number>();
  for (const { tid } of frames) counts.set(tid, (counts.get(tid) ?? 0) + 1);
  const [main] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const onMain = trace.traceEvents.filter((event) => event.tid === main?.[0]);
  const busyUs = onMain
    .filter((event) => event.name === 'RunTask' && event.ph === 'X')
    .reduce((sum, event) => sum + (event.dur ?? 0), 0);
  const frameCount = main?.[1] ?? 0;
  return {
    frames: frameCount,
    busyMsPerFrame: Number(
      (busyUs / 1000 / Math.max(1, frameCount)).toFixed(2),
    ),
    layouts: onMain.filter((event) => event.name === 'Layout').length,
  };
}

const luminance = (rgb: readonly number[]): number => {
  const [r = 0, g = 0, b = 0] = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

function contrast(a: readonly number[], b: readonly number[]): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

/** Local validation: screenshots when KBC_EVIDENCE_DIR is set. */
async function saveEvidence(page: Page, name: string): Promise<void> {
  const dir = process.env['KBC_EVIDENCE_DIR'];
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
}
