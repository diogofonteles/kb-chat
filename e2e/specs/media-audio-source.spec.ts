import AxeBuilder from '@axe-core/playwright';
import type {
  APIRequestContext,
  Locator,
  Page,
  TestInfo,
} from '@playwright/test';
import { CSRF, expect, ownerApi, test } from './fixtures.js';
import { audioState, closePlayer } from './media-helpers.js';
import {
  SPEECH,
  TITLE,
  ask,
  audioSource,
  publishedTrack,
  readingSheet,
  researcher,
} from './research-tracks-helpers.js';
import { separateVoices } from './voices-helpers.js';

/*
 * KBC-150 (v2 · Pesquisa com IA — fonte de áudio): the audio source of an answer, every control
 * clicked, scrolled with the wheel and the keyboard, played on the app's own player, at 1440
 * (beside the answer) and 390 (in the reading sheet), in Chrome and, with KBC_E2E_WEBKIT=1, in
 * WebKit at both widths. The answer is a real research turn, then the same sources saved as a
 * conversation citing the track twice and a second track once ([1] and [2@0:41], [2@0:50]), then
 * both passages again side by side, as one pill with two times (KBC-155).
 * `KBC_SHOTS=<dir>` saves the screens for the comparison with the Figma frames (`KBC_SHOTS_PREFIX`).
 */

const shots = process.env['KBC_SHOTS'];
/** `KBC_SHOTS_PREFIX` names a new round of screens without overwriting the last one. */
const shotPrefix = process.env['KBC_SHOTS_PREFIX'] ?? 'after';
const SECOND = 'E a polaridade?';
/** Enough speech for the whole transcript to scroll in its own box. */
const LONG_SPEECH = [
  ...SPEECH,
  ...Array.from({ length: 11 }, (_, at) => ({
    at: 5 + at * 3,
    text: `Linha de preenchimento número ${at + 1}`,
  })),
  ...Array.from({ length: 6 }, (_, at) => ({
    at: 70 + at * 3,
    text: `Fala final número ${at + 1}`,
  })),
].sort((a, b) => a.at - b.at);
const QUESTION = 'ritmo e polaridade';

interface Source {
  readonly n: number;
  readonly id: string;
  readonly title: string;
  readonly media?: { readonly mediaId: string };
  readonly passages?: readonly {
    readonly at: string;
    readonly startMs: number;
    readonly endMs: number;
  }[];
}

interface Conversation {
  readonly id: string;
  readonly title: string;
  readonly turns: readonly {
    readonly question: string;
    readonly sources: readonly Source[];
  }[];
}

const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

async function shot(page: Page, name: string): Promise<void> {
  if (!shots) return;
  const width = isDesktop(page) ? 1440 : 390;
  const engine = test.info().project.name.includes('webkit') ? '-webkit' : '';
  await page.screenshot({
    path: `${shots}/${shotPrefix}-${name}-${width}${engine}.png`,
  });
}

/** Saves the conversation as the member's own and opens it from "Conversas", as a reader does. */
async function openConversation(
  member: Page,
  conversation: { readonly id: string },
): Promise<void> {
  const put = await member.request.put(
    `/api/v1/conversations/${conversation.id}`,
    { data: conversation, headers: CSRF },
  );
  expect(put.status(), await put.text()).toBe(200);
  await member.reload();
  await showConversation(member);
}

/** Opens the conversation from "Conversas", as a reader does. */
async function showConversation(member: Page): Promise<void> {
  const skip = member.getByRole('button', { name: 'Pular' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  if (!isDesktop(member))
    await member.getByRole('button', { name: 'Menu', exact: true }).click();
  const side = isDesktop(member)
    ? member.getByRole('complementary', { name: 'Sua biblioteca' })
    : member.getByRole('dialog', { name: 'Menu' });
  await side
    .getByRole('navigation', { name: 'Conversas' })
    .getByRole('button', { name: new RegExp(QUESTION) })
    .first()
    .click();
  if (!isDesktop(member)) {
    await expect(side).toBeHidden();
    await expect(
      member.getByRole('button', { name: 'Menu', exact: true }),
    ).toBeFocused();
  }
}

/**
 * Two real research turns (the track, then the second track), saved again as one answer that
 * cites the second track as [1] and the first one at two passages, as [2@0:41] and [2@0:50].
 */
async function answerWithTwoTracks(member: Page): Promise<void> {
  await ask(member);
  await member.getByLabel('Sua pergunta').fill('polaridade');
  await member.getByRole('button', { name: 'Perguntar' }).click();
  await expect(member.locator('app-research-message')).toHaveCount(2);
  await expect(
    member
      .locator('app-research-message')
      .last()
      .getByText(/Resposta gerada por IA/),
  ).toBeVisible({ timeout: 30_000 });
  let saved: Conversation | undefined;
  await expect
    .poll(
      async () => {
        const list = await member.request.get(
          '/api/v1/conversations?kind=research',
        );
        const { items } = (await list.json()) as { items: { id: string }[] };
        const [first] = items;
        if (!first) return 0;
        const one = await member.request.get(
          `/api/v1/conversations/${first.id}`,
        );
        saved = (await one.json()) as Conversation;
        return saved.turns.filter((turn) => turn.sources.length > 0).length;
      },
      { timeout: 20_000 },
    )
    .toBe(2);
  const [first, second] = saved?.turns ?? [];
  const track = first?.sources[0];
  const other = second?.sources[0];
  if (!saved || !first || !track?.passages?.[0] || !other)
    throw new Error('no sources');
  expect(other.title).toBe(SECOND);
  const now = new Date().toISOString();
  const passage = track.passages[0];
  const conversation = {
    ...saved,
    id: crypto.randomUUID(),
    title: QUESTION,
    createdAt: now,
    updatedAt: now,
    turns: [
      {
        ...first,
        id: crypto.randomUUID(),
        at: now,
        question: QUESTION,
        answer: `A polaridade aparece [1@${other.passages?.[0]?.at ?? ''}]. O pêndulo governa tudo [2@0:41] e tudo flui [2@0:50]. Tudo vibra [2@0:50], [2@0:41].`,
        sources: [
          { ...other, n: 1 },
          {
            ...track,
            n: 2,
            passages: [passage, { at: '0:50', startMs: 50_000, endMs: 53_000 }],
          },
        ],
      },
    ],
  };
  await openConversation(member, conversation);
  await expect(
    member.getByRole('link', {
      name: `Fonte 2, faixa ${TITLE}, aos 41 segundos`,
    }),
  ).toBeVisible();
}

/** The element scrolls with the wheel over it and with the keyboard from inside it. */
async function scrolls(
  page: Page,
  scroller: Locator,
  focusInside: Locator,
): Promise<void> {
  const room = await scroller.evaluate(
    (el) => el.scrollHeight - el.clientHeight,
  );
  expect(room, 'something to scroll').toBeGreaterThan(20);
  const top = () => scroller.evaluate((el) => el.scrollTop);
  await scroller.evaluate((el) => el.scrollTo({ top: 0 }));
  await scroller.hover();
  await page.mouse.wheel(0, 400);
  await expect
    .poll(top, { message: 'the wheel scrolls it' })
    .toBeGreaterThan(0);
  await scroller.evaluate((el) => el.scrollTo({ top: 0 }));
  await focusInside.focus();
  await page.keyboard.press('PageDown');
  await expect.poll(top, { message: 'PageDown scrolls it' }).toBeGreaterThan(0);
  await scroller.evaluate((el) => el.scrollTo({ top: 0 }));
}

/**
 * The panel's own scroll: with the whole transcript open it is longer than the screen (a
 * resized window is no proof: WebKit keeps the sheet's 85dvh of the first size).
 */
async function panelScrolls(
  page: Page,
  panel: Locator,
  scroller: Locator,
): Promise<void> {
  await panel.getByRole('button', { name: 'Transcrição completa' }).click();
  await expect(
    panel.getByRole('list', { name: 'Trechos da transcrição' }),
  ).toBeVisible();
  await scrolls(page, scroller, panel.getByRole('heading', { name: TITLE }));
  await panel.getByRole('button', { name: 'Em volta do trecho' }).click();
  await expect(
    panel.getByRole('list', { name: 'Em volta do trecho' }),
  ).toBeVisible();
}

const playing = async (page: Page) => !(await audioState(page)).paused;

/**
 * The one control of what plays (KBC-155 BR-1): the bar on a desktop; on a phone, with the
 * reading sheet open over the page, the player at the sheet's foot.
 */
const theControl = (page: Page): Locator =>
  isDesktop(page)
    ? page.getByRole('region', { name: 'Mini-player' })
    : audioSource(page).getByRole('group', { name: 'Player' });

/** Pauses on the one control, and the panel has no "Pausar" of its own. */
async function pauseOnTheControl(page: Page, panel: Locator): Promise<void> {
  await expect(
    panel
      .getByRole('region', { name: /–/ })
      .getByRole('button', { name: /Pausar/ }),
  ).toHaveCount(0);
  await theControl(page)
    .getByRole('button', { name: /^Pausar/ })
    .click();
  await expect.poll(() => playing(page)).toBe(false);
}

async function seriousAxe(page: Page): Promise<unknown[]> {
  const axe = await new AxeBuilder({ page })
    .include('app-track-passage-panel')
    .analyze();
  return axe.violations
    .filter((one) => ['serious', 'critical'].includes(one.impact ?? ''))
    .map((one) => ({
      id: one.id,
      nodes: one.nodes.map(
        (node) => `${node.target.join(' ')}: ${node.failureSummary ?? ''}`,
      ),
    }));
}

/** The viewports a project walks: its own, and in WebKit the phone width too. */
function viewports(page: Page, info: TestInfo) {
  const own = page.viewportSize() ?? { width: 1440, height: 900 };
  return info.project.name === 'media-webkit'
    ? [own, { width: 390, height: 844 }]
    : [own];
}

/** The controls every width shares: the passage, the marks, the times, the transcript. */
async function walkTheControls(member: Page, panel: Locator): Promise<void> {
  const card = panel.getByRole('region', { name: /0:41–/ });
  // Ouvir o trecho → it plays on the app's player; the card only says so (KBC-155).
  await panel.getByRole('button', { name: 'Ouvir o trecho' }).click();
  await expect.poll(() => playing(member)).toBe(true);
  await expect
    .poll(async () => (await audioState(member)).currentTime, {
      timeout: 15_000,
    })
    .toBeGreaterThan(39.2);
  await expect(card.getByText('tocando no player')).toBeVisible();
  // On a desktop the panel has no "Pausar" at all; on a phone only the sheet's player has one.
  await expect(
    (isDesktop(member) ? panel : card).getByRole('button', { name: 'Pausar' }),
  ).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Faixa toda' })).toHaveCount(
    0,
  );
  await expect(panel.getByText(/^trecho citado /)).toHaveCount(0);
  await expect(
    panel.getByRole('button', { name: /^Trecho citado aos/ }),
  ).toHaveCount(0);
  await expect(card.locator('.quote span.lit').first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(panel.locator('.line[aria-current="true"]')).toHaveCount(1);
  await expect(theControl(member)).toBeInViewport();
  await shot(member, 'playing');
  await pauseOnTheControl(member, panel);
  await expect(
    panel.getByRole('button', { name: 'Ouvir o trecho' }),
  ).toBeVisible();

  // "Outros trechos citados" (KBC-155 AC-4): each goes to its passage.
  const others = panel.getByRole('list', { name: 'Outros trechos citados' });
  await others
    .getByRole('button', { name: 'Outro trecho citado, em 0:50' })
    .click();
  await expect(panel.getByRole('region', { name: /0:50–0:53/ })).toBeVisible();
  await expect
    .poll(async () => (await audioState(member)).currentTime)
    .toBeCloseTo(48, 0);
  await others
    .getByRole('button', { name: 'Outro trecho citado, em 0:41' })
    .click();
  await expect(card).toBeVisible();

  // A time around the passage plays from there.
  const around = panel.getByRole('list', { name: 'Em volta do trecho' });
  const first = around
    .getByRole('button', { name: /^Ouvir a partir de/ })
    .first();
  await first.click();
  await expect.poll(() => playing(member)).toBe(true);
  await expect
    .poll(async () => (await audioState(member)).currentTime)
    .toBeGreaterThan(35);
  await pauseOnTheControl(member, panel);

  // The bookmark at the passage, saved.
  const saved = member.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/bookmarks$/.test(new URL(response.url()).pathname),
  );
  await panel.getByRole('button', { name: 'Marcar este trecho' }).click();
  expect((await saved).status()).toBe(201);

  // Share: the link of the track page at the passage.
  await member.evaluate(() => {
    const copied: string[] = [];
    (window as unknown as { copied: string[] }).copied = copied;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          copied.push(text);
          return Promise.resolve();
        },
      },
    });
  });
  await panel.getByRole('button', { name: 'Copiar o link do trecho' }).click();
  const copied = await member.evaluate(
    () => (window as unknown as { copied: string[] }).copied,
  );
  expect(copied).toHaveLength(1);
  expect(copied[0]).toMatch(/\/midia\/[0-9a-f-]+\?t=4[01]$/);

  // The whole transcript, its own scroll, its search; back to the lines around.
  await panel.getByRole('button', { name: 'Transcrição completa' }).click();
  const list = panel.getByRole('list', { name: 'Trechos da transcrição' });
  await expect(list).toBeVisible();
  await scrolls(member, list, list.getByRole('button').first());
  await panel.getByRole('button', { name: 'Em volta do trecho' }).click();
  await expect(around).toBeVisible();
  await panel.getByRole('button', { name: 'Buscar na transcrição' }).click();
  const search = panel.getByRole('searchbox');
  await expect(search).toBeFocused();
  await search.fill('pêndulo');
  await expect(list.locator('.segment').first()).toBeVisible();
  await shot(member, 'full-transcript');
  await panel.getByRole('button', { name: 'Em volta do trecho' }).click();
  await expect(around).toBeVisible();
}

/** QA BUG-1: the passage and its row of actions stay inside the card's padding. */
async function cardHoldsItsRow(panel: Locator): Promise<void> {
  const card = panel.locator('section.cited');
  const box = await card.boundingBox();
  const padding = 18;
  for (const inner of [
    panel.getByRole('button', { name: 'Copiar o link do trecho' }),
    card.locator('blockquote'),
  ]) {
    const own = await inner.boundingBox();
    if (!box || !own)
      throw new Error('the card or its content is not laid out');
    expect(own.x).toBeGreaterThanOrEqual(box.x + padding - 1);
    expect(own.x + own.width).toBeLessThanOrEqual(
      box.x + box.width - padding + 1,
    );
  }
}

async function desktopFlow(member: Page): Promise<void> {
  const citation = member.getByRole('link', {
    name: `Fonte 2, faixa ${TITLE}, aos 41 segundos`,
  });
  await expect(citation).toHaveText(`2${TITLE} · 0:41`);
  await citation.click();
  const panel = audioSource(member);
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAccessibleName(
    `Trecho da faixa ${TITLE}, aos 41 segundos`,
  );
  await expect(panel.getByText('Fonte 2 de 2 · Áudio')).toBeVisible();
  await expect(panel.getByRole('heading', { name: TITLE })).toBeFocused();
  await expect(citation).toHaveClass(/active/);
  // No player of its own: it is the bar's, already holding the track, paused at 0:39.
  await expect(panel.getByRole('slider')).toHaveCount(0);
  const bar = member.getByRole('region', { name: 'Mini-player' });
  await expect(bar).toBeVisible();
  await expect(bar).toContainText(TITLE);
  await expect
    .poll(async () => (await audioState(member)).currentTime, {
      timeout: 15_000,
    })
    .toBeCloseTo(39, 0);
  expect(await playing(member)).toBe(false);
  await cardHoldsItsRow(panel);
  await shot(member, 'stopped');
  expect(await seriousAxe(member)).toEqual([]);

  // The panel scrolls (wheel and keyboard) once the whole transcript makes it long.
  await panelScrolls(member, panel, panel.locator('.scroller'));

  await walkTheControls(member, panel);

  // "Faixa toda" plays from the start, on the bar.
  await panel.getByRole('button', { name: 'Faixa toda' }).click();
  await expect.poll(() => playing(member)).toBe(true);
  expect((await audioState(member)).currentTime).toBeLessThan(5);
  await expect(panel.getByRole('button', { name: 'Faixa toda' })).toHaveCount(
    0,
  );
  await pauseOnTheControl(member, panel);
  await expect(panel.getByRole('button', { name: 'Faixa toda' })).toBeVisible();

  // The bar closed: "Ouvir o trecho" puts the track back on it and plays the passage.
  // The source panel holds the right panel: the avatar's menu closes the player.
  await closePlayer(member, 'account');
  await expect(bar).toBeHidden();
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Ouvir o trecho' }).click();
  await expect.poll(() => playing(member)).toBe(true);
  await expect(bar).toContainText(TITLE);
  await pauseOnTheControl(member, panel);

  for (const theme of ['light', 'dark', 'esoteric', 'revised']) {
    await member.evaluate(
      (value) => document.documentElement.setAttribute('data-theme', value),
      theme,
    );
    // The colours ease into the theme: axe reads them once they settled.
    await expect
      .poll(() => member.evaluate(() => document.getAnimations().length))
      .toBe(0);
    expect(await seriousAxe(member), theme).toEqual([]);
  }

  // ‹ › between the answer's sources.
  await expect(
    panel.getByRole('button', { name: 'Próxima fonte' }),
  ).toBeDisabled();
  await panel.getByRole('button', { name: 'Fonte anterior' }).click();
  await expect(panel).toHaveAccessibleName(
    new RegExp(`Trecho da faixa ${SECOND}`),
  );
  await expect(panel.getByText('Fonte 1 de 2 · Áudio')).toBeVisible();
  await expect(
    panel.getByRole('button', { name: 'Fonte anterior' }),
  ).toBeDisabled();
  await panel.getByRole('button', { name: 'Próxima fonte' }).click();
  await expect(panel).toHaveAccessibleName(
    new RegExp(`Trecho da faixa ${TITLE}`),
  );

  // ✕ closes and gives the focus back to the citation.
  await panel.getByRole('button', { name: 'Fechar', exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(citation).toBeFocused();

  // ⤢ opens the track page at the passage.
  await citation.click();
  await expect(panel).toBeVisible();
  await panel.getByRole('link', { name: 'Abrir a página da faixa' }).click();
  await expect(member).toHaveURL(/\/midia\/[0-9a-f-]+\?t=39$/);
}

async function phoneFlow(member: Page): Promise<void> {
  const citation = member.getByRole('link', {
    name: `Fonte 2, faixa ${TITLE}, aos 41 segundos`,
  });
  await citation.click();
  const sheet = readingSheet(member);
  await expect(sheet).toBeVisible();
  const panel = audioSource(member);
  const tabs = sheet.getByRole('tab');
  await expect(tabs).toHaveText(['Fonte 1', 'Fonte 2']);
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.nth(1).locator('ui-icon')).toHaveCount(1);
  await expect(panel.getByRole('heading', { name: TITLE })).toBeFocused();
  // 85% of the screen, over the answer.
  const box = await sheet.boundingBox();
  const height = member.viewportSize()?.height ?? 0;
  expect(
    Math.round(((box?.height ?? 0) / height) * 100),
  ).toBeGreaterThanOrEqual(84);
  await expect
    .poll(async () => (await audioState(member)).currentTime, {
      timeout: 15_000,
    })
    .toBeCloseTo(39, 0);
  await shot(member, 'stopped');
  expect(await seriousAxe(member)).toEqual([]);

  // The sheet's content scrolls (wheel and keyboard) once the whole transcript makes it long.
  await panelScrolls(member, panel, panel);

  // The sheet's player (KBC-155 AC-5): at its foot, in view and clickable, paused and playing.
  const control = theControl(member);
  await expect(control).toBeInViewport();
  await expect(control.getByText(/^Pausado · 0:\d\d/)).toBeVisible();
  await control.getByRole('button', { name: 'Tocar' }).click();
  await expect.poll(() => playing(member)).toBe(true);
  await expect(
    control.getByText(/Tocando o trecho citado · 0:\d\d/),
  ).toBeVisible();
  await expect(control).toBeInViewport();
  await pauseOnTheControl(member, panel);
  await expect(control.getByRole('button', { name: 'Tocar' })).toBeInViewport();
  await expect(
    panel.getByRole('link', { name: 'Abrir a faixa' }),
  ).toBeVisible();

  await walkTheControls(member, panel);

  // The other tab: the second track, in the same sheet.
  await tabs.nth(0).click();
  await expect(panel.getByRole('heading', { name: SECOND })).toBeVisible();
  await tabs.nth(1).click();
  await expect(panel.getByRole('heading', { name: TITLE })).toBeVisible();

  // Dragging the head down closes it; the focus goes back to the citation.
  const head = sheet.locator('.sheet-head');
  const handle = await head.boundingBox();
  if (!handle) throw new Error('no sheet head');
  const x = handle.x + handle.width / 2;
  const y = handle.y + 6;
  await member.mouse.move(x, y);
  await member.mouse.down();
  await member.mouse.move(x, y + 60, { steps: 4 });
  await member.mouse.move(x, y + 200, { steps: 6 });
  await member.mouse.up();
  await expect(sheet).toBeHidden();
  await expect(citation).toBeFocused();

  // ✕ closes it too; then the mini player holds the track, and plays it.
  await citation.click();
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Fechar', exact: true }).click();
  await expect(sheet).toBeHidden();
  const mini = member.getByRole('region', { name: 'Mini-player' });
  await expect(mini).toBeVisible();
  await expect(mini).toContainText(TITLE);
  await mini.getByRole('button', { name: /^Tocar/ }).click();
  await expect.poll(() => playing(member)).toBe(true);
}

test('KBC-150: the audio source opens on the cited passage, every control works, it plays on the app’s player and closes', async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  const owner = await ownerApi();
  const topic = await publishedTrack(owner, LONG_SPEECH);
  await owner.dispose();
  for (const viewport of viewports(page, info)) {
    const member = await researcher(page, topic, { viewport });
    await answerWithTwoTracks(member);
    if (isDesktop(member)) await desktopFlow(member);
    else await phoneFlow(member);
    await member.context().close();
  }
});

test('KBC-155 AC-6: citations of the same track side by side are one pill, each time opens its passage and is the one filled', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const owner = await ownerApi();
  const topic = await publishedTrack(owner, LONG_SPEECH);
  await owner.dispose();
  for (const viewport of viewports(page, info)) {
    const member = await researcher(page, topic, { viewport });
    await answerWithTwoTracks(member);
    const pill = member.locator('app-research-message .cite-group');
    await expect(pill).toHaveCount(1);
    await expect(pill).toHaveText(`2${TITLE} · 0:50, 0:41`);
    const at50 = pill.getByRole('link', {
      name: `Ouvir ${TITLE} aos 50 segundos`,
    });
    const at41 = pill.getByRole('link', {
      name: `Ouvir ${TITLE} aos 41 segundos`,
    });
    await shot(member, 'grouped-pill');
    // Each time is a target of at least 24 px (WCAG 2.5.8): a tap 12 px above or below its
    // middle still lands on it.
    await pill.scrollIntoViewIfNeeded();
    for (const time of [at50, at41])
      await expect.poll(() => tappedAround(time)).toEqual([true, true]);
    await at50.click();
    const panel = audioSource(member);
    await expect(
      panel.getByRole('region', { name: /0:50–0:53/ }),
    ).toBeVisible();
    if (isDesktop(member)) {
      await expect(at50).toHaveClass(/active/);
      await expect(at41).not.toHaveClass(/active/);
      await at41.click();
      await expect(panel.getByRole('region', { name: /0:41–/ })).toBeVisible();
      await expect(at41).toHaveClass(/active/);
      await expect(at50).not.toHaveClass(/active/);
    } else {
      await readingSheet(member)
        .getByRole('button', { name: 'Fechar', exact: true })
        .click();
      await expect(readingSheet(member)).toBeHidden();
      await expect(at50).toBeFocused();
      await at41.click();
      await expect(panel.getByRole('region', { name: /0:41–/ })).toBeVisible();
    }
    await member.context().close();
  }
});

/** Whether a tap 12 px above and 12 px below the link's middle still lands on it. */
const tappedAround = (link: Locator) =>
  link.evaluate((element) => {
    const { left, width, top, height } = element.getBoundingClientRect();
    const x = left + width / 2;
    const middle = top + height / 2;
    return [middle - 11.5, middle + 11.5].map((y) =>
      element.contains(document.elementFromPoint(x, y)),
    );
  });

/**
 * Seeks the app's one player, as its bar or the phone's strip would (KBC-154). Only once the
 * element has its metadata and no seek in flight: before that the engine still moves it to
 * where it was asked to start, and WebKit, which loads later, would undo this seek.
 */
async function seekTo(page: Page, seconds: number): Promise<void> {
  const engine = page.locator('[data-media-engine]');
  await expect
    .poll(() =>
      engine.evaluate((element) => {
        const media = element as HTMLMediaElement;
        return media.readyState >= media.HAVE_METADATA && !media.seeking;
      }),
    )
    .toBe(true);
  await engine.evaluate((element, at) => {
    (element as HTMLMediaElement).currentTime = at;
  }, seconds);
}

test('KBC-154: while the track plays past the passage, the lines around and the full transcript follow what is heard', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const owner = await ownerApi();
  const topic = await publishedTrack(owner, LONG_SPEECH);
  await owner.dispose();
  const member = await researcher(page, topic);
  await answerWithTwoTracks(member);
  await member
    .getByRole('link', { name: `Fonte 2, faixa ${TITLE}, aos 41 segundos` })
    .click();
  const panel = audioSource(member);
  await expect(panel.getByRole('heading', { name: TITLE })).toBeFocused();
  const around = panel.getByRole('list', { name: 'Em volta do trecho' });
  const heard = around.locator('.line[aria-current="true"]');

  await panel.getByRole('button', { name: 'Ouvir o trecho' }).click();
  await expect.poll(() => playing(member)).toBe(true);
  // The player really plays the passage (its `playing` came, after the metadata's move to
  // 0:39): a seek before that is overridden by the start the panel asked for.
  await expect(panel.getByText('tocando no player')).toBeVisible();
  await seekTo(member, 5.2);
  await expect(heard).toContainText('Linha de preenchimento número 1', {
    timeout: 10_000,
  });
  await expect(heard).toBeVisible();
  await expect(around.locator('.line')).toHaveCount(3);
  await expect(around).not.toContainText('O ritmo é a lei do pêndulo');
  // It keeps following: the next line is marked once it is heard.
  await expect(heard).toContainText('Linha de preenchimento número 2', {
    timeout: 10_000,
  });
  await expect(heard).toBeVisible();

  // The whole transcript marks the line heard and keeps it in view.
  await panel.getByRole('button', { name: 'Transcrição completa' }).click();
  const list = panel.getByRole('list', { name: 'Trechos da transcrição' });
  await expect(list).toBeVisible();
  await seekTo(member, 29.2);
  const active = list.locator('.segment.active');
  await expect(active).toContainText('Linha de preenchimento número 9', {
    timeout: 10_000,
  });
  await expect(active).toBeInViewport();
  await expect(active.locator('.time')).toHaveAttribute('aria-current', 'true');

  // Paused: the lines around are the passage's again.
  await panel.getByRole('button', { name: 'Em volta do trecho' }).click();
  await pauseOnTheControl(member, panel);
  await expect(around.locator('.cited-line')).toContainText(
    'O ritmo é a lei do pêndulo',
  );
});

/**
 * KBC-151 AC-1: the recording's voices, the one that says the passage at 0:41 named (and
 * confirmed) in the collection, the one that asks at 0:02 left unnamed.
 */
const NAMED = 'Irmã Helena Prado';

async function voicedRecording(
  owner: APIRequestContext,
  recordingId: string,
  topic: string,
): Promise<void> {
  await separateVoices(owner, recordingId, {
    turns: [
      { start: 0, end: 30, voice: 'SPEAKER_01' },
      { start: 30, end: 60, voice: 'SPEAKER_02' },
      { start: 60, end: 90, voice: 'SPEAKER_03' },
    ],
  });
  const read = await owner.get(`/api/v1/media/${recordingId}/transcript`);
  const { segments } = (await read.json()) as {
    segments: { startMs: number; voice?: number | null }[];
  };
  const voice = segments.find(({ startMs }) => startMs >= 41_000)?.voice;
  expect(voice, 'the passage has a voice').toEqual(expect.any(Number));
  const speaker = await owner.post(`/api/v1/topics/${topic}/speakers`, {
    headers: CSRF,
    data: { name: NAMED },
  });
  expect(speaker.status(), await speaker.text()).toBe(201);
  const { id } = (await speaker.json()) as { id: string };
  const named = await owner.put(
    `/api/v1/media/${recordingId}/voices/${voice}`,
    {
      headers: CSRF,
      data: { version: 1, speakerId: id, audience: false },
    },
  );
  expect(named.status(), await named.text()).toBe(200);
}

test('KBC-151 AC-1: a researcher who only listens (no media-edit) sees who speaks in the audio source', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const owner = await ownerApi();
  const topic = await publishedTrack(owner, SPEECH, (id, collection) =>
    voicedRecording(owner, id, collection),
  );
  await owner.dispose();
  // The researcher's features: no `media-edit` (KBC-151 BR-0).
  const member = await researcher(page, topic);
  await answerWithTwoTracks(member);
  await member
    .getByRole('link', { name: `Fonte 2, faixa ${TITLE}, aos 41 segundos` })
    .click();
  const panel = audioSource(member);
  await expect(panel.getByRole('heading', { name: TITLE })).toBeFocused();
  if (isDesktop(member)) {
    const who = panel.getByRole('region', { name: /0:41–/ }).locator('.who');
    await expect(who).toHaveText(NAMED);
    await expect(who.locator('.dot')).toBeVisible();
  }
  const around = panel.getByRole('list', { name: 'Em volta do trecho' });
  const cited = around.locator('.cited-line');
  await expect(cited.locator('.who')).toHaveText(NAMED);
  await expect(cited.locator('.who .dot')).toBeVisible();
  await expect(around.locator('.line').first().locator('.who')).toHaveText(
    'Falante não identificado',
  );
  await expect(panel).not.toContainText(/Voz \d/);
  await shot(member, 'who-speaks');
});

/** The owner's case (KBC-156): a 1 s utterance at the track's start, speech right after it. */
const FRAGMENT_SPEECH = [
  { at: 0, text: 'É, italiano, tá.' },
  { at: 1, text: 'Meu pai veio da Itália com a família inteira,' },
  { at: 4, text: 'e eu cresci na roça ouvindo as histórias dele.' },
  ...SPEECH.filter(({ at }) => at > 30),
];

/**
 * A real research turn, saved again as an answer from before KBC-156: it cites the track at
 * 0:00 with the lone 1 s segment as its passage.
 */
async function answerCitingTheFragment(member: Page): Promise<void> {
  await ask(member);
  let saved: Conversation | undefined;
  await expect
    .poll(
      async () => {
        const list = await member.request.get(
          '/api/v1/conversations?kind=research',
        );
        const { items } = (await list.json()) as { items: { id: string }[] };
        const [first] = items;
        if (!first) return 0;
        const one = await member.request.get(
          `/api/v1/conversations/${first.id}`,
        );
        saved = (await one.json()) as Conversation;
        return saved.turns[0]?.sources.length ?? 0;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  const turn = saved?.turns[0];
  const track = turn?.sources.find((one) => one.media);
  if (!saved || !turn || !track) throw new Error('no track cited');
  const now = new Date().toISOString();
  const conversation = {
    ...saved,
    id: crypto.randomUUID(),
    title: QUESTION,
    createdAt: now,
    updatedAt: now,
    turns: [
      {
        ...turn,
        id: crypto.randomUUID(),
        at: now,
        question: QUESTION,
        answer: 'Ele conta lembranças da infância [1@0:00].',
        sources: [
          {
            ...track,
            n: 1,
            passages: [{ at: '0:00', startMs: 0, endMs: 1_000 }],
          },
        ],
      },
    ],
  };
  await openConversation(member, conversation);
}

test('KBC-156 AC-7: a citation saved on a 1 s fragment opens the whole sentences around it', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const owner = await ownerApi();
  const topic = await publishedTrack(owner, FRAGMENT_SPEECH);
  await owner.dispose();
  for (const viewport of viewports(page, info)) {
    const member = await researcher(page, topic, { viewport });
    await answerCitingTheFragment(member);
    await member
      .getByRole('link', { name: `Fonte 1, faixa ${TITLE}` })
      .first()
      .click();
    const panel = audioSource(member);
    await expect(panel).toBeVisible();
    // On a desktop "Citado na resposta · 0:00–0:07"; in the phone's sheet the span alone.
    const card = panel.getByRole('region', { name: /0:00–0:0[2-9]/ });
    await expect(card).toBeVisible();
    await expect(panel.getByRole('region', { name: /0:00–0:01$/ })).toHaveCount(
      0,
    );
    const quote = card.locator('blockquote');
    await expect(quote).toContainText('italiano');
    await expect(quote).toContainText('Meu pai veio da Itália');
    await expect(quote).toContainText('cresci na roça ouvindo as histórias');
    await expect(quote).not.toContainText('pêndulo');
    await shot(member, 'kbc156-whole-sentence');
    await member.context().close();
  }
});

/** KBC-160: sentences with their full stops, so the passage at 0:41 ends where its own does. */
const STOP_SPEECH = [
  { at: 2, text: 'Pergunta sobre o ritmo de tudo.' },
  { at: 41, text: 'O ritmo é a lei do pêndulo que tudo governa.' },
  { at: 50, text: 'Tudo flui para fora e para dentro.' },
  { at: 55, text: 'Outra pergunta sobre a polaridade.' },
];

/** A real research turn, saved again as the member's conversation citing the passage at 0:41. */
async function answerCitingThePassage(member: Page): Promise<void> {
  await ask(member);
  let saved: Conversation | undefined;
  await expect
    .poll(
      async () => {
        const list = await member.request.get(
          '/api/v1/conversations?kind=research',
        );
        const { items } = (await list.json()) as { items: { id: string }[] };
        const [first] = items;
        if (!first) return 0;
        const one = await member.request.get(
          `/api/v1/conversations/${first.id}`,
        );
        saved = (await one.json()) as Conversation;
        return saved.turns[0]?.sources.length ?? 0;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  const turn = saved?.turns[0];
  const track = turn?.sources.find((one) => one.media);
  if (!saved || !turn || !track) throw new Error('no track cited');
  const now = new Date().toISOString();
  const conversation = {
    ...saved,
    id: crypto.randomUUID(),
    title: QUESTION,
    createdAt: now,
    updatedAt: now,
    turns: [
      {
        ...turn,
        id: crypto.randomUUID(),
        at: now,
        question: QUESTION,
        answer: 'O pêndulo governa tudo [1@0:41].',
        sources: [
          {
            ...track,
            n: 1,
            passages: [{ at: '0:41', startMs: 41_000, endMs: 44_000 }],
          },
        ],
      },
    ],
  };
  await openConversation(member, conversation);
}

/** The citation opens the audio source: beside the answer, or in the phone's sheet. */
async function openTheSource(member: Page): Promise<Locator> {
  await member
    .getByRole('link', { name: `Fonte 1, faixa ${TITLE}, aos 41 segundos` })
    .first()
    .click();
  const panel = audioSource(member);
  await expect(panel.getByRole('heading', { name: TITLE })).toBeFocused();
  return panel;
}

/**
 * Where the passage ends, in ms: the card says it to the second ("0:41–0:43"), the track's
 * transcript to the millisecond (the end of a segment in that second).
 */
async function passageEndMs(member: Page, panel: Locator): Promise<number> {
  const name = await panel
    .getByRole('region', { name: /0:41–/ })
    .evaluate(
      (card) =>
        document.getElementById(card.getAttribute('aria-labelledby') ?? '')
          ?.textContent ?? '',
    );
  const [, minutes, seconds] = /0:41–(\d+):(\d\d)/.exec(name) ?? [];
  const second = (Number(minutes) * 60 + Number(seconds)) * 1000;
  const href = await panel
    .locator('a[href*="/midia/"]')
    .first()
    .getAttribute('href');
  const id = /\/midia\/([0-9a-f-]+)/.exec(href ?? '')?.[1];
  const read = await member.request.get(`/api/v1/media/${id}/transcript`);
  const { segments } = (await read.json()) as {
    segments: { endMs: number }[];
  };
  const end = segments
    .map(({ endMs }) => endMs)
    .find((endMs) => endMs >= second && endMs < second + 1_000);
  if (end === undefined) throw new Error(`no segment ends at ${name}`);
  return end;
}

const STOP_TOLERANCE_MS = 250;

test('KBC-160: "Ouvir o trecho" stops at the passage end; off, or after a seek out of it, the track plays on; the choice survives a reload', async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  const owner = await ownerApi();
  const topic = await publishedTrack(owner, STOP_SPEECH);
  await owner.dispose();
  for (const viewport of viewports(page, info)) {
    const member = await researcher(page, topic, { viewport });
    await answerCitingThePassage(member);
    let panel = await openTheSource(member);
    const card = panel.getByRole('region', { name: /0:41–/ });
    const toggle = card.getByRole('switch', { name: 'Parar no fim do trecho' });
    // AC-5, AC-9, AC-10: on for a new account, named, inside the card, a 44 px target.
    await expect(toggle).toBeChecked();
    const label = card.locator('label.stop-at-end');
    const cardBox = await card.boundingBox();
    const labelBox = await label.boundingBox();
    if (!cardBox || !labelBox) throw new Error('the card is not laid out');
    expect(labelBox.height).toBeGreaterThanOrEqual(44);
    expect(labelBox.x).toBeGreaterThanOrEqual(cardBox.x);
    expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(
      cardBox.x + cardBox.width,
    );
    // Reached by the keyboard after the card's last button, with its focus ring.
    await card.getByRole('button', { name: 'Copiar o link do trecho' }).focus();
    await member.keyboard.press('Tab');
    await expect(toggle).toBeFocused();
    expect(
      await toggle.evaluate((el) => getComputedStyle(el).outlineStyle),
    ).not.toBe('none');
    expect(await seriousAxe(member)).toEqual([]);
    await shot(member, 'kbc160-stop-on');
    const endMs = await passageEndMs(member, panel);

    // AC-1, AC-3, AC-9: from 2 s before; a seek inside keeps the stop; it pauses at the end.
    await panel.getByRole('button', { name: 'Ouvir o trecho' }).click();
    await expect.poll(() => playing(member)).toBe(true);
    await expect(card.getByText(/^Para às 0:4\d$/)).toBeVisible();
    await shot(member, 'kbc160-stop-armed');
    expect((await audioState(member)).currentTime).toBeLessThan(42);
    await seekTo(member, endMs / 1000 - 1.2);
    await expect.poll(() => playing(member), { timeout: 10_000 }).toBe(false);
    const stoppedAt = (await audioState(member)).currentTime * 1000;
    expect(Math.abs(stoppedAt - endMs)).toBeLessThanOrEqual(STOP_TOLERANCE_MS);
    await expect(
      member.getByText('Fim do trecho', { exact: true }),
    ).toBeAttached();
    await expect(card.getByText(/^Para às/)).toHaveCount(0);

    // AC-6 and AC-2: again, it starts 2 s before; a line after it plays on past the end.
    await panel.getByRole('button', { name: 'Ouvir o trecho' }).click();
    await expect.poll(() => playing(member)).toBe(true);
    expect((await audioState(member)).currentTime).toBeLessThan(42);
    await panel
      .getByRole('list', { name: 'Em volta do trecho' })
      .getByRole('button', { name: /^Ouvir a partir de/ })
      .last()
      .click();
    await expect
      .poll(async () => (await audioState(member)).currentTime, {
        timeout: 10_000,
      })
      .toBeGreaterThan(endMs / 1000 + 1);
    expect(await playing(member)).toBe(true);
    await expect(card.getByText(/^Para às/)).toHaveCount(0);
    await pauseOnTheControl(member, panel);

    // AC-4, BR-5: off, saved on the account; "Ouvir o trecho" plays on past the end.
    const saved = member.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname === '/api/v1/media/preferences',
    );
    await toggle.click();
    expect((await saved).status()).toBe(200);
    await expect(toggle).not.toBeChecked();
    await shot(member, 'kbc160-stop-off');
    await panel.getByRole('button', { name: 'Ouvir o trecho' }).click();
    await expect.poll(() => playing(member)).toBe(true);
    await expect(card.getByText(/^Para às/)).toHaveCount(0);
    await seekTo(member, endMs / 1000 - 1);
    await expect
      .poll(async () => (await audioState(member)).currentTime, {
        timeout: 10_000,
      })
      .toBeGreaterThan(endMs / 1000 + 1);
    expect(await playing(member)).toBe(true);
    await pauseOnTheControl(member, panel);

    // AC-4: the choice is the account's, read again after a reload.
    await member.reload();
    await showConversation(member);
    panel = await openTheSource(member);
    await expect(
      panel.getByRole('switch', { name: 'Parar no fim do trecho' }),
    ).not.toBeChecked();
    await member.context().close();
  }
});
