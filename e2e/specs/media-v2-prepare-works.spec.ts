import type { Locator, Page } from '@playwright/test';
import { expect, ownerApi, test } from './fixtures.js';
import { aCollection, uniqueTag, uploadReady } from './media-helpers.js';
import { approve, audioWithTracks, trackRow } from './tracks-helpers.js';

/**
 * KBC-130 (v2 fidelity): the guided flow does not only look like the frames, it works. On
 * "Preparar áudio" (steps 1 and 2), "Faixas" (steps 3 and 4) and "/limites", at the
 * project's width and, in WebKit, at 1440 and 390 too: the page scrolls with the wheel (a
 * finger on a phone) and the keyboard, every control on screen answers, fields take text
 * and menus open and close (owner's report, 2026-11-17: no text page could be scrolled).
 */

test.describe.configure({ mode: 'default' });

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/** The widths a test walks: the project's own; WebKit (Safari) walks both. */
function widthsFor(page: Page, browserName: string) {
  if (browserName !== 'webkit') return [page.viewportSize() ?? DESKTOP];
  return [DESKTOP, PHONE];
}

const isDesktop = (page: Page): boolean =>
  (page.viewportSize()?.width ?? 0) >= 1024;

/** A short window: the flow's pages hold more than one screen of it. */
async function shortWindow(page: Page): Promise<void> {
  const width = page.viewportSize()?.width ?? DESKTOP.width;
  await page.setViewportSize({ width, height: 560 });
}

/** The top of `target` on screen. */
async function topOf(target: Locator): Promise<number> {
  return (await target.boundingBox())?.y ?? Number.NaN;
}

/**
 * Scrolls down over `region` as the person would at this width: the wheel on a desktop or
 * in WebKit, a finger in Chromium on a phone (the compositor's touch gesture).
 */
async function scrollDown(
  page: Page,
  region: Locator,
  browserName: string,
): Promise<void> {
  const box = await region.boundingBox();
  if (!box) throw new Error('the region is not on screen');
  const viewport = page.viewportSize() ?? DESKTOP;
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(
    (Math.max(box.y, 0) + Math.min(box.y + box.height, viewport.height)) / 2,
  );
  if (isDesktop(page) || browserName !== 'chromium') {
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, 400);
    return;
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.synthesizeScrollGesture', {
    x,
    y,
    yDistance: -400,
    gestureSourceType: 'touch',
  });
  await cdp.detach();
}

/** The wheel (or the finger) moves `marker` up; then the keyboard moves it again. */
async function expectPageScrolls(
  page: Page,
  marker: Locator,
  browserName: string,
): Promise<void> {
  await expect(marker).toBeVisible();
  const host = page.locator(
    'app-preparation-page, app-track-editor-page, app-track-bounds-page',
  );
  const before = await topOf(marker);
  await scrollDown(page, host, browserName);
  await expect.poll(() => topOf(marker)).toBeLessThan(before - 40);
  // Back to the top, then Page Down from a click on the text (desktop keyboards).
  await host.evaluate((element) => element.scrollTo(0, 0));
  await expect.poll(() => topOf(marker)).toBeGreaterThan(before - 5);
  if (!isDesktop(page)) return;
  await marker.click();
  await page.keyboard.press('PageDown');
  await expect.poll(() => topOf(marker)).toBeLessThan(before - 40);
  await host.evaluate((element) => element.scrollTo(0, 0));
}

test('KBC-130: "Preparar áudio" scrolls, its switch, cards and buttons answer, and step 2 follows', async ({
  page,
  browserName,
}) => {
  const owner = await ownerApi();
  for (const size of widthsFor(page, browserName)) {
    await page.setViewportSize(size);
    const media = await uploadReady(owner, {
      title: `Aula ${uniqueTag()}`,
      seconds: 6,
    });
    await page.goto(`/midia/${media.id}/preparar`);
    const title = page.getByRole('heading', { name: media.title, level: 1 });
    await expect(title).toBeVisible();
    await shortWindow(page);
    await expectPageScrolls(page, title, browserName);

    // The free stage's switch turns off and on; the summary follows it.
    const speakers = page.getByRole('checkbox', {
      name: 'Indicar quem está falando',
    });
    await expect(speakers).toBeChecked();
    await speakers.click();
    await expect(speakers).not.toBeChecked();
    await speakers.click();
    await expect(speakers).toBeChecked();

    // The cards choose by a press anywhere on them; the chosen one shows its check.
    const manual = page.getByRole('radio', {
      name: 'Vou marcar as faixas eu mesmo',
    });
    await manual.click();
    await expect(manual).toBeChecked();
    await expect(
      page.getByText(/você valida as faixas/).first(),
    ).toBeAttached();
    await page.getByRole('radio', { name: 'Não dividir agora' }).click();
    await expect(
      page.getByRole('radio', { name: 'Não dividir agora' }),
    ).toBeChecked();

    // The way on stays in reach at the foot, and moves to step 2 by a press (FR-5).
    const prepare = page.getByRole('button', { name: 'Preparar', exact: true });
    await expect(prepare).toBeInViewport();
    await prepare.click();
    await expect(page.getByTestId('step-text')).toContainText(
      'Passo 2 de 4 · Processar',
    );
    const leave = page.getByRole('link', { name: 'Sair e continuar depois' });
    await expect(leave).toBeVisible();
    await leave.click();
    await expect(page).toHaveURL(new RegExp(`/midia/${media.id}$`));
  }
  await owner.dispose();
});

test('KBC-130: "Faixas" scrolls, a row edits in place, the ⋯ menu opens and closes, and the tools answer', async ({
  page,
  browserName,
}) => {
  const owner = await ownerApi();
  for (const size of widthsFor(page, browserName)) {
    await page.setViewportSize(size);
    const media = await audioWithTracks(owner);
    await page.goto(`/midia/${media.id}/faixas`);
    const title = page.getByRole('heading', { name: media.title, level: 1 });
    await expect(title).toBeVisible();
    await shortWindow(page);
    await expectPageScrolls(page, title, browserName);

    // A row selects by a press and its title takes text in place.
    await trackRow(page, 2).getByRole('button').first().click();
    const field = page.getByRole('textbox', { name: 'Título' });
    await expect(field).toHaveValue('Segunda pergunta');
    await field.fill('Quem levou o mestre');
    await field.press('Enter');
    await expect(trackRow(page, 2)).toContainText('Quem levou o mestre');

    // The ⋯ menu opens over everything, in the screen, and Escape closes it.
    const more = page.getByRole('button', { name: 'Mais ações da faixa' });
    await more.click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Apagar' })).toBeVisible();
    await expect(menu).toBeInViewport({ ratio: 1 });
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(more).toBeFocused();

    // The tools: zoom in and out, a new track at the cursor, undo and redo.
    await page.getByRole('button', { name: 'Aproximar' }).click();
    await page.getByRole('button', { name: 'Afastar' }).click();
    const undo = page.getByRole('button', { name: 'Desfazer', exact: true });
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect(trackRow(page, 2)).toContainText('Segunda pergunta');
    await page.getByRole('button', { name: 'Refazer' }).click();
    await expect(trackRow(page, 2)).toContainText('Quem levou o mestre');

    // On a phone the list and the transcript are two chips.
    if (!isDesktop(page)) {
      await page
        .getByRole('button', { name: 'Transcrição', exact: true })
        .click();
      await expect(
        page.getByRole('region', { name: 'Transcrição' }),
      ).toBeVisible();
      await page.getByRole('button', { name: '3 faixas' }).click();
    } else {
      await expect(
        page.getByRole('region', { name: 'Transcrição' }),
      ).toBeVisible();
    }

    // The approve bar stays at the foot, in reach.
    await expect(
      page.getByRole('button', { name: 'Aprovar faixas' }),
    ).toBeInViewport();
  }
  await owner.dispose();
});

test('KBC-130: step 4 scrolls, "Resumo" opens its field and "+ Assunto" opens the list', async ({
  page,
  browserName,
}) => {
  const owner = await ownerApi();
  for (const size of widthsFor(page, browserName)) {
    await page.setViewportSize(size);
    const media = await audioWithTracks(owner);
    await approve(owner, media.id);
    await page.goto(`/midia/${media.id}/faixas`);
    const heading = page.getByRole('heading', { name: '3 faixas aplicadas.' });
    await expect(heading).toBeVisible();
    await shortWindow(page);
    await expectPageScrolls(page, heading, browserName);

    const rows = page
      .getByRole('list', { name: 'Assuntos por faixa' })
      .getByRole('listitem');
    const first = rows.first();
    const summary = first.getByRole('button', { name: 'Resumo' });
    await expect(summary).toHaveAttribute('aria-expanded', 'false');
    await summary.click();
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
    const text = first.getByRole('textbox', { name: 'Resumo' });
    await text.fill('A chegada à sessão.');
    await expect(text).toHaveValue('A chegada à sessão.');
    await summary.click();
    await expect(text).toBeHidden();

    const add = first.getByRole('combobox', {
      name: /^Adicionar assunto à faixa/,
    });
    await add.click();
    await expect(add).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(add).toHaveAttribute('aria-expanded', 'false');

    // "Reabrir edição" and "Ver no player" are in reach.
    await expect(
      page.getByRole('button', { name: 'Reabrir edição' }),
    ).toBeInViewport();
    await page.getByRole('link', { name: 'Ver no player' }).click();
    await expect(page).toHaveURL(new RegExp(`/midia/${media.id}$`));
  }
  await owner.dispose();
});

test('KBC-130: "/limites" scrolls, the nudges move the start, "Desfazer" and "Cancelar" answer', async ({
  page,
  browserName,
}) => {
  const owner = await ownerApi();
  for (const size of widthsFor(page, browserName)) {
    await page.setViewportSize(size);
    const topic = await aCollection(owner);
    const media = await audioWithTracks(owner, undefined, topic);
    await approve(owner, media.id);
    await expect
      .poll(
        async () =>
          (
            (await (
              await owner.get(`/api/v1/media/${media.id}/edit`)
            ).json()) as { preparation: unknown }
          ).preparation,
        { timeout: 30_000 },
      )
      .toBeNull();
    const library = await owner.get(
      `/api/v1/media/library?topic=${encodeURIComponent(topic)}`,
    );
    const { items } = (await library.json()) as {
      readonly items: readonly {
        readonly id: string;
        readonly tracks: readonly { readonly id: string }[];
      }[];
    };
    const second = items.find((one) => one.id === media.id)?.tracks[1];
    if (!second) throw new Error('no track');

    await page.goto(`/midia/${second.id}/limites`);
    const title = page.getByText('Segunda pergunta', { exact: true }).first();
    await expect(title).toBeVisible();
    await shortWindow(page);
    await expectPageScrolls(page, title, browserName);

    const times = page.getByRole('paragraph').filter({ hasText: /^Início/ });
    await expect(times).toContainText('Início 0:15,0');
    await page.getByRole('button', { name: 'Mais 0,5 segundo' }).click();
    await expect(times).toContainText('Início 0:15,5');
    await expect(page.getByText('Não salvo')).toBeVisible();
    const save = page.getByRole('button', { name: 'Salvar limites' });
    await expect(save).toBeEnabled();
    await expect(save).toBeInViewport();
    await page.getByRole('button', { name: 'Menos 0,5 segundo' }).click();
    await expect(times).toContainText('Início 0:15,0');
    await page.getByRole('button', { name: 'Mais 0,5 segundo' }).click();
    await page.getByRole('button', { name: 'Desfazer' }).click();
    await expect(times).toContainText('Início 0:15,0');

    // "Ouvir o início" plays the start (the hidden audio element moves).
    await page.getByRole('button', { name: 'Ouvir o início' }).click();
    await expect
      .poll(() =>
        page
          .locator('app-track-bounds-page audio')
          .evaluate((audio: HTMLAudioElement) => audio.currentTime),
      )
      .toBeGreaterThan(14);

    await page.getByRole('link', { name: 'Cancelar' }).click();
    await expect(page).toHaveURL(new RegExp(`/midia/${second.id}$`));
  }
  await owner.dispose();
});
