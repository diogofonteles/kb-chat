import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Page } from '@playwright/test';
import { CSRF, expect, ownerApi } from './fixtures.js';
import {
  audioState,
  listenerTest as test,
  uniqueTag,
  uploadReady,
  useTheme,
} from './media-helpers.js';

// KBC-039: spoken passages in the free search, mixed with the documents, opening the
// player in the reading panel 2 s before the passage (audio only; video is KBC-075).

/** One spoken sentence at `at` seconds, as a transcriber's raw result. */
const rawOf = (at: number, text: string) => ({
  chunks: [
    {
      offset: 0,
      end: at + 10,
      result: {
        segments: [
          {
            start: at,
            end: at + 4,
            text: ` ${text}`,
            avg_logprob: -0.2,
            compression_ratio: 1.3,
            no_speech_prob: 0.01,
            words: text.split(' ').map((word, i) => ({
              word: ` ${word}`,
              start: at + i * 0.4,
              end: at + (i + 1) * 0.4,
              probability: 0.95,
            })),
          },
        ],
      },
    },
  ],
});

/**
 * A real audio whose transcript says `text` at `at` seconds: 8:20 long with the passage at
 * 08:15 for AC-1's talk, a few seconds otherwise (each audio is converted by the one worker).
 */
async function talkSaying(
  owner: APIRequestContext,
  input: { title: string; text: string; at?: number },
) {
  const at = input.at ?? 2;
  const media = await uploadReady(owner, {
    title: input.title,
    seconds: at + 5,
  });
  // The transcribe job is queued when the conversion ends.
  await expect
    .poll(
      async () =>
        (
          await owner.post(`/api/e2e/media/${media.id}/transcript`, {
            data: { raw: rawOf(at, input.text) },
            headers: CSRF,
          })
        ).status(),
      { timeout: 30_000 },
    )
    .toBe(204);
  return media;
}

/** Types the question in the box and sends it. */
async function ask(page: Page, question: string) {
  const box = page.getByRole('textbox', { name: 'Sua pergunta' });
  await box.fill(question);
  await box.press('Enter');
}

const passages = (page: Page) =>
  page.locator('app-result-message').last().locator('[data-media-id]');
const documents = (page: Page) =>
  page.locator('app-result-message').last().locator('[data-doc-id]');

const seriousViolations = async (page: Page) =>
  (await new AxeBuilder({ page }).analyze()).violations.filter((violation) =>
    ['serious', 'critical'].includes(violation.impact ?? ''),
  );

test('AC-1, AC-10: "tiuaco mariri" finds the passage at 8:15 and plays it from 8:13 in the reading panel', async ({
  page,
}) => {
  const tag = uniqueTag();
  const owner = await ownerApi();
  const { title } = await talkSaying(owner, {
    title: `Palestra do Tiuaco ${tag}`,
    text: `Tiuaco é Mariri ${tag}`,
    at: 495,
  });
  await owner.dispose();
  await page.goto('/');

  await ask(page, `tiuaco mariri ${tag}`);

  const card = passages(page);
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Áudio · Na fala');
  await expect(card).toContainText('8:15');
  await expect(card.locator('mark').first()).toHaveText('Tiuaco');
  await card.click();
  const panel = page.getByRole('dialog', { name: title });
  await expect(panel).toBeVisible();
  await expect(panel.locator('blockquote')).toContainText(
    `Tiuaco é Mariri ${tag}`,
  );
  await expect(panel.getByRole('slider', { name: 'Posição' })).toBeVisible();
  await expect
    .poll(async () => (await audioState(page)).currentTime, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(493);
  expect((await audioState(page)).currentTime).toBeLessThan(500);
  await expect(card).toHaveAttribute('aria-pressed', 'true');
  await expect(
    panel.getByRole('link', { name: 'Abrir na página da mídia' }),
  ).toHaveAttribute('href', /\?t=493$/);
});

test('AC-9: without "Textos" only the passage shows; with it again both, mixed', async ({
  page,
}) => {
  const tag = uniqueTag();
  const owner = await ownerApi();
  await talkSaying(owner, {
    title: `Sobre o ritmo ${tag}`,
    text: `O ritmo da vida ${tag}`,
  });
  await owner.dispose();
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('kb-chat.search-kinds'));

  await ask(page, `ritmo ${tag}`);
  await expect(passages(page)).toHaveCount(1);
  const reach = page.getByRole('group', { name: 'Buscar em' });
  await expect(reach).toBeVisible();
  const texts = reach.getByRole('checkbox', { name: /Textos/ });
  const audios = reach.getByRole('checkbox', { name: /Áudios/ });
  await expect(documents(page)).not.toHaveCount(0);

  await texts.uncheck();
  await expect(documents(page)).toHaveCount(0);
  await expect(passages(page)).toHaveCount(1);
  await expect(audios).toBeDisabled();

  await texts.check();
  await expect(documents(page)).not.toHaveCount(0);
  await expect(passages(page)).toHaveCount(1);
  await expect(audios).toBeEnabled();
});

for (const theme of ['light', 'dark', 'esoteric'] as const) {
  test(`AC-8: the passages and the reading panel pass axe in the ${theme} theme, without sideways scrolling`, async ({
    page,
  }) => {
    const tag = uniqueTag();
    const owner = await ownerApi();
    const { title } = await talkSaying(owner, {
      title: `Palestra ${theme} ${tag}`,
      text: `A Hoasca era conselheira ${tag}`,
    });
    await owner.dispose();
    await useTheme(page, theme);
    await page.goto('/');

    await ask(page, `hoasca ${tag}`);
    await expect(passages(page)).toHaveCount(1);
    expect(await seriousViolations(page)).toEqual([]);
    await passages(page).click();
    await expect(page.getByRole('dialog', { name: title })).toBeVisible();
    await expect(page.getByRole('slider', { name: 'Posição' })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
    const panel = page.getByRole('dialog', { name: title });
    await panel.getByRole('button', { name: /Fechar/ }).click();
    await expect(panel).toBeHidden();
  });
}
