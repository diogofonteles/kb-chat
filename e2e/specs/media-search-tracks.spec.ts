import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Page } from '@playwright/test';
import {
  CSRF,
  expect,
  invite,
  ownerApi,
  pageWith,
  test,
  uniqueEmail,
} from './fixtures.js';
import {
  aCollectionInVault,
  audioState,
  uniqueTag,
  uploadReady,
} from './media-helpers.js';
import { approve, seedDraft } from './tracks-helpers.js';
import { rawOf, seedTranscript } from './transcript-helpers.js';

/*
 * KBC-101 (T2, T22): a track published as a document of the collection is a card of
 * "Buscar documentos" for who hears media and sees tracks, without the AI research. The
 * whole path runs for real, kb aside: upload, transcript, approved tracks cut by the E2E's
 * worker, the document written by the E2E's fake Mac (no kb binary, no model), the catalog,
 * the search, the card and the T22 panel with the player at −2 s, paused.
 */

const TITLE = 'O que é o ritmo?';
const SPEECH = [
  { at: 2, text: 'Pergunta sobre o ritmo de tudo' },
  { at: 41, text: 'O ritmo é a lei do pêndulo que tudo governa' },
  { at: 50, text: 'Tudo flui para fora e para dentro' },
  { at: 65, text: 'Outra pergunta sobre a polaridade' },
];

/** Waits for the real worker to cut and publish every track. */
async function published(owner: APIRequestContext, mediaId: string) {
  await expect
    .poll(
      async () => {
        const edit = await owner.get(`/api/v1/media/${mediaId}/edit`);
        return ((await edit.json()) as { preparation: unknown }).preparation;
      },
      { timeout: 60_000 },
    )
    .toBeNull();
}

/** A collection of its own with one recording, two tracks published through the Mac. */
async function publishedTrack(
  owner: APIRequestContext,
): Promise<{ topic: string; recording: string }> {
  const topic = await aCollectionInVault(owner);
  const recording = `Palestra ${uniqueTag()}`;
  const media = await uploadReady(owner, {
    title: recording,
    seconds: 90,
    topic,
  });
  await seedTranscript(owner, { id: media.id, raw: rawOf(SPEECH) });
  await seedDraft(owner, media.id, [
    { startMs: 0, endMs: 60_000, title: TITLE },
    { startMs: 60_000, endMs: 89_000, title: 'E a polaridade?' },
  ]);
  await approve(owner, media.id);
  await published(owner, media.id);
  const ran = await owner.post('/api/e2e/kb-publish/run', {
    data: { topic },
    headers: CSRF,
  });
  expect(ran.status(), await ran.text()).toBe(200);
  return { topic, recording };
}

type Theme = 'light' | 'dark' | 'esoteric';

/** A member of that collection only, who hears media and sees tracks (no AI research). */
async function listener(
  page: Page,
  topic: string,
  theme: Theme = 'light',
): Promise<Page> {
  const email = uniqueEmail('faixas-busca');
  const owner = await ownerApi();
  await invite(owner, email, {
    topics: [topic],
    features: ['search', 'media', 'media-tracks'],
  });
  await owner.dispose();
  const browser = page.context().browser();
  if (!browser) throw new Error('no browser');
  const member = await pageWith(browser, email, {
    viewport: page.viewportSize(),
    initScript: () => {
      localStorage.setItem('kb-chat.view', 'search');
    },
  });
  await member.addInitScript(
    (value) => localStorage.setItem('kb-chat.theme', value),
    theme,
  );
  await member.goto('/');
  const skip = member.getByRole('button', { name: 'Pular' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await expect(member.getByLabel('Sua pergunta')).toBeVisible();
  return member;
}

async function search(page: Page, question: string) {
  await page.getByLabel('Sua pergunta').fill(question);
  const send = page.getByRole('button', { name: 'Buscar' });
  await expect(send).toBeEnabled();
  await send.click();
  const message = page.locator('app-result-message').last();
  await expect(message.locator('.summary')).toContainText(/documento/, {
    timeout: 20_000,
  });
  return message;
}

const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;
const shot = (page: Page, name: string) =>
  page.screenshot({
    path: `../work/KBC-101/evidence/${name}-${test.info().project.name}.png`,
  });

const sideways = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );

test('AC-10, AC-15, AC-19: the track is one card among the documents; Enter opens the T22 at 0:41 with the player paused at 0:39; Esc gives the focus back', async ({
  page,
}) => {
  const owner = await ownerApi();
  const { topic, recording } = await publishedTrack(owner);
  await owner.dispose();
  const member = await listener(page, topic);
  const message = await search(member, 'pêndulo');

  const card = message.getByRole('button', {
    name: `Faixa de áudio, ${TITLE}, aos 41 segundos`,
  });
  await expect(card).toBeVisible();
  await expect(card).toContainText('♪');
  await expect(card).toContainText('Faixa');
  await expect(card).toContainText('0:41');
  await expect(card).toContainText(recording);
  await expect(card).toContainText('faixa 1 de 2');
  await expect(card.locator('mark')).toHaveText('pêndulo');
  // The name says what and when; the rest of the card is read as its description.
  await expect(card).toHaveAccessibleDescription(
    new RegExp(`${recording} · faixa 1 de 2 .*pêndulo`),
  );
  // One card per track: no "Na fala" card of it (BR-8), and the summary counts it once.
  await expect(message.locator('app-media-hit-card')).toHaveCount(0);
  await expect(message.locator('.summary')).toContainText(
    '1 documento (1 faixa)',
  );
  expect(await sideways(member)).toBeLessThanOrEqual(0);
  await shot(member, 'card');

  await card.focus();
  await member.keyboard.press('Enter');
  const panel = member.getByRole('dialog', {
    name: `Trecho da faixa ${TITLE}, aos 41 segundos`,
  });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: TITLE })).toBeFocused();
  const cited = panel.locator('.segment.cited');
  await expect(cited).toHaveCount(1);
  await expect(cited).toContainText('O ritmo é a lei do pêndulo');
  await expect
    .poll(async () => (await audioState(member)).currentTime, {
      timeout: 15_000,
    })
    .toBeCloseTo(39, 0);
  expect((await audioState(member)).paused).toBe(true);
  // AC-20: at 390 px the panel takes the whole screen, with nothing sideways.
  if (!desktop(member)) {
    const box = await panel.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(389);
    expect(await sideways(member)).toBeLessThanOrEqual(0);
  }
  await shot(member, 'panel');

  await member.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(card).toBeFocused();
  await member.context().close();
});

for (const theme of ['light', 'dark', 'esoteric'] as const)
  test(`NFR-4 (${theme}): the track card has no serious axe violation`, async ({
    page,
  }) => {
    test.skip(
      test.info().project.name !== 'media-desktop' && theme !== 'light',
      'the three themes once, at 1440 in Chrome',
    );
    const owner = await ownerApi();
    const { topic } = await publishedTrack(owner);
    await owner.dispose();
    const member = await listener(page, topic, theme);
    const message = await search(member, 'pêndulo');
    await expect(
      message.getByRole('button', { name: /Faixa de áudio/ }),
    ).toBeVisible();
    const axe = await new AxeBuilder({ page: member })
      .include('app-result-message')
      .analyze();
    expect(
      axe.violations.filter((one) =>
        ['serious', 'critical'].includes(one.impact ?? ''),
      ),
    ).toEqual([]);
    await shot(member, `card-${theme}`);
    await member.context().close();
  });

test('AC-13, AC-17: without media-tracks no track shows; "Textos" alone leaves the tracks out', async ({
  page,
}) => {
  const owner = await ownerApi();
  const { topic } = await publishedTrack(owner);
  const email = uniqueEmail('sem-faixas');
  await invite(owner, email, {
    topics: [topic],
    features: ['search', 'media'],
  });
  await owner.dispose();
  const browser = page.context().browser();
  if (!browser) throw new Error('no browser');
  const reader = await pageWith(browser, email, {
    viewport: page.viewportSize(),
    initScript: () => localStorage.setItem('kb-chat.view', 'search'),
  });
  await reader.goto('/');
  const skip = reader.getByRole('button', { name: 'Pular' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  const hidden = await search(reader, 'ritmo');
  await expect(
    hidden.getByRole('button', { name: /Faixa de áudio/ }),
  ).toHaveCount(0);
  await reader.context().close();

  const member = await listener(page, topic);
  const both = await search(member, 'ritmo');
  // Only the first track speaks of "ritmo" (the E2E's fake kb gives no summary).
  await expect(
    both.getByRole('button', { name: /Faixa de áudio/ }),
  ).toHaveCount(1);
  await both.getByRole('checkbox', { name: /Áudios/ }).uncheck();
  const texts = member.locator('app-result-message').last();
  await expect(
    texts.getByRole('button', { name: /Faixa de áudio/ }),
  ).toHaveCount(0);
  await member.context().close();
});
