import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, ownerApi } from './fixtures.js';
import {
  audioState,
  listenerTest as test,
  uniqueTag,
  uploadReady,
  useTheme,
  type UploadedMedia,
} from './media-helpers.js';
import { rawOf, seedTranscript } from './transcript-helpers.js';

// KBC-045: the spoken word highlighted in the transcript, and a click on a word.

const FIRST_LINE = 'o que está em cima';
const NO_TIMES = 'Este trecho veio sem tempos por palavra.';
const WORD_COUNT = 40;
/** 40 words 0.3 s apart from second 8: long enough to measure the delay. */
const LONG_LINE = Array.from(
  { length: WORD_COUNT },
  (_, i) => `termo${i}`,
).join(' ');
const LONG_LINE_AT = 8;
/** Past the first page of words (100 segments): its words load on demand. */
const FAR_LINE = 'esta frase fica bem longe do começo';

function lectureRaw() {
  const filler = Array.from({ length: 130 }, (_, i) => ({
    at: 21 + i,
    text: `Linha ${i} de enchimento ${i}.`,
  }));
  const raw = rawOf([
    { at: 2, text: FIRST_LINE },
    { at: 5, text: NO_TIMES },
    { at: LONG_LINE_AT, text: LONG_LINE },
    ...filler,
    { at: 160, text: FAR_LINE },
  ]);
  const [chunk] = raw.chunks;
  if (!chunk) throw new Error('no chunk');
  const segments = chunk.result.segments.map((segment) =>
    segment.text.trim() === NO_TIMES ? { ...segment, words: [] } : segment,
  );
  return { chunks: [{ ...chunk, result: { segments } }] };
}

let lecture: UploadedMedia;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  const owner = await ownerApi();
  lecture = await uploadReady(owner, {
    title: `Palavra a palavra ${uniqueTag()}`,
    seconds: 180,
    bitrate: '32k',
    readyWithinMs: 120_000,
  });
  await seedTranscript(owner, { id: lecture.id, raw: lectureRaw() });
  await owner.dispose();
});

async function openPlayer(page: Page, media: UploadedMedia) {
  await page.goto(`/midia/${media.id}`);
  await expect(page.getByRole('heading', { name: media.title })).toBeVisible();
  await expect(segmentsList(page)).toBeVisible();
}

const segmentsList = (page: Page) =>
  page.getByRole('list', { name: 'Trechos da transcrição' });

const activeSegment = (page: Page) =>
  segmentsList(page).locator('li:has([aria-current="true"])');

/** The word painted now (CSS Custom Highlight API); null with none. */
const spokenWord = (page: Page) =>
  page.evaluate(() => {
    type Registry = { get(name: string): Iterable<Range> | undefined };
    const registry = (CSS as unknown as { highlights: Registry }).highlights;
    const [range] = Array.from(registry.get('transcript-word') ?? []);
    return range?.toString() ?? null;
  });

/** Moves the paused audio, as a seek would. */
const moveAudioTo = (page: Page, seconds: number) =>
  page.locator('[data-media-engine]').evaluate((element, at) => {
    (element as HTMLMediaElement).currentTime = at;
  }, seconds);

/** The middle of a word on screen: words have no element to click. */
async function pointAtWord(page: Page, line: string, word: string) {
  const text = segmentsList(page).getByText(line);
  await text.scrollIntoViewIfNeeded();
  return text.evaluate((element, wanted) => {
    const node = element.firstChild;
    if (!(node instanceof Text)) throw new Error('no text node');
    const range = document.createRange();
    const start = node.data.indexOf(wanted);
    range.setStart(node, start);
    range.setEnd(node, start + wanted.length);
    const box = range.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }, word);
}

/** A tap on a phone, a click elsewhere: both must reach the word. */
async function pressWord(page: Page, line: string, word: string) {
  const { x, y } = await pointAtWord(page, line, word);
  const onPhone = (page.viewportSize()?.width ?? 0) < 600;
  if (onPhone) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

async function turnOffWordHighlight(page: Page) {
  await page.getByRole('button', { name: 'Mais opções' }).click();
  await page
    .getByRole('menuitem', { name: 'Destacar palavra a palavra: ligado' })
    .click();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const answer = await fetch('/api/v1/media/preferences');
        return ((await answer.json()) as { wordHighlight: boolean })
          .wordHighlight;
      }),
    )
    .toBe(false);
}

test('AC-1: "está" is marked between its start and that of "em"', async ({
  page,
}) => {
  await openPlayer(page, lecture);
  await moveAudioTo(page, 2.7);
  await expect.poll(() => spokenWord(page)).toBe('está');
  await moveAudioTo(page, 2.95);
  await expect.poll(() => spokenWord(page)).toBe('em');
  await expect(activeSegment(page)).toContainText(FIRST_LINE);
});

test('AC-2: a click on "cima" plays from the start of "cima"', async ({
  page,
}) => {
  await openPlayer(page, lecture);
  await moveAudioTo(page, 2.1);
  await expect.poll(() => spokenWord(page)).toBe('o');
  await pressWord(page, FIRST_LINE, 'cima');
  await expect(page.getByRole('button', { name: 'Pausar' })).toBeVisible();
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeGreaterThanOrEqual(3.2);
  expect((await audioState(page)).currentTime).toBeLessThan(5);
  expect((await audioState(page)).paused).toBe(false);
});

test('AC-2: a click on a word far ahead lands on it once its words arrive', async ({
  page,
}) => {
  const asked: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/transcript/words')) asked.push(request.url());
  });
  await openPlayer(page, lecture);
  await expect.poll(() => asked.length).toBeGreaterThan(0);
  expect(asked.every((url) => url.includes('from=0&'))).toBe(true);
  await pressWord(page, FAR_LINE, 'longe');
  await expect
    .poll(() => asked.some((url) => url.includes('from=100&')))
    .toBe(true);
  // "longe" is the fifth word, 0.3 s apart.
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeGreaterThanOrEqual(161.2);
  await expect.poll(() => spokenWord(page)).toMatch(/longe|do|começo/);
  expect((await audioState(page)).paused).toBe(false);
});

test('AC-3: with the option off only the segment is marked, and the account keeps it', async ({
  page,
}) => {
  await openPlayer(page, lecture);
  await moveAudioTo(page, 2.7);
  await expect.poll(() => spokenWord(page)).toBe('está');
  await turnOffWordHighlight(page);
  await expect.poll(() => spokenWord(page)).toBeNull();
  await expect(activeSegment(page)).toContainText(FIRST_LINE);
  await page.reload();
  await expect(segmentsList(page)).toBeVisible();
  await moveAudioTo(page, 2.7);
  await expect(activeSegment(page)).toContainText(FIRST_LINE);
  expect(await spokenWord(page)).toBeNull();
  await page.getByRole('button', { name: 'Mais opções' }).click();
  await expect(
    page.getByRole('menuitem', {
      name: 'Destacar palavra a palavra: desligado',
    }),
  ).toBeVisible();
});

test('AC-4: a segment without word times is marked whole, with no error', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openPlayer(page, lecture);
  await moveAudioTo(page, 2.7);
  await expect.poll(() => spokenWord(page)).toBe('está');
  await moveAudioTo(page, 6);
  await expect(activeSegment(page)).toContainText(NO_TIMES);
  await expect.poll(() => spokenWord(page)).toBeNull();
  expect(errors).toEqual([]);
});

test('AC-6: the words are no Tab stops', async ({ page }) => {
  await openPlayer(page, lecture);
  await expect.poll(() => spokenWord(page)).toBeNull();
  await moveAudioTo(page, 2.7);
  await expect.poll(() => spokenWord(page)).toBe('está');
  const list = segmentsList(page);
  await expect(list.locator('.text *')).toHaveCount(0);
  expect(
    await list
      .locator('a, button, [tabindex="0"]')
      .evaluateAll(
        (found) =>
          found.filter((element) => (element as HTMLElement).tabIndex === 0)
            .length,
      ),
  ).toBe(1);
  await list.getByRole('button', { name: /^0:02/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Pausar' })).toBeVisible();
  // Enter on a segment goes to its start, not to a word (FR-3).
  const reached = await audioState(page);
  expect(reached.currentTime).toBeLessThan(2.6);
});

for (const theme of ['light', 'dark', 'esoteric'] as const) {
  test(`AC-5: the spoken word has underline and weight, with contrast, in the ${theme} theme`, async ({
    page,
  }, testInfo) => {
    await useTheme(page, theme);
    await openPlayer(page, lecture);
    await moveAudioTo(page, 2.7);
    await expect.poll(() => spokenWord(page)).toBe('está');
    const colours = await activeSegment(page).evaluate((item) => {
      const style = getComputedStyle(item);
      const opaque = (value: string) => {
        const canvas = document.createElement('canvas').getContext('2d');
        if (!canvas) throw new Error('no canvas');
        canvas.fillStyle = value;
        canvas.fillRect(0, 0, 1, 1);
        return Array.from(canvas.getImageData(0, 0, 1, 1).data).slice(0, 3);
      };
      return {
        text: opaque(style.getPropertyValue('--color-text')),
        underline: opaque(style.getPropertyValue('--color-accent-strong')),
        background: opaque(style.backgroundColor),
      };
    });
    expect(contrast(colours.text, colours.background)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(
      contrast(colours.underline, colours.background),
    ).toBeGreaterThanOrEqual(3);
    const look = await page
      .locator('.segment.active .text')
      .evaluate((text) => {
        const style = getComputedStyle(text, '::highlight(transcript-word)');
        return {
          line: style.textDecorationLine,
          thickness: style.textDecorationThickness,
          shadow: style.textShadow,
          stroke: style.getPropertyValue('-webkit-text-stroke-width'),
        };
      });
    // WebKit does not report a highlight's style: the pixels below prove it there.
    if (testInfo.project.name !== 'media-webkit') {
      expect(look.line).toContain('underline');
      expect(look.thickness).toBe('3px');
      expect(look.shadow).not.toBe('none');
    }
    const violations = (
      await new AxeBuilder({ page }).include('app-transcript-panel').analyze()
    ).violations.filter((violation) =>
      ['serious', 'critical'].includes(violation.impact ?? ''),
    );
    expect(violations).toEqual([]);
    await saveEvidence(page, `${testInfo.project.name}-${theme}`);
    // The registry says what was asked, not what was drawn: the pixels must differ too.
    const text = page.locator('.segment.active .text');
    const marked = await text.screenshot();
    await turnOffWordHighlight(page);
    await expect.poll(() => spokenWord(page)).toBeNull();
    expect(marked.equals(await text.screenshot())).toBe(false);
  });
}

test('a search over the spoken word stays readable, with both painted', async ({
  page,
}, testInfo) => {
  await openPlayer(page, lecture);
  await moveAudioTo(page, 2.7);
  await expect.poll(() => spokenWord(page)).toBe('está');
  const field = page.getByLabel('Buscar na transcrição');
  await field.fill('está');
  // Also "esta frase", far ahead: the search ignores accents.
  await expect(page.locator('app-transcript-panel [role="status"]')).toHaveText(
    '1 de 2',
  );
  expect(await spokenWord(page)).toBe('está');
  await field.blur();
  await saveEvidence(page, `${testInfo.project.name}-search-over-word`);
});

test('NFR-1: the marked word differs from the spoken one by at most 120 ms', async ({
  page,
}) => {
  await openPlayer(page, lecture);
  await moveAudioTo(page, LONG_LINE_AT - 0.4);
  await page.getByRole('button', { name: 'Tocar', exact: true }).click();
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeGreaterThan(LONG_LINE_AT + 0.5);
  const { samples, delaysMs } = await page.evaluate(
    async ({ startMs, stepMs, words }) => {
      type Registry = { get(name: string): Iterable<Range> | undefined };
      const registry = (CSS as unknown as { highlights: Registry }).highlights;
      const audio = document.querySelector<HTMLMediaElement>(
        '[data-media-engine]',
      );
      const delays: number[] = [];
      let samples = 0;
      const until = performance.now() + 6_000;
      let previous = performance.now();
      while (performance.now() < until) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const frameAt = performance.now();
        const frozen = frameAt - previous > 100;
        previous = frameAt;
        if (frozen || !audio || audio.readyState < 3 || audio.paused) continue;
        const nowMs = audio.currentTime * 1000;
        const spoken = Math.floor((nowMs - startMs) / stepMs);
        if (spoken < 0 || spoken >= words) continue;
        const [range] = Array.from(registry.get('transcript-word') ?? []);
        const shown = Number(range?.toString().replace('termo', '') ?? -1);
        samples++;
        // How long the word now spoken has gone unmarked (or how early the next one came).
        if (shown === spoken) continue;
        const startOf = (word: number) => startMs + word * stepMs;
        delays.push(
          shown < spoken ? nowMs - startOf(spoken) : startOf(shown) - nowMs,
        );
      }
      return { samples, delaysMs: delays };
    },
    { startMs: LONG_LINE_AT * 1000, stepMs: 300, words: WORD_COUNT },
  );
  expect(samples).toBeGreaterThanOrEqual(120);
  const worst = Math.max(0, ...delaysMs);
  process.stdout.write(
    `KBC-045 NFR-1: worst ${Math.round(worst)} ms over ${samples} samples (${delaysMs.length} late)\n`,
  );
  expect(worst).toBeLessThanOrEqual(120);
});

test('NFR-2: on a 2 h transcript the highlight costs at most 2 ms per frame, with no layout', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'media-desktop',
    'Measured once, on the desktop notebook profile',
  );
  test.setTimeout(420_000);
  const owner = await ownerApi();
  const long = await uploadReady(owner, {
    title: `Palavras em 2 h ${uniqueTag()}`,
    seconds: 7_200,
    bitrate: '32k',
    readyWithinMs: 300_000,
  });
  const lines = Array.from({ length: 1_500 }, (_, i) => ({
    at: i * 4.8,
    text: `Trecho ${i} fala do assunto ${i} com palavras bastante comuns na leitura ${i}.`,
  }));
  await seedTranscript(owner, { id: long.id, raw: rawOf(lines) });
  await owner.dispose();
  await openPlayer(page, long);
  await expect(segmentsList(page).locator('li')).toHaveCount(1_500);
  await page.getByRole('button', { name: 'Tocar', exact: true }).click();
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeGreaterThan(0.5);
  // KBC_E2E_CPU_THROTTLE=4 slows the CPU like a modest laptop (Chromium only).
  const throttle = Number(process.env['KBC_E2E_CPU_THROTTLE'] ?? '1');
  if (throttle > 1)
    await (
      await page.context().newCDPSession(page)
    ).send('Emulation.setCPUThrottlingRate', { rate: throttle });
  const withWords = await frameCost(page);
  await turnOffWordHighlight(page);
  const withSegmentOnly = await frameCost(page);
  const extraMs = withWords.busyMsPerFrame - withSegmentOnly.busyMsPerFrame;
  const report = `CPU x${throttle}: words ${JSON.stringify(withWords)}, segment only ${JSON.stringify(withSegmentOnly)}, extra ${extraMs.toFixed(2)} ms per frame`;
  process.stdout.write(`KBC-045 NFR-2: ${report}\n`);
  testInfo.annotations.push({ type: 'frame cost', description: report });
  expect(withWords.frames).toBeGreaterThan(120);
  expect(withWords.layouts).toBeLessThanOrEqual(withSegmentOnly.layouts + 4);
  // On a shared CI runner this only goes to the log (noise above 2 ms says nothing).
  if (!process.env['CI']) expect(extraMs).toBeLessThanOrEqual(2);
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
  readonly pid: number;
  readonly dur?: number;
}

/** The main thread's work per animation frame in 8 s of playback, from a Chrome trace. */
async function frameCost(page: Page): Promise<FrameCost> {
  const browser = page.context().browser();
  if (!browser) throw new Error('no browser');
  await browser.startTracing(page, {
    categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'],
  });
  await page.evaluate(
    () => new Promise((resolve) => setTimeout(resolve, 8_000)),
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
  await page.screenshot({ path: join(dir, `${name}.png`) });
  await page.locator('.segment.active').screenshot({
    path: join(dir, `${name}-segment.png`),
  });
}
