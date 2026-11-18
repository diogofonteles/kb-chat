import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { CSRF, expect, ownerApi, test } from './fixtures.js';
import { audioState } from './media-helpers.js';
import {
  TITLE,
  ask,
  audioSource,
  closeAudioSource,
  publishedTrack,
  researcher,
} from './research-tracks-helpers.js';

/*
 * KBC-099 (T22): a track published as a document of the collection is cited by the research
 * and opens on its passage. The whole path runs for real, kb aside: upload, transcript,
 * approved tracks cut by the E2E's worker, the track document rendered and queued, the E2E's
 * fake Mac (no kb binary, no model) writing it into the vault copy, the catalog, the stub
 * agent searching and reading it and citing "[1@0:41]". Since KBC-150 the passage opens in
 * the v2 audio source (beside the answer on a desktop, in the reading sheet on a phone) and
 * plays on the app's own player: media-audio-source.spec.ts walks every control.
 */

const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;
const shot = (page: Page, name: string) =>
  page.screenshot({
    path: `../work/KBC-099/evidence/${name}-${desktop(page) ? 1440 : 390}.png`,
  });

const seriousOf = (axe: Awaited<ReturnType<AxeBuilder['analyze']>>) =>
  axe.violations.filter((one) =>
    ['serious', 'critical'].includes(one.impact ?? ''),
  );

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
  // KBC-150 item 7: the wave pill with its number, then "título · tempo".
  await expect(citation).toHaveText(`1${TITLE} · 0:41`);
  const chip = answer.getByRole('button', { name: new RegExp(TITLE) });
  await expect(chip).toContainText('♪');
  await expect(chip).toContainText(/Palestra .*·\s*0:41/);
  await shot(member, 'answer');

  // Keyboard only (AC-12): Enter on the citation opens the source on its title.
  await citation.focus();
  await member.keyboard.press('Enter');
  const panel = audioSource(member);
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: TITLE })).toBeFocused();
  const cited = panel.locator('.line.cited-line');
  await expect(cited).toHaveCount(1);
  await expect(cited).toContainText('O ritmo é a lei do pêndulo');
  await expect(cited).toBeInViewport();
  await expect
    .poll(async () => (await audioState(member)).currentTime, {
      timeout: 15_000,
    })
    .toBeCloseTo(39, 0);
  expect((await audioState(member)).paused).toBe(true);
  const listen = panel.getByRole('button', { name: 'Ouvir o trecho' });
  await expect(listen).toBeVisible();
  // Tab from the title reaches "Ouvir o trecho" first (the cited passage comes first).
  for (let tabs = 0; tabs < 4; tabs += 1) {
    await member.keyboard.press('Tab');
    if (await listen.evaluate((button) => button === document.activeElement))
      break;
  }
  await expect(listen).toBeFocused();
  await shot(member, 'panel');

  const axe = await new AxeBuilder({ page: member })
    .include('app-track-passage-panel')
    .analyze();
  expect(seriousOf(axe)).toEqual([]);

  await member.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(citation).toBeFocused();
  await member.context().close();
});

test('AC-10, AC-11: "Ouvir o trecho" plays from 0:39 on the app’s player with the speech followed; 390 px fits', async ({
  page,
}) => {
  const owner = await ownerApi();
  const topic = await publishedTrack(owner);
  await owner.dispose();
  const member = await researcher(page, topic);
  const answer = await ask(member);
  await answer.getByRole('button', { name: new RegExp(TITLE) }).click();
  const panel = audioSource(member);
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
  // AC-11: nothing scrolls sideways; the cited passage comes before the speech around it.
  const overflow = await member.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  const [card, around] = await Promise.all([
    panel
      .getByRole('region', { name: /Citado na resposta|0:41–/ })
      .boundingBox(),
    panel.getByRole('list', { name: 'Em volta do trecho' }).boundingBox(),
  ]);
  expect(card?.y ?? 0).toBeLessThan(around?.y ?? 0);

  await panel.getByRole('button', { name: 'Ouvir o trecho' }).click();
  await expect
    .poll(async () => (await audioState(member)).currentTime, {
      timeout: 15_000,
    })
    .toBeGreaterThan(39.5);
  expect((await audioState(member)).currentTime).toBeLessThan(45);
  await expect(panel.locator('.line.now')).toBeVisible();
  // KBC-150 item 1: no player of its own; it plays on the bar (desktop) or the sheet's strip.
  await expect(panel.getByRole('slider')).toHaveCount(0);
  if (desktop(member))
    await expect(
      member.getByRole('region', { name: 'Mini-player' }),
    ).toBeVisible();
  else
    await expect(
      panel.getByText(/Tocando o trecho citado · 0:\d\d/),
    ).toBeVisible();
  await shot(member, 'playing');

  for (const theme of ['light', 'dark', 'esoteric']) {
    await member.evaluate(
      (value) => document.documentElement.setAttribute('data-theme', value),
      theme,
    );
    // The colours ease into the theme: axe reads them once they settled.
    await expect
      .poll(() => member.evaluate(() => document.getAnimations().length))
      .toBe(0);
    const axe = await new AxeBuilder({ page: member })
      .include('app-track-passage-panel')
      .analyze();
    expect(seriousOf(axe), theme).toEqual([]);
  }

  await closeAudioSource(member);
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
  const member = await researcher(page, topic, {
    features: ['search', 'research', 'media', 'media-tracks'],
  });
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
    ? member.getByRole('complementary', { name: 'Sua biblioteca' })
    : member.getByRole('dialog', { name: 'Menu' });
  await side
    .getByRole('navigation', { name: 'Conversas' })
    .getByRole('button', { name: /pêndulo/ })
    .first()
    .click();
  // On a phone the menu closes once the conversation is back. Its `close` event comes a task
  // after it is hidden and gives the focus back to "Menu": wait for it, or a focus the test
  // puts on the answer meanwhile is taken away and the Enter after it opens nothing.
  if (!desktop(member)) {
    await expect(side).toBeHidden();
    await expect(
      member.getByRole('button', { name: 'Menu', exact: true }),
    ).toBeFocused();
  }
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
  const panel = audioSource(member);

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
      .getByRole('complementary', { name: 'Sua biblioteca' })
      .getByRole('navigation', { name: 'Conversas' })
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
  const panel = audioSource(member);
  const href = await panel
    .getByRole('link', { name: 'Abrir a faixa' })
    .getAttribute('href');
  const trackId = /\/midia\/([^?]+)/.exec(href ?? '')?.[1];
  expect(trackId).toBeTruthy();
  await closeAudioSource(member);
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
    panel.getByRole('button', { name: 'Ouvir o trecho' }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole('list', { name: 'Em volta do trecho' }),
  ).toHaveCount(0);
  await shot(member, 'archived-r1');
  await panel.getByRole('button', { name: 'Fechar' }).last().click();
  await expect(panel).toBeHidden();
  await member.context().close();
});
