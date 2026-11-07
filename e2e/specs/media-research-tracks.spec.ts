import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Page } from '@playwright/test';
import {
  CSRF,
  expect,
  invite,
  ownerApi,
  pageAs,
  test,
  uniqueEmail,
} from './fixtures.js';
import {
  aCollection,
  audioState,
  uniqueTag,
  uploadReady,
} from './media-helpers.js';
import { approve, seedDraft } from './tracks-helpers.js';
import { rawOf, seedTranscript } from './transcript-helpers.js';

/*
 * KBC-099 (T22): a track published as a document of the collection is cited by the research
 * and opens on its passage with the player beside it. The whole path runs for real, kb aside:
 * upload, transcript, approved tracks cut by the E2E's worker, the track document rendered
 * and queued, the E2E's fake Mac (no kb binary, no model) writing it into the vault copy, the
 * catalog, the stub agent searching and reading it and citing "[1@0:41]".
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
async function publishedTrack(owner: APIRequestContext): Promise<string> {
  const topic = await aCollection(owner);
  const media = await uploadReady(owner, {
    title: `Palestra ${uniqueTag()}`,
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
  expect(((await ran.json()) as { documents: number }).documents).toBe(2);
  return topic;
}

/** A researcher of that collection only, with the tracks (FR-10). */
async function researcher(
  page: Page,
  topic: string,
  features = ['search', 'research', 'media', 'media-tracks', 'media-research'],
): Promise<Page> {
  const email = uniqueEmail('faixas');
  const owner = await ownerApi();
  await invite(owner, email, { topics: [topic], features });
  await owner.dispose();
  const browser = page.context().browser();
  if (!browser) throw new Error('no browser');
  const member = await pageAs(browser, email, page.viewportSize());
  await member.goto('/');
  const skip = member.getByRole('button', { name: 'Pular' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await expect(member.getByLabel('Sua pergunta')).toBeVisible();
  return member;
}

async function ask(page: Page) {
  await page.getByLabel('Sua pergunta').fill('pêndulo');
  await page.getByRole('button', { name: 'Perguntar' }).click();
  const answer = page.locator('app-research-message').last();
  await expect(answer.getByText(/Resposta gerada por IA/)).toBeVisible({
    timeout: 30_000,
  });
  return answer;
}

const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;
const shot = (page: Page, name: string) =>
  page.screenshot({
    path: `../work/KBC-099/evidence/${name}-${desktop(page) ? 1440 : 390}.png`,
  });

test('AC-5, AC-8, AC-9, AC-12: [1@0:41] opens the passage, the player paused at 0:39; Esc gives the focus back', async ({
  page,
}) => {
  const owner = await ownerApi();
  const topic = await publishedTrack(owner);
  await owner.dispose();
  const member = await researcher(page, topic);
  const answer = await ask(member);

  const citation = answer.getByRole('link', {
    name: `Fonte 1, faixa ${TITLE}, aos 41 segundos`,
  });
  await expect(citation).toHaveText('[1]');
  const chip = answer.getByRole('button', { name: new RegExp(TITLE) });
  await expect(chip).toContainText('♪');
  await expect(chip).toContainText(/Palestra .*·\s*0:41/);
  await shot(member, 'answer');

  // Keyboard only (AC-12): Enter on the citation opens the panel on its title.
  await citation.focus();
  await member.keyboard.press('Enter');
  const panel = member.getByRole('dialog', {
    name: `Trecho da faixa ${TITLE}, aos 41 segundos`,
  });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: TITLE })).toBeFocused();
  const cited = panel.locator('.segment.cited');
  await expect(cited).toHaveCount(1);
  await expect(cited).toContainText('O ritmo é a lei do pêndulo');
  await expect(cited).toBeInViewport();
  await expect
    .poll(async () => (await audioState(member)).currentTime, {
      timeout: 15_000,
    })
    .toBeCloseTo(39, 0);
  expect((await audioState(member)).paused).toBe(true);
  const play = panel.getByRole('button', { name: 'Tocar', exact: true });
  await expect(play).toBeVisible();
  // Tab from the title reaches Tocar through the player's own controls (T22 flow 2).
  for (let tabs = 0; tabs < 4; tabs += 1) {
    await member.keyboard.press('Tab');
    if (await play.evaluate((button) => button === document.activeElement))
      break;
  }
  await expect(play).toBeFocused();
  await shot(member, 'panel');

  const axe = await new AxeBuilder({ page: member })
    .include('app-track-passage-panel')
    .analyze();
  expect(
    axe.violations.filter((one) =>
      ['serious', 'critical'].includes(one.impact ?? ''),
    ),
  ).toEqual([]);

  await member.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(citation).toBeFocused();
  await member.context().close();
});

test('AC-10, AC-11: Tocar plays from 0:39 with the words followed; the mini-player waits for the panel to close; 390 px fits', async ({
  page,
}) => {
  const owner = await ownerApi();
  const topic = await publishedTrack(owner);
  await owner.dispose();
  const member = await researcher(page, topic);
  const answer = await ask(member);
  await answer.getByRole('button', { name: new RegExp(TITLE) }).click();
  const panel = member.getByRole('dialog', {
    name: new RegExp(`Trecho da faixa ${TITLE}`),
  });
  await expect(panel).toBeVisible();

  // Beside the panel, the chip shrinks into the conversation's column (PD-12).
  if (desktop(member)) {
    const [chipBox, threadBox] = await Promise.all([
      answer.getByRole('button', { name: new RegExp(TITLE) }).boundingBox(),
      member.getByRole('region', { name: 'Conversa' }).boundingBox(),
    ]);
    expect((chipBox?.x ?? 0) + (chipBox?.width ?? 0)).toBeLessThanOrEqual(
      (threadBox?.x ?? 0) + (threadBox?.width ?? 0) + 1,
    );
  }
  // AC-11: nothing scrolls sideways, and on a phone the player sits above the transcript.
  const overflow = await member.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  const player = panel.getByRole('region', { name: 'Player' });
  const transcript = panel.getByRole('list', {
    name: 'Trechos da transcrição',
  });
  const [top, list] = await Promise.all([
    player.boundingBox(),
    transcript.boundingBox(),
  ]);
  if (!desktop(member)) expect(top?.y ?? 0).toBeLessThan(list?.y ?? 0);
  else expect(top?.x ?? 0).toBeGreaterThan(list?.x ?? 0);

  await panel.getByRole('button', { name: 'Tocar', exact: true }).click();
  await expect
    .poll(async () => (await audioState(member)).currentTime, {
      timeout: 15_000,
    })
    .toBeGreaterThan(39.5);
  expect((await audioState(member)).currentTime).toBeLessThan(45);
  await expect(panel.locator('.segment.active')).toBeVisible();
  await expect(member.getByRole('region', { name: 'Mini-player' })).toHaveCount(
    0,
  );
  await shot(member, 'playing');

  for (const theme of ['light', 'dark', 'esoteric'])
    await member
      .evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme,
      )
      .then(async () => {
        const axe = await new AxeBuilder({ page: member })
          .include('app-track-passage-panel')
          .analyze();
        expect(
          axe.violations.filter((one) =>
            ['serious', 'critical'].includes(one.impact ?? ''),
          ),
          theme,
        ).toEqual([]);
      });

  await panel
    .getByRole('button', { name: /Fechar/ })
    .first()
    .click();
  await expect(panel).toBeHidden();
  await expect(
    member.getByRole('region', { name: 'Mini-player' }),
  ).toBeVisible();
  await member.context().close();
});

test('AC-6: without "Pesquisar faixas com IA" the same question finds no track', async ({
  page,
}) => {
  const owner = await ownerApi();
  const topic = await publishedTrack(owner);
  await owner.dispose();
  const member = await researcher(page, topic, [
    'search',
    'research',
    'media',
    'media-tracks',
  ]);
  const answer = await ask(member);
  await expect(answer.getByText(/não encontrei documentos/)).toBeVisible();
  await expect(
    answer.getByRole('button', { name: new RegExp(TITLE) }),
  ).toHaveCount(0);
  await member.context().close();
});

/** Opens the conversation again from Histórico after a reload, as a returning reader does. */
async function reopenFromHistory(member: Page) {
  await member.reload();
  const skip = member.getByRole('button', { name: 'Pular' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  if (!desktop(member))
    await member.getByRole('button', { name: 'Menu', exact: true }).click();
  const side = desktop(member)
    ? member.getByRole('complementary', { name: 'Lateral' })
    : member.getByRole('dialog', { name: 'Menu' });
  await side
    .getByRole('navigation', { name: 'Histórico' })
    .getByRole('button', { name: /pêndulo/ })
    .first()
    .click();
  // On a phone the menu closes once the conversation is back.
  if (!desktop(member)) await expect(side).toBeHidden();
  return member.locator('app-research-message').last();
}

test('AC-12 (QA BUG-2): in a conversation reopened from the history, Esc gives the focus back to the citation and to the chip', async ({
  page,
}) => {
  const owner = await ownerApi();
  const topic = await publishedTrack(owner);
  await owner.dispose();
  const member = await researcher(page, topic);
  await ask(member);
  const answer = await reopenFromHistory(member);
  const panel = member.getByRole('dialog', {
    name: new RegExp(`Trecho da faixa ${TITLE}`),
  });

  const citation = answer.getByRole('link', {
    name: `Fonte 1, faixa ${TITLE}, aos 41 segundos`,
  });
  await citation.focus();
  await member.keyboard.press('Enter');
  await expect(panel).toBeVisible();
  await expect
    .poll(async () => (await audioState(member)).currentTime, {
      timeout: 15_000,
    })
    .toBeCloseTo(39, 0);
  if (desktop(member)) {
    // The race QA saw, made certain: the history brings the same conversation back while
    // the panel is open, so the answer (and the citation pressed) is drawn anew.
    await member
      .getByRole('complementary', { name: 'Lateral' })
      .getByRole('navigation', { name: 'Histórico' })
      .getByRole('button', { name: /pêndulo/ })
      .first()
      .click();
    await expect(panel).toBeVisible();
    await panel.getByRole('heading', { name: TITLE }).focus();
  }
  await member.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(citation).toBeFocused();

  const chip = answer.getByRole('button', { name: new RegExp(TITLE) });
  await chip.focus();
  await member.keyboard.press('Enter');
  await expect(panel).toBeVisible();
  await member.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(chip).toBeFocused();
  await member.context().close();
});

test('T22 (QA BUG-1): a track archived after the answer does not open from it: "Esta faixa não está mais disponível."', async ({
  page,
}) => {
  const owner = await ownerApi();
  const topic = await publishedTrack(owner);
  const member = await researcher(page, topic);
  const answer = await ask(member);
  const chip = answer.getByRole('button', { name: new RegExp(TITLE) });
  await chip.click();
  const panel = member.getByRole('dialog', {
    name: new RegExp(`Trecho da faixa ${TITLE}`),
  });
  const href = await panel
    .getByRole('link', { name: 'Abrir na página da faixa' })
    .getAttribute('href');
  const trackId = /\/midia\/([^?]+)/.exec(href ?? '')?.[1];
  expect(trackId).toBeTruthy();
  await panel
    .getByRole('button', { name: /Fechar/ })
    .first()
    .click();
  await expect(panel).toBeHidden();
  const archived = await owner.delete(`/api/v1/media/${trackId}`, {
    headers: CSRF,
  });
  expect(archived.status(), await archived.text()).toBe(204);
  await owner.dispose();

  await chip.click();
  await expect(
    panel.getByText('Esta faixa não está mais disponível.'),
  ).toBeVisible();
  await expect(
    panel.getByRole('button', { name: 'Tocar', exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole('list', { name: 'Trechos da transcrição' }),
  ).toHaveCount(0);
  await shot(member, 'archived-r1');
  await panel.getByRole('button', { name: 'Fechar' }).last().click();
  await expect(panel).toBeHidden();
  await member.context().close();
});
