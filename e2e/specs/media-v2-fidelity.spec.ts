import type { APIRequestContext, Page } from '@playwright/test';
import { CSRF, expect, ownerApi, test } from './fixtures.js';
import {
  audioState,
  uniqueTag,
  uploadReady,
  type UploadedMedia,
} from './media-helpers.js';
import {
  expectKeyboardScrolls,
  expectScrolls,
  shortWindow,
} from './scroll-helpers.js';
import { desktop } from './shell-helpers.js';
import { rawOf, seedTranscript } from './transcript-helpers.js';
import { expectInsideViewport } from './v2-media-helpers.js';

/**
 * KBC-129 (v2 · Mídia — Player, Fila e Marcadores, as the frames draw them): the player
 * page, "Meus marcadores" and the Fila used for real at 1440 and 390 — long text scrolls
 * with the wheel, a finger and the keyboard, and every visible control does its job.
 */

let lecture: UploadedMedia;

/** Forty lines, one every 3 s: more text than any screen holds. */
const LINES = Array.from({ length: 40 }, (_, index) => ({
  at: index * 3,
  text: `Linha ${index + 1} da aula sobre o princípio de correspondência e o que está em cima`,
}));

// One worker per project runs this file: its media are made once in `beforeAll`.
test.describe.configure({ mode: 'default' });

test.beforeAll(async () => {
  const owner = await ownerApi();
  lecture = await uploadReady(owner, {
    title: `Aula fiel ${uniqueTag()}`,
    seconds: 120,
  });
  await seedTranscript(owner, { id: lecture.id, raw: rawOf(LINES) });
  await owner.dispose();
});

/** The owner's bookmarks on the lecture, made through the API (the person's own). */
async function bookmark(
  owner: APIRequestContext,
  positionMs: number,
  note?: string,
): Promise<void> {
  const made = await owner.post(`/api/v1/media/${lecture.id}/bookmarks`, {
    data: { id: crypto.randomUUID(), positionMs, ...(note ? { note } : {}) },
    headers: CSRF,
  });
  expect(made.status(), await made.text()).toBeLessThan(300);
}

async function openPlayer(page: Page): Promise<void> {
  await page.goto(`/midia/${lecture.id}`);
  await expect(
    page.getByRole('heading', { name: lecture.title, level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Tocar', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole('list', { name: 'Trechos da transcrição' }),
  ).toBeVisible();
}

test('the player page scrolls its transcript and itself with the wheel, a finger and the keys', async ({
  page,
}) => {
  await shortWindow(page);
  await openPlayer(page);
  const transcript = page.getByRole('list', { name: 'Trechos da transcrição' });
  if (desktop(page)) {
    // A short window: the page scrolls under the header, with the wheel and the keys.
    await expectScrolls(page, page.getByRole('main'));
    await expectKeyboardScrolls(
      page,
      page.getByRole('heading', { name: lecture.title, level: 1 }),
    );
    // A whole one: the transcript scrolls in its own column.
    await page.setViewportSize({ width: 1440, height: 900 });
    await transcript.scrollIntoViewIfNeeded();
    await expectScrolls(page, transcript);
    return;
  }
  // The full-screen player scrolls under a finger down to the transcript card.
  await expectScrolls(page, page.getByRole('main'));
  const expand = page.getByRole('button', {
    name: 'Mostrar a transcrição inteira',
  });
  await expand.scrollIntoViewIfNeeded();
  const before = (await transcript.boundingBox())?.height ?? 0;
  await expand.click();
  await expect(
    page.getByRole('button', { name: 'Mostrar menos da transcrição' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(async () => (await transcript.boundingBox())?.height ?? 0)
    .toBeGreaterThan(before + 100);
  // The whole transcript, its top at the top of the screen: the finger moves over its text.
  await transcript.evaluate((list) => list.scrollIntoView({ block: 'start' }));
  await expectScrolls(page, transcript);
});

test('the player controls work: play, skips, speed, mark with a note, search, views and ⋯', async ({
  page,
}) => {
  await openPlayer(page);
  // Play and pause, for real.
  await page.getByRole('button', { name: 'Tocar', exact: true }).click();
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeGreaterThan(0.3);
  await page.getByRole('button', { name: 'Pausar', exact: true }).click();
  await expect.poll(async () => (await audioState(page)).paused).toBe(true);

  // +30 and −15.
  const at = (await audioState(page)).currentTime;
  await page.getByRole('button', { name: 'Avançar 30 segundos' }).click();
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeGreaterThan(at + 20);
  const later = (await audioState(page)).currentTime;
  await page.getByRole('button', { name: 'Voltar 15 segundos' }).click();
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeLessThan(later - 10);

  // The speed pill opens its menu (a sheet on a phone), whole on screen, and sets 1,5×.
  await page
    .getByRole('button', { name: /Velocidade/ })
    .first()
    .click();
  const speeds = page.getByRole('menu');
  await expect(speeds).toBeVisible();
  await expectInsideViewport(page, speeds);
  await speeds.getByRole('menuitemradio', { name: /1,5/ }).click();
  await expect(speeds).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /Velocidade/ }).first(),
  ).toHaveAccessibleName(/1,5/);

  // Mark: the note opens beside 🔖 (a sheet on a phone), saves, and the list says so.
  await page.getByRole('button', { name: 'Marcar este trecho' }).click();
  const note = page.getByRole('textbox', { name: /^Nota do marcador em/ });
  await expect(note).toBeFocused();
  await expectInsideViewport(page, note);
  const words = `nota ${uniqueTag()}`;
  await note.fill(words);
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(note).toHaveCount(0);
  await expect(page.getByText(words).first()).toBeAttached();

  // ⋯ opens whole on screen, Escape closes it and gives the focus back.
  const more = page.getByRole('button', { name: 'Mais opções' });
  await more.click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem').first()).toBeVisible();
  await expectInsideViewport(page, menu);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();

  if (desktop(page)) {
    // Search in the transcript: the pill finds the line.
    const search = page.getByRole('searchbox', {
      name: 'Buscar na transcrição',
    });
    await search.fill('Linha 33');
    await expect(
      page.getByRole('status').filter({ hasText: /1 de/ }),
    ).toBeVisible();
    await search.fill('');
    // The views: Vozes and back to Transcrição.
    await page.getByRole('button', { name: 'Vozes', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Vozes', level: 3 }).first(),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Transcrição', exact: true })
      .click();
    await expect(
      page.getByRole('list', { name: 'Trechos da transcrição' }),
    ).toBeVisible();
    // "Sobre" closes with its ✕.
    const about = page.getByRole('button', {
      name: 'Fechar Sobre este áudio',
    });
    await about.click();
    await expect(about).toHaveCount(0);
  } else {
    // The phone's views wait in ⋯: "Ver vozes" opens them, the chip comes back.
    await more.click();
    await page.getByRole('menuitem', { name: 'Ver vozes' }).click();
    await expect(
      page.getByRole('heading', { name: 'Vozes', level: 3 }).first(),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Transcrição', exact: true })
      .click();
    await expect(
      page.getByRole('list', { name: 'Trechos da transcrição' }),
    ).toBeVisible();
    // The card's search opens a field that takes the focus.
    await page.getByRole('button', { name: 'Buscar na transcrição' }).click();
    await expect(
      page.getByRole('searchbox', { name: 'Buscar na transcrição' }),
    ).toBeFocused();
  }
});

test('"Meus marcadores" scrolls, plays the first, searches, orders and deletes from ⋯', async ({
  page,
}) => {
  const owner = await ownerApi();
  const tag = uniqueTag();
  for (let index = 0; index < 18; index += 1)
    await bookmark(owner, 2_000 + index * 5_000, `marca ${tag} ${index + 1}`);
  await owner.dispose();

  await shortWindow(page);
  await page.goto('/midia/marcadores');
  await expect(
    page.getByRole('heading', { name: 'Meus marcadores' }),
  ).toBeVisible();
  await expect(page.getByText(`marca ${tag} 18`)).toBeVisible();
  await expectScrolls(page, page.getByRole('main'));
  await expectKeyboardScrolls(
    page,
    page.getByRole('heading', { name: 'Meus marcadores' }),
  );

  const rows = page.getByRole('main').getByRole('listitem');
  if (desktop(page)) {
    // The search finds one bookmark by its note.
    await page.getByRole('button', { name: 'Buscar nos marcadores' }).click();
    const field = page.getByRole('searchbox', {
      name: 'Buscar nos marcadores',
    });
    await expect(field).toBeFocused();
    await field.fill(`marca ${tag} 7`);
    await expect(rows).toHaveCount(1);
    await field.press('Escape');
    // The order: "Por áudio" checked in its menu.
    await page.getByRole('button', { name: /^Ordenar marcadores/ }).click();
    await page.getByRole('menuitemradio', { name: 'Por áudio' }).click();
    await expect(
      page.getByRole('button', { name: /^Ordenar marcadores/ }),
    ).toHaveAccessibleName(/Por áudio/);
  }

  // ⋯ of a row deletes that bookmark (by its note: other projects add bookmarks too).
  const first = rows.filter({ hasText: `marca ${tag} ` }).first();
  const gone = (await first.getByRole('paragraph').textContent())?.trim() ?? '';
  expect(gone).toMatch(new RegExp(`^marca ${tag} `));
  await first.getByRole('button', { name: /^Mais opções do marcador/ }).click();
  const menu = page.getByRole('menu');
  await expectInsideViewport(page, menu);
  await menu.getByRole('menuitem', { name: 'Apagar marcador' }).click();
  await expect(page.getByText(gone, { exact: true })).toHaveCount(0);

  // The green play opens the first one, playing from its time.
  await page.getByRole('button', { name: /^Tocar .* de \d+:\d\d$/ }).click();
  await expect(page).toHaveURL(new RegExp(`/midia/[0-9a-f-]{36}$`));
  await expect.poll(async () => (await audioState(page)).paused).toBe(false);
});

test('the Fila scrolls and leads to the library', async ({ page }) => {
  const width = page.viewportSize()?.width ?? 1440;
  await page.setViewportSize({ width, height: 420 });
  await page.goto('/fila');
  await expect(
    page.getByRole('heading', { name: 'Fila de processamento' }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('heading', { name: /Precisa de você|A seguir/ })
      .or(page.getByText('Nada sendo processado agora.'))
      .first(),
  ).toBeVisible();
  await expectScrolls(page, page.getByRole('main'));
  // ‹ on a phone, "Ir para a Biblioteca" when it is empty, the item's link otherwise.
  if (!desktop(page)) {
    await page.getByRole('link', { name: '← Biblioteca' }).click();
    await expect(page).toHaveURL(/\/biblioteca$/);
  }
});
