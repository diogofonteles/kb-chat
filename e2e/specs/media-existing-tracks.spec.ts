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
import { aCollection, uniqueTag, uploadReady } from './media-helpers.js';
import { approve, seedDraft } from './tracks-helpers.js';
import { rawOf, seedTranscript } from './transcript-helpers.js';

/*
 * KBC-099 AC-16 (the owner's scope of 2026-11-06): tracks published before the track
 * documents existed reach the collection when a master asks, in Transcritores. The fake Mac
 * of the E2E server plays kb (no binary, no model, no spend).
 */

const SPEECH = [
  { at: 2, text: 'Pergunta sobre o ritmo de tudo' },
  { at: 41, text: 'O ritmo é a lei do pêndulo que tudo governa' },
  { at: 65, text: 'Outra pergunta sobre a polaridade' },
];

const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

/** A collection of its own with two tracks published "before KBC-099": no document. */
async function oldTracks(owner: APIRequestContext): Promise<string> {
  const topic = await aCollection(owner);
  const media = await uploadReady(owner, {
    title: `Palestra ${uniqueTag()}`,
    seconds: 90,
    topic,
  });
  await seedTranscript(owner, { id: media.id, raw: rawOf(SPEECH) });
  await seedDraft(owner, media.id, [
    { startMs: 0, endMs: 60_000, title: 'O que é o ritmo?' },
    { startMs: 60_000, endMs: 89_000, title: 'E a polaridade?' },
  ]);
  await approve(owner, media.id);
  await expect
    .poll(
      async () => {
        const edit = await owner.get(`/api/v1/media/${media.id}/edit`);
        return ((await edit.json()) as { preparation: unknown }).preparation;
      },
      { timeout: 60_000 },
    )
    .toBeNull();
  const forgot = await owner.post('/api/e2e/kb-publish/forget', {
    data: { topic },
    headers: CSRF,
  });
  expect(forgot.status()).toBe(204);
  return topic;
}

async function titleOf(owner: APIRequestContext, topic: string) {
  const topics = await owner.get('/api/v1/topics');
  const items = (
    (await topics.json()) as {
      items: { slug: string; title: string }[];
    }
  ).items;
  const title = items.find((one) => one.slug === topic)?.title;
  if (!title) throw new Error(`no title for ${topic}`);
  return title;
}

async function openTranscribers(page: Page) {
  if (!desktop(page))
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('button', { name: 'Configurações' }).click();
  const dialog = page.getByRole('dialog', { name: 'Configurações' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Transcritores' }).click();
  const section = dialog.getByRole('region', {
    name: 'Faixas que já existem',
  });
  await expect(section).toBeVisible();
  return { dialog, section };
}

test('AC-16: a master publishes the tracks that already exist, sees the count and the cost first, then the progress', async ({
  page,
}) => {
  const owner = await ownerApi();
  const topic = await oldTracks(owner);
  const title = await titleOf(owner, topic);
  await page.goto('/biblioteca');
  const { section } = await openTranscribers(page);

  await section
    .getByRole('button', {
      name: 'Publicar no acervo as faixas que já existem',
    })
    .click();
  // Only this spec's collection: the others belong to other specs.
  const mine = `${title} · 2 faixas a publicar`;
  await expect(section.getByRole('checkbox', { name: mine })).toBeVisible();
  for (const box of await section.getByRole('checkbox').all()) {
    const label = await box.evaluate(
      (input) => input.closest('label')?.textContent?.trim() ?? '',
    );
    if (!label.startsWith(`${title} ·`)) await box.uncheck();
  }
  await expect(section.getByRole('checkbox', { name: mine })).toBeChecked();
  await expect(section).toContainText(
    '2 faixas · custo estimado do kb ≈ US$ 0,002',
  );
  await expect(section).toContainText('do teto mensal da mídia');
  await page.screenshot({
    path: `../work/KBC-099/evidence/existing-tracks-choice-${desktop(page) ? 1440 : 390}.png`,
  });
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);

  // PD-02: a same-frame double click sends exactly one request.
  const posts: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      request.url().endsWith('/api/v1/media/track-documents/publish')
    )
      posts.push(request.url());
  });
  await section
    .getByRole('button', { name: 'Publicar 2 faixas' })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  await expect(section.getByRole('status')).toHaveText(
    '2 faixas na fila para o Mac.',
  );
  await expect(section).toContainText(
    `${title}: 2 na fila · 0 publicadas · 0 falharam`,
  );
  expect(posts).toHaveLength(1);
  // PD-01: the action may go once all is queued; the focus stays on the section.
  await expect(
    section.getByRole('heading', { name: 'Faixas que já existem' }),
  ).toBeFocused();

  const ran = await owner.post('/api/e2e/kb-publish/run', {
    data: { topic },
    headers: CSRF,
  });
  expect(((await ran.json()) as { documents: number }).documents).toBe(2);
  await page.reload();
  const again = await openTranscribers(page);
  await expect(again.section).toContainText(
    `${title}: 0 na fila · 2 publicadas · 0 falharam`,
  );
  await page.screenshot({
    path: `../work/KBC-099/evidence/existing-tracks-progress-${desktop(page) ? 1440 : 390}.png`,
  });

  // Idempotent: asking again queues nothing.
  const twice = await owner.post('/api/v1/media/track-documents/publish', {
    data: { topics: [topic] },
    headers: CSRF,
  });
  expect(await twice.json()).toEqual({ queued: 0, skipped: 2 });
  await owner.dispose();
});

test('QA F-13: a failed publish says so and gives the focus back to the confirm button, never to the page (WCAG 2.4.3)', async ({
  page,
}) => {
  // The overview and the failure are this test's own: no shared collection is touched.
  await page.route('**/api/v1/media/track-documents', (route) =>
    route.fulfill({
      json: {
        usdPerTrack: 0.001,
        remainingUsd: 9.5,
        collections: [
          {
            topic: 'falha-simulada',
            title: 'Falha simulada',
            tracks: 2,
            toPublish: 2,
            queued: 0,
            published: 0,
            failed: 0,
          },
        ],
      },
    }),
  );
  let posts = 0;
  await page.route('**/api/v1/media/track-documents/publish', (route) => {
    posts += 1;
    return route.fulfill({
      status: 500,
      json: { error: { code: 'INTERNAL', message: 'simulated' } },
    });
  });
  await page.goto('/biblioteca');
  const { section } = await openTranscribers(page);
  await section
    .getByRole('button', {
      name: 'Publicar no acervo as faixas que já existem',
    })
    .click();
  const confirm = section.getByRole('button', { name: 'Publicar 2 faixas' });
  await confirm.focus();
  await page.keyboard.press('Enter');
  await expect(section.getByRole('status')).toHaveText(
    'Não foi possível publicar. Tente de novo.',
  );
  await expect(confirm).toBeEnabled();
  await expect(confirm).toBeFocused();
  expect(posts).toBe(1);
  // Trying again from the keyboard sends one more request.
  await page.keyboard.press('Enter');
  await expect.poll(() => posts).toBe(2);
  await expect(confirm).toBeFocused();
});

test('AC-16: a member, even with every media permission, has no action and the API refuses (403)', async ({
  page,
}) => {
  const email = uniqueEmail('faixas-existentes');
  const owner = await ownerApi();
  await invite(owner, email, {
    topics: ['hermetismo'],
    features: [
      'search',
      'research',
      'media',
      'media-tracks',
      'media-research',
      'media-edit',
    ],
  });
  await owner.dispose();
  const browser = page.context().browser();
  if (!browser) throw new Error('no browser');
  const member = await pageAs(browser, email, page.viewportSize());
  await member.goto('/');
  expect(
    (await member.request.get('/api/v1/media/track-documents')).status(),
  ).toBe(403);
  expect(
    (
      await member.request.post('/api/v1/media/track-documents/publish', {
        data: { topics: ['hermetismo'] },
        headers: CSRF,
      })
    ).status(),
  ).toBe(403);
  await member.context().close();
});
