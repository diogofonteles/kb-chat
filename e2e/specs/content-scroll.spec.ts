import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { startInSearchView, modeRadio } from './search-view.js';
import { desktop } from './shell-helpers.js';

/**
 * KBC-125 (owner's report on the v2 shell): every page that shows text scrolls it with the
 * wheel and the keyboard on desktop and with a touch on a phone. The shell is one screen
 * tall and its panels clip; the text must move inside them, at 1440 and 390.
 *
 * Each check scrolls over a region and asserts that the content under the pointer moved up
 * on screen, whatever element turns out to be the scroller.
 */

/**
 * A short window where the fixture's text would otherwise fit on one screen. A phone's v2
 * layout (the search pill, the floating question box) fits more text: it gets a shorter one.
 */
async function shortWindow(page: Page): Promise<void> {
  const width = page.viewportSize()?.width ?? 1440;
  await page.setViewportSize({ width, height: desktop(page) ? 560 : 480 });
}

/** The middle of the part of `region` that is on screen. */
async function middleOf(
  page: Page,
  region: Locator,
): Promise<{ x: number; y: number }> {
  const box = await region.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport) throw new Error('the region is not on screen');
  const top = Math.max(box.y, 0);
  const bottom = Math.min(box.y + box.height, viewport.height);
  return {
    x: Math.round(box.x + box.width / 2),
    y: Math.round((top + bottom) / 2),
  };
}

interface Probe {
  /** The top on screen of the element under the pointer: text that scrolls moves it. */
  readonly top: () => Promise<number>;
  /** The box around it with more text than fits is already scrolled to its end. */
  readonly atEnd: boolean;
}

/** More text than fits by at least this much is something to scroll. */
const OVERFLOW = 50;

/**
 * Marks the element under `point` and reads where the text around it stands, once the box
 * around it holds more than fits (the text may still be loading).
 */
async function probeAt(
  page: Page,
  point: { x: number; y: number },
): Promise<Probe> {
  const read = () =>
    page.evaluate(
      ({ x, y, overflow }) => {
        document
          .querySelectorAll('[data-scroll-probe]')
          .forEach((old) => old.removeAttribute('data-scroll-probe'));
        const element = document.elementFromPoint(x, y);
        element?.setAttribute('data-scroll-probe', '');
        let box = element;
        while (box && box.scrollHeight - box.clientHeight <= overflow)
          box = box.parentElement;
        if (!box || box === document.documentElement) return null;
        return box.scrollTop + box.clientHeight >= box.scrollHeight - overflow;
      },
      { ...point, overflow: OVERFLOW },
    );
  await expect
    .poll(read, {
      message: 'the text under the pointer fits: nothing to scroll',
    })
    .not.toBeNull();
  const atEnd = (await read()) ?? false;
  const probe = page.locator('[data-scroll-probe]');
  return {
    top: async () => (await probe.boundingBox())?.y ?? Number.NaN,
    atEnd,
  };
}

/** Scrolls by `dy` over `point` as the person would at this width (positive: down). */
async function scrollOver(
  page: Page,
  point: { x: number; y: number },
  dy: number,
): Promise<void> {
  if (desktop(page)) {
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, dy);
    return;
  }
  // A finger dragged over the text (Chromium's compositor gesture, as a real touch).
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.synthesizeScrollGesture', {
    x: point.x,
    y: point.y,
    yDistance: -dy,
    gestureSourceType: 'touch',
  });
  await cdp.detach();
}

/**
 * Scrolls down over `region` and expects the text to move up; text that opened already at
 * its end (a document scrolled to the highlighted term) must move back down instead.
 */
async function expectScrolls(page: Page, region: Locator): Promise<void> {
  await expect(region).toBeVisible();
  const point = await middleOf(page, region);
  const { top, atEnd } = await probeAt(page, point);
  const before = await top();
  await scrollOver(page, point, atEnd ? -400 : 400);
  if (atEnd) await expect.poll(top).toBeGreaterThan(before + OVERFLOW);
  else await expect.poll(top).toBeLessThan(before - OVERFLOW);
}

/** Desktop: a click on the text, then Page Down and Space (Page Up and ⇧Space at its end). */
async function expectKeyboardScrolls(page: Page, text: Locator): Promise<void> {
  if (!desktop(page)) return;
  await text.click();
  const point = await middleOf(page, text);
  const { top, atEnd } = await probeAt(page, point);
  const before = await top();
  await page.keyboard.press(atEnd ? 'PageUp' : 'PageDown');
  await page.keyboard.press(atEnd ? 'Shift+Space' : 'Space');
  if (atEnd) await expect.poll(top).toBeGreaterThan(before + OVERFLOW);
  else await expect.poll(top).toBeLessThan(before - OVERFLOW);
}

/**
 * The document panel once its text arrived and it brought the first highlighted term into
 * view (it scrolls itself then): scrolling before that would race it.
 */
async function openedDocument(page: Page): Promise<Locator> {
  const panel = page.getByRole('dialog');
  await expect(panel.getByRole('heading', { level: 2 })).toBeVisible();
  await expect(panel.getByText(/1 de \d+ ocorrências/)).toBeVisible();
  await expect(panel.locator('mark').first()).toBeInViewport();
  return panel;
}

async function searchFor(page: Page, question: string): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'Hermetismo',
  );
  // By meaning, the document opens on the question's terms highlighted (as in reading.spec).
  await (await modeRadio(page, 'Por significado')).check();
  await page.getByLabel('Sua pergunta').fill(question);
  await page.getByRole('button', { name: 'Buscar' }).click();
}

test.describe('search view', () => {
  test.beforeEach(startInSearchView);

  test('the search results scroll in the conversation', async ({ page }) => {
    await shortWindow(page);
    await searchFor(page, 'natureza setupla');
    await expect(
      page.getByRole('button', { name: /A Natureza Sétupla/ }).first(),
    ).toBeVisible();
    await expectScrolls(page, page.getByRole('region', { name: 'Conversa' }));
  });

  test('a document opened from the results scrolls in its panel', async ({
    page,
  }) => {
    await searchFor(page, 'natureza setupla');
    await page
      .getByRole('button', { name: /A Natureza Sétupla/ })
      .first()
      .click();
    const panel = await openedDocument(page);
    await expectScrolls(page, panel);
    await expectKeyboardScrolls(page, panel.getByRole('heading', { level: 2 }));
  });
});

test.describe('research view', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  test('the AI answer scrolls in the conversation and its source in the panel', async ({
    page,
  }) => {
    await shortWindow(page);
    await page.getByLabel('Sua pergunta').fill('natureza sétupla');
    await page.getByRole('button', { name: 'Perguntar' }).click();
    const answer = page.locator('app-research-message').last();
    await expect(answer.getByText(/Resposta gerada por IA/)).toBeVisible();
    await expectScrolls(page, page.getByRole('region', { name: 'Conversa' }));

    await answer
      .getByRole('link', { name: /^Fonte \d+:/ })
      .first()
      .click();
    const panel = await openedDocument(page);
    await expectScrolls(page, panel);
  });
});

test.describe('pages in the main panel', () => {
  test('Configurações scrolls', async ({ page }) => {
    await page.goto('/configuracoes');
    await expect(
      page.getByRole('heading', { name: 'Configurações', level: 1 }),
    ).toBeVisible();
    await expectScrolls(page, page.getByRole('main'));
    await expectKeyboardScrolls(
      page,
      page.getByRole('heading', { name: 'Configurações', level: 1 }),
    );
  });

  test('Biblioteca scrolls', async ({ page }) => {
    await shortWindow(page);
    await page.goto('/biblioteca');
    await expect(
      page.getByRole('heading', { name: 'Biblioteca', level: 2 }),
    ).toBeVisible();
    await expectScrolls(page, page.getByRole('main'));
  });

  test('the component catalog scrolls', async ({ page }) => {
    await page.goto('/catalogo-ui');
    await expect(
      page.getByRole('heading', { name: 'Componentes', level: 1 }),
    ).toBeVisible();
    await expectScrolls(page, page.getByRole('main'));
  });
});
