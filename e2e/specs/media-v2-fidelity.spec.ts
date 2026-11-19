import type { APIRequestContext, Locator, Page } from '@playwright/test';
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

async function openPlayer(
  page: Page,
  media: UploadedMedia = lecture,
): Promise<void> {
  await page.goto(`/midia/${media.id}`);
  await expect(
    page.getByRole('heading', { name: media.title, level: 1 }),
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
    // The panel (Sobre | Fila | Ouvidas) closes with its ✕.
    const about = page.getByRole('button', {
      name: 'Fechar o painel',
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
    await page
      .getByRole('button', { name: 'Mostrar a busca na transcrição' })
      .click();
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

/** A menu or sheet shown whole: on screen, every item reached without scrolling inside it. */
async function expectWhole(page: Page, box: Locator): Promise<void> {
  await expectInsideViewport(page, box);
  const inner = await box.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(inner, 'no scrolling inside').toBeLessThanOrEqual(1);
  await expectInsideViewport(page, box.locator('[role^="menuitem"]').last());
}

test('the panel tabs, the queue button, the titled speed menu, ⋯ whole, the dialogs and the search say what they do', async ({
  page,
}) => {
  await openPlayer(page);

  // The transcript card scrolls under the finger on a phone, the list on a desktop.
  const transcript = page.getByRole('list', { name: 'Trechos da transcrição' });
  await transcript.scrollIntoViewIfNeeded();
  await expectScrolls(page, transcript);

  // Velocidade: its name over the choices, the current one checked.
  await page
    .getByRole('button', { name: /Velocidade/ })
    .first()
    .click();
  const speeds = page.getByRole('menu', { name: 'Velocidade' });
  await expect(speeds.getByText('Velocidade', { exact: true })).toBeVisible();
  // The one in use (the account's speed: an earlier test may have changed it), only it.
  await expect(
    speeds.locator('[role="menuitemradio"][aria-checked="true"]'),
  ).toHaveCount(1);
  await expectWhole(page, speeds);
  await page.keyboard.press('Escape');
  await expect(speeds).toHaveCount(0);

  // ⋯ whole on screen, its last item ("Atalhos de teclado") in view with no inner scroll.
  const more = page.getByRole('button', { name: 'Mais opções' });
  await more.click();
  const menu = page.getByRole('menu');
  await expect(
    menu.getByRole('menuitem', { name: /Atalhos de teclado/ }),
  ).toBeVisible();
  await expectWhole(page, menu);

  // Timer para dormir: ✕ and "Fechar"; a choice starts it and the moon turns green.
  await menu.getByRole('menuitem', { name: 'Timer para dormir' }).click();
  const sleep = page.getByRole('dialog', { name: 'Timer para dormir' });
  // ✕ and "Fechar" on a desktop; the phone's sheet shows neither (mOver), its ✕ stays for
  // assistive tech, out of sight until focused.
  await expect(sleep.getByRole('button', { name: 'Fechar' })).toHaveCount(
    desktop(page) ? 2 : 1,
  );
  if (!desktop(page)) {
    const hidden = sleep.getByRole('button', { name: 'Fechar' });
    expect((await hidden.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);
    // Reached with the keyboard, it shows.
    await tabTo(page, hidden);
    expect((await hidden.boundingBox())?.width ?? 0).toBeGreaterThan(20);
  }
  await expectInsideViewport(page, sleep);
  await sleep.getByRole('button', { name: 'No fim desta mídia' }).click();
  await expect(sleep).toBeHidden();
  const moon = page
    .locator('app-media-player')
    .getByRole('button', { name: 'Timer para dormir', exact: true });
  if (desktop(page)) {
    await expect(
      page.locator('app-media-player').getByRole('button', {
        name: 'Timer para dormir: no fim desta mídia',
      }),
    ).toHaveText(/Para no fim/);
  } else {
    // The phone keeps the moon in its row, green, and the chip in the row below.
    await expect(moon).toBeVisible();
    await expect(moon).toHaveClass(/\bon\b/);
  }

  // Atalhos de teclado: a switch, ✕ and "Fechar" (the phone's sheet: the scrim).
  await more.click();
  await page.getByRole('menuitem', { name: /Atalhos de teclado/ }).click();
  const keys = page.getByRole('dialog', { name: 'Atalhos de teclado' });
  const onOff = keys.getByRole('switch', { name: /Usar atalhos de uma tecla/ });
  await expect(onOff).toBeChecked();
  await onOff.click();
  await expect(onOff).not.toBeChecked();
  await onOff.click();
  await expect(onOff).toBeChecked();
  await expectInsideViewport(page, keys);
  if (desktop(page)) {
    await keys.getByRole('button', { name: 'Fechar' }).last().click();
  } else {
    // A tap on the scrim above the sheet closes it (the sheet has no "Fechar").
    await page.mouse.click(195, 24);
  }
  await expect(keys).toBeHidden();

  if (!desktop(page)) return;

  // Nothing found in the transcript is said in words under the search.
  const search = page.getByRole('searchbox', { name: 'Buscar na transcrição' });
  await search.fill('zzzz');
  await expect(
    page.getByText("Nenhum trecho com 'zzzz'.").first(),
  ).toBeVisible();
  await search.fill('');

  // The right panel's tabs: Sobre (the bookmarks), Fila (what plays, A seguir), Ouvidas.
  const tabs = page.getByRole('tablist', { name: 'Painel do player' });
  await expect(tabs.getByRole('tab')).toHaveText(['Sobre', 'Fila', 'Ouvidas']);
  await expect(tabs.getByRole('tab', { name: 'Sobre' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await tabs.getByRole('tab', { name: 'Fila' }).click();
  const panel = page.getByRole('tabpanel', { name: 'Fila' });
  await expect(
    panel.getByRole('heading', { name: 'Tocando agora' }),
  ).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'A seguir' })).toBeVisible();
  await expect(panel.getByText(lecture.title)).toBeVisible();
  // ← and → walk the tabs (APG).
  await page.keyboard.press('ArrowRight');
  await expect(
    page
      .getByRole('tabpanel', { name: 'Ouvidas' })
      .getByRole('heading', { name: 'Ouvidas recentemente' }),
  ).toBeVisible();

  // The bar's queue button: green on Fila, back to Sobre on this page.
  const bar = page.getByRole('region', { name: 'Mini-player' });
  const queue = bar.getByRole('button', { name: 'Fila', exact: true });
  await queue.click();
  await expect(queue).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('tab', { name: 'Fila' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await queue.click();
  await expect(queue).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('tab', { name: 'Sobre' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  // "Abrir o player" on its own page brings its head back.
  await bar.getByRole('link', { name: 'Abrir o player' }).click();
  await expect(
    page.getByRole('heading', { name: lecture.title, level: 1 }),
  ).toBeInViewport();
});

/** Tabs until `target` has the focus (a dozen stops at most). */
async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let step = 0; step < 12; step++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

/** The box of something on screen (it must be there). */
async function boxOf(
  target: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await target.boundingBox();
  if (!box) throw new Error('not on screen');
  return box;
}

test('where the frame puts things: menus over the action row, a smooth line, nothing marked before playing, a centred phone row, "Fechar o player" in ⋯', async ({
  page,
}) => {
  // A media of its own: never heard, one bookmark.
  const owner = await ownerApi();
  const fresh = await uploadReady(owner, {
    title: `Aula nova ${uniqueTag()}`,
    seconds: 120,
  });
  await seedTranscript(owner, { id: fresh.id, raw: rawOf(LINES) });
  const made = await owner.post(`/api/v1/media/${fresh.id}/bookmarks`, {
    data: { id: crypto.randomUUID(), positionMs: 12_000, note: 'onde' },
    headers: CSRF,
  });
  expect(made.status(), await made.text()).toBeLessThan(300);
  await owner.dispose();
  await openPlayer(page, fresh);
  const player = page.locator('app-media-player');
  const play = player.locator('.play');

  // Opened for the first time and not played: no line is the current one yet.
  await expect(
    page.locator('app-transcript-panel li.segment.active'),
  ).toHaveCount(0);

  // The line is smooth at rest; the bookmark shows on it once it is aimed at.
  const ticks = page.locator('app-seek-slider .mark:visible');
  await expect(ticks).toHaveCount(0);
  const slider = page
    .locator('app-seek-slider:visible')
    .getByRole('slider', { name: 'Posição' });
  await slider.focus();
  await expect(ticks).toHaveCount(1);
  await slider.blur();

  // A line's time plays from it, and marks it (the phone's card shows the lines only).
  if (desktop(page)) {
    await page
      .getByRole('list', { name: 'Trechos da transcrição' })
      .getByRole('button', { name: /0:12|12 segundos/ })
      .first()
      .click();
  } else {
    await play.click();
  }
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeGreaterThan(desktop(page) ? 11.5 : 0.2);
  await expect(
    page.locator('app-transcript-panel li.segment.active'),
  ).toHaveCount(1);
  await page.getByRole('button', { name: 'Pausar', exact: true }).click();

  if (desktop(page)) {
    const row = await boxOf(play);
    // The speed menu covers its pill from the row's top (speedMenu at y = the row).
    await page
      .getByRole('button', { name: /Velocidade/ })
      .first()
      .click();
    const speeds = await boxOf(page.getByRole('menu'));
    expect(Math.abs(speeds.y - row.y)).toBeLessThanOrEqual(2);
    await page.keyboard.press('Escape');
    // ⋯ from the row's top, 40 px left of its button, whole on screen.
    const more = page.getByRole('button', { name: 'Mais opções' });
    const trigger = await boxOf(more);
    await more.click();
    const menu = page.getByRole('menu');
    const box = await boxOf(menu);
    expect(Math.abs(box.x - (trigger.x - 40))).toBeLessThanOrEqual(2);
    expect(box.y).toBeLessThanOrEqual(row.y + 1);
    await expectInsideViewport(page, menu);
    await page.keyboard.press('Escape');
    // The note opens over the row too, 32 px left of 🔖.
    const mark = page.getByRole('button', { name: 'Marcar este trecho' });
    const markBox = await boxOf(mark);
    await mark.click();
    const note = page.locator('app-bookmark-note .note');
    const noteBox = await boxOf(note);
    expect(Math.abs(noteBox.y - row.y)).toBeLessThanOrEqual(2);
    expect(Math.abs(noteBox.x - (markBox.x - 32))).toBeLessThanOrEqual(2);
    await page.keyboard.press('Escape');
    // The player bar has no ✕ (lib.js playerBar).
    await expect(
      page
        .getByRole('region', { name: 'Mini-player' })
        .getByRole('button', { name: 'Fechar o player' }),
    ).toHaveCount(0);
  } else {
    // A timer on keeps ▶ in the middle of the phone's row (pMobile o.sleepOn).
    await page.getByRole('button', { name: 'Mais opções' }).click();
    await page.getByRole('menuitem', { name: 'Timer para dormir' }).click();
    await page
      .getByRole('dialog', { name: 'Timer para dormir' })
      .getByRole('button', { name: 'No fim desta mídia' })
      .click();
    await expect(player.locator('.sleep-face')).toBeVisible();
    const box = await boxOf(play);
    const width = page.viewportSize()?.width ?? 0;
    expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThanOrEqual(2);
  }

  // "Fechar o player" waits in ⋯ at both widths: it stops and the bar goes.
  await page.getByRole('button', { name: 'Mais opções' }).click();
  await page.getByRole('menuitem', { name: 'Fechar o player' }).click();
  await expect(page.getByRole('region', { name: 'Mini-player' })).toHaveCount(
    0,
  );
  expect(
    await page.locator('[data-media-engine]').getAttribute('src'),
  ).toBeNull();
});

/** The tops of a sheet's rows, in order. */
async function rowTops(rows: Locator): Promise<number[]> {
  return rows.evaluateAll((all) =>
    all.map((el) => Math.round(el.getBoundingClientRect().top)),
  );
}

/** Every row 4 below the one before (sheet(kids): gap 4), each 44 high at least. */
async function expectRowsFourApart(rows: Locator): Promise<void> {
  await expect(rows.nth(2)).toBeVisible();
  const tops = await rowTops(rows);
  const height = (await boxOf(rows.first())).height;
  expect(height).toBeGreaterThanOrEqual(44);
  expect(tops.length).toBeGreaterThan(2);
  for (let index = 1; index < tops.length; index += 1)
    expect(
      Math.abs((tops[index] ?? 0) - (tops[index - 1] ?? 0) - height - 4),
    ).toBeLessThanOrEqual(1);
}

test("the phone's rhythm: bookmarks under their count, sheets' rows 4 apart, the keys under their switch, a 56 mini player", async ({
  page,
}) => {
  test.skip(desktop(page), 'the phone frames (390)');
  const owner = await ownerApi();
  const tag = uniqueTag();
  await bookmark(owner, 7_000, `ritmo ${tag}`);
  await owner.dispose();

  // "Meus marcadores": the first row right under the count's row (12 below its ▶ 48).
  await page.goto('/midia/marcadores');
  await expect(page.getByText(`ritmo ${tag}`)).toBeVisible();
  const play = page.getByRole('button', { name: /^Tocar .* de \d+:\d\d$/ });
  const playBox = await boxOf(play);
  const first = await boxOf(
    page.getByRole('main').getByRole('listitem').first(),
  );
  expect(
    Math.abs(first.y - (playBox.y + playBox.height + 12)),
  ).toBeLessThanOrEqual(1);

  // The green ▶ opens the full-screen player, playing; paused, its sheets open.
  await play.click();
  await expect(page).toHaveURL(/\/midia\/[0-9a-f-]{36}$/);
  await expect.poll(async () => (await audioState(page)).paused).toBe(false);
  await page.getByRole('button', { name: 'Pausar', exact: true }).click();

  await page.getByRole('button', { name: 'Mais opções' }).click();
  const more = page.getByRole('menu');
  await expectRowsFourApart(more.locator('[role^="menuitem"]'));
  await expectWhole(page, more);
  await page.keyboard.press('Escape');
  await expect(more).toBeHidden();

  await page
    .getByRole('button', { name: /Velocidade/ })
    .first()
    .click();
  const speeds = page.getByRole('menu');
  await expectRowsFourApart(speeds.locator('[role^="menuitem"]'));
  await page.keyboard.press('Escape');
  await expect(speeds).toBeHidden();

  // Atalhos: the keys 12 under the switch's words (mOver 'keys').
  await page.getByRole('button', { name: 'Mais opções' }).click();
  await page.getByRole('menuitem', { name: /Atalhos de teclado/ }).click();
  const keys = page.getByRole('dialog', { name: 'Atalhos de teclado' });
  const words = await boxOf(keys.locator('.setting-name'));
  const firstKey = await boxOf(keys.locator('.row').first());
  expect(
    Math.abs(firstKey.y - (words.y + words.height + 12)),
  ).toBeLessThanOrEqual(1);
  await page.keyboard.press('Escape');
  await expect(keys).toBeHidden();

  // Playing again, ⌄ leaves for the library; the mini player is 56 high, ❚❚ 12 + 12 from
  // its edge.
  await page.getByRole('button', { name: 'Tocar', exact: true }).click();
  await expect.poll(async () => (await audioState(page)).paused).toBe(false);
  await page.getByRole('link', { name: /^← (Biblioteca|Mídia)$/ }).click();
  await expect(page).not.toHaveURL(/\/midia\/[0-9a-f-]{36}/);
  const mini = page.getByRole('region', { name: 'Mini-player' });
  await expect(mini).toBeVisible();
  const bar = await boxOf(mini);
  expect(Math.round(bar.height)).toBe(56);
  const toggle = await boxOf(
    mini.getByRole('button', { name: /^(Tocar|Pausar)$/ }),
  );
  expect(
    Math.abs(toggle.x + toggle.width / 2 - (bar.x + bar.width - 24)),
  ).toBeLessThanOrEqual(1);
  // A tap on the card still opens the full-screen player.
  await mini.click({ position: { x: 24, y: 24 } });
  await expect(page).toHaveURL(/\/midia\/[0-9a-f-]{36}/);
});

/**
 * Where the lecture stands in the AI research, as the API words a long state: waiting for a
 * Mac off since another day (the line then says the day), or kb's own failure (up to 200
 * characters, publication-status.ts).
 */
const LONG_PUBLICATIONS = [
  { state: 'waiting-mac', offSince: '2026-10-02T11:29:00.000Z' },
  {
    state: 'failed',
    since: '2026-11-18T10:00:00.000Z',
    reason:
      'kb publish: o índice do acervo hermetismo está bloqueado por outra escrita (database is locked) e o documento da faixa não pôde ser gravado no cofre; tente de novo quando o Mac terminar',
  },
] as const;

for (const publication of LONG_PUBLICATIONS)
  test(`the AI research line stays inside the page when it says more than the frame (${publication.state})`, async ({
    page,
  }) => {
    test.skip(!desktop(page), 'the desktop head keeps it beside the pill');
    await page.route('**/api/v1/media/*/publication', async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        json: { ...(await response.json()), publication },
      });
    });
    await openPlayer(page);
    const line = page
      .locator('app-media-player-page app-track-publication-status')
      .first()
      .getByRole('status');
    await expect(line).toContainText('Pesquisa com IA:');
    const panel = await boxOf(page.locator('app-media-player-page'));
    const words = line.locator('.words');
    const shown = await boxOf(words);
    // Inside the panel, its words whole: wrapped, not cut at the panel's edge.
    expect(shown.x).toBeGreaterThanOrEqual(panel.x);
    expect(shown.x + shown.width).toBeLessThanOrEqual(panel.x + panel.width);
    expect(
      await words.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await expect(words).toBeInViewport({ ratio: 1 });
  });
