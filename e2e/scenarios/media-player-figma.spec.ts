import type { Page } from '@playwright/test';
import { CSRF, expect, ownerApi, test } from '../specs/fixtures.js';
import {
  MEDIA,
  WIDTHS,
  contextAt,
  go,
  pauseAll,
  playInterview,
  saveDraft,
  seedPlayerWorld,
  shoot,
  shotsDone,
  type PlayerWorld,
} from './figma-player-world.js';

/**
 * The states of the v2 · Mídia — Player and Fila e Marcadores frames (media-player-*,
 * media-mini-player, media-bookmarks-*, media-queue-*) and of the track editor and the bounds
 * (media-tracks-*, media-bounds-*), at 1440×900 and 390×844, on the frames' own sample data
 * (figma-player-world.ts): the capture recipe of the Figma inventory check
 * (figma-recreation/tools/inventory/check.sh player). It only reaches each state and saves
 * it: the behaviour is proven by e2e/specs/media-*.spec.ts.
 *
 * A player frame opens its media's page and, where the frame draws ⏸, plays it there (the
 * interview at 0:22, the others from 0:00); a page with nothing of its own to play (failed,
 * not found) and every other frame has the interview playing at 0:22, started on its page
 * and kept through an in-app navigation. Needs a fresh E2E server. `KBC_FIDELITY_SHOTS=<dir>` saves
 * `<state-id>[@mobile].png`.
 */

test.describe.configure({ timeout: 600_000 });
// A step that cannot be taken fails at once, not at the end of the test's ten minutes.
test.use({ actionTimeout: 15_000 });

let world: PlayerWorld;
test.beforeAll(async () => {
  test.setTimeout(600_000);
  world = await seedPlayerWorld();
});

const heading = (page: Page, title: string) =>
  page.getByRole('heading', { name: title }).first();

/**
 * A media's page with its transcript drawn (or its state, when it has none); `play`: it
 * plays there, as the frames with ⏸ draw it (the shot puts the clock back on its time).
 */
async function openPlayer(
  page: Page,
  path: string,
  title: string,
  play = false,
): Promise<void> {
  await page.goto(`/midia/${path}`);
  await expect(heading(page, title)).toBeVisible();
  await pauseAll(page);
  if (!play) return;
  await page
    .locator('main')
    .getByRole('button', { name: 'Tocar', exact: true })
    .first()
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        (selector) =>
          document.querySelector<HTMLMediaElement>(selector)?.paused === false,
        MEDIA,
      ),
    )
    .toBe(true);
}

/** The interview heard at 0:22, its line of 0:22 (from 22.5 s) the one heard now. */
const AT = 22.55;

const more = (page: Page) =>
  page.getByRole('button', { name: 'Mais opções' }).first();

async function menuItem(page: Page, name: string | RegExp): Promise<void> {
  await more(page).click();
  await page.getByRole('menuitem', { name }).click();
}

test('the interview: player, voices, speed, ⋯, shortcuts, a new note, the sleep timer', async ({
  browser,
}) => {
  const es = world.byCode['ES'] ?? '';
  const title = 'Entrevista sobre a Tábua de Esmeralda';
  for (const width of WIDTHS) {
    const { context, page } = await contextAt(browser, width);
    await openPlayer(page, es, title, true);
    await expect(
      page
        .getByText('Cheguei pela mão de um amigo')
        .and(page.locator(':visible'))
        .first(),
    ).toBeVisible();
    await shoot(page, 'media-player', { width, at: AT });

    const voices = page
      .getByRole('group', { name: 'Ver' })
      .getByRole('button', { name: 'Vozes', exact: true });
    if (await voices.isVisible().catch(() => false)) {
      await voices.click();
      await expect(voices).toHaveAttribute('aria-pressed', 'true');
      await shoot(page, 'media-player-voices', { width, at: AT });
      await page
        .getByRole('group', { name: 'Ver' })
        .getByRole('button', { name: 'Transcrição', exact: true })
        .click();
    } else await shoot(page, 'media-player-voices', { width, at: AT });

    await page
      .getByRole('button', { name: /Velocidade/ })
      .first()
      .click();
    await expect(page.getByRole('menuitemradio').first()).toBeVisible();
    await shoot(page, 'media-player-speed', { width, at: AT });
    await page.keyboard.press('Escape');

    await more(page).click();
    await expect(
      page.getByRole('menuitem', { name: /Timer para dormir/ }),
    ).toBeVisible();
    await shoot(page, 'media-player-more', { width, at: AT });
    await page.keyboard.press('Escape');

    await menuItem(page, /Atalhos de teclado/);
    const keys = page.getByRole('dialog', { name: /Atalhos/ });
    await expect(keys).toBeVisible();
    await shoot(page, 'media-player-shortcuts', { width, at: AT });
    await page.keyboard.press('Escape');
    await expect(keys).toHaveCount(0);

    await openPlayer(page, `${es}?t=23`, title, true);
    await shoot(page, 'media-player-at', { width, top: false, at: AT });

    await openPlayer(page, `${es}?t=30`, title, true);
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/media/${es}/bookmarks`),
    );
    await page
      .getByRole('button', { name: 'Marcar este trecho' })
      .first()
      .click();
    const { id: mark } = (await (await created).json()) as { id: string };
    await expect(
      page.getByRole('textbox', { name: /^Nota do marcador em/ }),
    ).toBeVisible();
    await shoot(page, 'media-player-bookmark-note', { width, at: 30 });
    await page.keyboard.press('Escape');
    // The frames after this one have the interview's three bookmarks only.
    expect(
      (
        await page.request.delete(`/api/v1/media/${es}/bookmarks/${mark}`, {
          headers: CSRF,
        })
      ).status(),
    ).toBeLessThan(300);

    await openPlayer(page, es, title, true);
    await menuItem(page, /Timer para dormir/);
    const sleep = page.getByRole('dialog', { name: 'Timer para dormir' });
    await expect(sleep).toBeVisible();
    await shoot(page, 'media-player-sleep-dialog', { width, at: AT });
    await sleep.getByText('No fim desta mídia').click();
    if (await sleep.isVisible().catch(() => false))
      await page.keyboard.press('Escape');
    await expect(sleep).toHaveCount(0);
    await expect(
      page
        .getByText(/[Nn]o fim/)
        .and(page.locator(':visible'))
        .first(),
    ).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await shoot(page, 'media-player-sleep-on', { width, at: AT });
    await context.close();
  }
});

test('other media: low confidence, waiting, failed, not found, a recording and its track', async ({
  browser,
}) => {
  for (const width of WIDTHS) {
    const { context, page } = await contextAt(browser, width);
    await openPlayer(
      page,
      world.byCode['GR'] ?? '',
      'Gravação ruidosa do encontro',
      true,
    );
    await expect(
      page
        .getByText('Transcrição automática de baixa confiança')
        .and(page.locator(':visible'))
        .first(),
    ).toBeVisible();
    await shoot(page, 'media-player-low-confidence', { width, at: 0 });

    await openPlayer(
      page,
      world.byCode['AS'] ?? '',
      'Aula ainda sem transcrição',
    );
    await expect(
      page
        .getByText(/Aguardando o transcritor/)
        .and(page.locator(':visible'))
        .first(),
    ).toBeVisible();
    await shoot(page, 'media-player-waiting', width);

    // Nothing of its own to play: the interview plays at 0:22 in the bar, as drawn.
    await openPlayer(
      page,
      world.byCode['ES'] ?? '',
      'Entrevista sobre a Tábua de Esmeralda',
      true,
    );
    await go(page, `/midia/${world.byCode['AC']}`);
    await expect(heading(page, 'Arquivo corrompido da reunião')).toBeVisible();
    await expect(
      page
        .getByText(/não é um áudio válido/)
        .and(page.locator(':visible'))
        .first(),
    ).toBeVisible();
    await shoot(page, 'media-player-failed', { width, at: AT });

    await go(page, '/midia/00000000-0000-4000-8000-000000000000');
    await expect(
      page
        .getByText('Mídia não encontrada')
        .and(page.locator(':visible'))
        .first(),
    ).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await shoot(page, 'media-player-not-found', { width, at: AT });

    await openPlayer(
      page,
      world.byCode['PR'] ?? '',
      'Perguntas e respostas de 2019',
    );
    await expect(
      page
        .getByText('Como o senhor chegou à sessão?')
        .and(page.locator(':visible'))
        .first(),
    ).toBeVisible();
    await shoot(page, 'media-player-recording-tracks', width);

    await openPlayer(page, world.tracks[1] ?? '', 'Quem o levou até lá?', true);
    await expect(
      page
        .getByText(/Parte de/)
        .and(page.locator(':visible'))
        .first(),
    ).toBeVisible();
    await shoot(page, 'media-player-track', { width, at: 0 });
    await context.close();
  }
});

test('who only listens', async ({ browser }) => {
  for (const width of WIDTHS) {
    const { context, page } = await contextAt(browser, width, world.listener);
    await openPlayer(
      page,
      world.byCode['ES'] ?? '',
      'Entrevista sobre a Tábua de Esmeralda',
    );
    await expect(
      page
        .getByText('Mestre, o senhor está lembrado daquele dia?')
        .and(page.locator(':visible'))
        .first(),
    ).toBeVisible();
    await shoot(page, 'media-player-listener', width);
    await context.close();
  }
});

/** "Transcrever de novo", on the page (desktop) or in ⋯ (where the page has no button). */
async function again(page: Page): Promise<void> {
  const button = page
    .locator('app-transcribe-again')
    .getByRole('button', { name: 'Transcrever de novo', exact: true })
    .first();
  if (await button.isVisible().catch(() => false)) await button.click();
  else await menuItem(page, 'Transcrever de novo');
}

test('"Transcrever de novo": confirm, then queued', async ({ browser }) => {
  const lc = world.byCode['LC'] ?? '';
  const title = 'Leitura comentada do Caibalion';
  const confirm = (page: Page) =>
    page
      .getByText('Transcrever de novo com a lista de termos atual?')
      .and(page.locator(':visible'))
      .first();
  // Both widths confirm before the first one queues it for real.
  for (const width of WIDTHS) {
    const { context, page } = await contextAt(browser, width);
    await openPlayer(page, lc, title, true);
    await again(page);
    await expect(confirm(page)).toBeVisible();
    await shoot(page, 'media-player-transcribe-again', { width, at: 0 });
    await context.close();
  }
  for (const width of WIDTHS) {
    const { context, page } = await contextAt(browser, width);
    await openPlayer(page, lc, title, true);
    if (width === 'desktop') {
      await again(page);
      await expect(confirm(page)).toBeVisible();
      await page
        .getByRole('button', { name: 'Transcrever de novo', exact: true })
        .last()
        .click();
      await expect(confirm(page)).toBeHidden();
    }
    await expect(
      page
        .getByText(/Retranscrevendo/)
        .and(page.locator(':visible'))
        .first(),
    ).toBeVisible();
    await shoot(page, 'media-player-transcribe-again-queued', { width, at: 0 });
    await context.close();
  }
});

/** "Tocando agora" beside the library (desktop), opened or closed. */
async function nowPlaying(page: Page, open: boolean): Promise<void> {
  const panel = page.getByRole('complementary', { name: 'Tocando agora' });
  if ((await panel.isVisible()) === open) return;
  await page
    .getByRole('button', { name: 'Tocando agora', exact: true })
    .click();
  await expect(panel).toBeVisible({ visible: open });
}

/**
 * "3 marcadores em 1 áudio": the interview's, the others of the library left out. The app
 * reads them once, as it opens (the side panel's count too).
 */
async function onlyInterviewBookmarks(page: Page, es: string): Promise<void> {
  await page.context().route('**/api/v1/media/bookmarks', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = (await response.json()) as { items: { mediaId: string }[] };
    await route.fulfill({
      response,
      json: { ...body, items: body.items.filter((one) => one.mediaId === es) },
    });
  });
}

test('the mini player, "Meus marcadores" and the queue', async ({
  browser,
}) => {
  const es = world.byCode['ES'] ?? '';
  for (const width of WIDTHS) {
    const phone = width === 'phone';
    const { context, page } = await contextAt(browser, width);
    await onlyInterviewBookmarks(page, es);
    await playInterview(page, world);
    await go(page, '/biblioteca');
    await expect(page.locator('app-library-row').first()).toBeVisible();
    // The bar's Fila (green in the frame) opens the right panel on its Fila tab.
    const queue = page.getByRole('button', { name: 'Fila', exact: true });
    if (!phone) {
      await nowPlaying(page, false);
      await queue.click();
      await expect(queue).toHaveAttribute('aria-pressed', 'true');
    }
    await shoot(page, 'media-mini-player', { width, top: true });
    if (!phone) await queue.click();

    await go(page, '/midia/marcadores');
    await expect(
      page
        .getByText('3 marcadores em 1 áudio')
        .and(page.locator(':visible'))
        .first(),
    ).toBeVisible();
    await shoot(page, 'media-bookmarks', { width, top: true });

    await go(page, '/fila');
    await expect(
      page
        .getByText('Aula para preparar')
        .and(page.locator(':visible'))
        .first(),
    ).toBeVisible();
    await shoot(page, 'media-queue', { width, top: true });

    // Nothing in the queue (a stand-in: the seeded media are all done or held).
    await context.route('**/api/v1/media/processing', (route) =>
      route.fulfill({
        json: {
          items: [],
          active: 0,
          transcriber: 'on',
          transcriberOffSince: null,
        },
      }),
    );
    await go(page, '/biblioteca');
    await go(page, '/fila');
    await expect(
      page
        .getByText(/Nada sendo processado agora/)
        .and(page.locator(':visible'))
        .first(),
    ).toBeVisible();
    await shoot(page, 'media-queue-empty', { width, top: true });
    await context.close();

    const listener = await contextAt(browser, width, world.listener);
    await playInterview(listener.page, world);
    await go(listener.page, '/midia/marcadores');
    await expect(
      listener.page
        .getByText(/Você ainda não marcou nenhum trecho/)
        .and(listener.page.locator(':visible'))
        .first(),
    ).toBeVisible();
    await shoot(listener.page, 'media-bookmarks-empty', { width, top: true });
    await listener.context.close();
  }
});

test('the track editor and the bounds', async ({ browser }) => {
  const rp = world.byCode['RP'] ?? '';
  for (const width of WIDTHS) {
    const { context, page } = await contextAt(browser, width);
    await playInterview(page, world);
    await go(page, `/midia/${rp}/faixas`);
    const approve = page.getByRole('button', { name: 'Aprovar faixas' }).last();
    await expect(approve).toBeVisible();
    await expect(
      page.getByText('Terceira faixa').and(page.locator(':visible')).first(),
    ).toBeAttached();
    await shoot(page, 'media-tracks', { width, top: true });

    // Track 3 with no title: "Aprovar" names it and sends nothing.
    const third = page
      .getByRole('list', { name: 'Faixas' })
      .getByRole('listitem')
      .nth(2);
    await third.locator('button.head').click();
    // A phone keeps the title in the track's details, opened from its ⋯.
    if (width === 'phone') {
      await third.getByRole('button', { name: 'Mais ações da faixa' }).click();
      await page
        .getByRole('menuitem', { name: 'Tipo, nível e texto da faixa' })
        .click();
    }
    const name = third.getByRole('textbox', { name: 'Título' });
    await name.fill('');
    await name.blur();
    await approve.click();
    await expect(
      page
        .getByText('Corrija antes de aprovar:')
        .and(page.locator(':visible'))
        .first(),
    ).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await shoot(page, 'media-tracks-problems', { width, top: true });
    await context.close();
    await restoreDraft(world);

    const { context: next, page: other } = await contextAt(browser, width);
    await playInterview(other, world);
    await go(other, `/midia/${world.byCode['PR']}/faixas`);
    await expect(other.getByText(/Preparação concluída/).first()).toBeVisible();
    await shoot(other, 'media-tracks-finished', { width, top: true });

    await go(other, `/midia/${world.byCode['CS']}/faixas`);
    await expect(other.getByText('Nenhuma faixa ainda').first()).toBeVisible();
    await shoot(other, 'media-tracks-empty', { width, top: true });

    await go(other, `/midia/${world.tracks[1]}/limites`);
    await expect(
      other.getByRole('button', { name: 'Salvar limites' }),
    ).toBeVisible();
    await shoot(other, 'media-bounds', { width, top: true });
    await other
      .getByRole('button', { name: 'Mais 0,5 segundo' })
      .first()
      .click();
    await expect(other.getByText('0:15,5').first()).toBeVisible();
    await shoot(other, 'media-bounds-adjusted', { width, top: true });
    await next.close();

    const listener = await contextAt(browser, width, world.listener);
    await playInterview(listener.page, world);
    await go(listener.page, `/midia/${rp}/faixas`);
    await expect(
      listener.page
        .getByText(/não tem permissão para editar/)
        .and(listener.page.locator(':visible'))
        .first(),
    ).toBeVisible();
    await shoot(listener.page, 'media-tracks-forbidden', { width, top: true });
    await listener.context.close();
  }
});

/** The draft's three titles back, whatever the problems state left saved. */
async function restoreDraft(w: PlayerWorld): Promise<void> {
  const owner = await ownerApi();
  await saveDraft(owner, w);
  await owner.dispose();
}

test.afterAll(() => shotsDone());
