import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
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
 * KBC-114: a collection made on the screen (no vault folder) shows masters the
 * transcriptions that are not documents yet and publishes them; the fake Mac of the E2E
 * server makes the folder as `kb topic new` would. The transcriber's status chip opens its
 * details; off, it says how to turn it on ("Ligar transcritor" runs a fake launchctl here).
 */

const SPEECH = [
  { at: 2, text: 'Pergunta sobre o ritmo de tudo' },
  { at: 41, text: 'O ritmo é a lei do pêndulo que tudo governa' },
  { at: 65, text: 'Outra pergunta sobre a polaridade' },
];

const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;
const widthOf = (page: Page) => (desktop(page) ? 1440 : 390);
const shot = (page: Page, name: string) =>
  page.screenshot({
    path: `../work/KBC-114/evidence/${name}-${widthOf(page)}-${test.info().project.name}.png`,
  });

async function noSideScroll(page: Page): Promise<void> {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
}

async function seriousViolations(page: Page) {
  return (await new AxeBuilder({ page }).analyze()).violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? ''),
  );
}

/** A collection made on the screen with two approved tracks and no document yet. */
async function screenCollectionWithTracks(
  owner: APIRequestContext,
): Promise<{ topic: string; title: string }> {
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
  // As a database from before KBC-114 left them: pending, no job.
  const forgot = await owner.post('/api/e2e/kb-publish/forget', {
    data: { topic },
    headers: CSRF,
  });
  expect(forgot.status()).toBe(204);
  const topics = (await (await owner.get('/api/v1/topics')).json()) as {
    items: { slug: string; title: string }[];
  };
  const title = topics.items.find((one) => one.slug === topic)?.title;
  if (!title) throw new Error(`no title for ${topic}`);
  return { topic, title };
}

test('QA F-3, AC-9: a member, even with every media permission, sees no pending notice nor status', async ({
  page,
}) => {
  const owner = await ownerApi();
  const { topic, title } = await screenCollectionWithTracks(owner);
  const email = uniqueEmail('membro-pendentes');
  await invite(owner, email, {
    topics: [topic],
    features: ['search', 'research', 'media', 'media-edit', 'media-tracks'],
  });
  const browser = page.context().browser();
  if (!browser) throw new Error('no browser');
  const member = await pageAs(browser, email, page.viewportSize());
  const asked: string[] = [];
  member.on('request', (request) => {
    if (/track-documents|transcribers\/status/.test(request.url()))
      asked.push(request.url());
  });
  await member.goto('/');
  // A new member meets the welcome first (the mobile menu sits under it).
  const skip = member.getByRole('button', { name: 'Pular' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await openCollection(member, title);
  await expect(member.getByLabel('Sua pergunta')).toBeVisible();
  await expect(member.locator('app-pending-transcriptions')).toHaveCount(0);
  await expect(member.getByText(/transcrições ainda não são/)).toHaveCount(0);
  expect(asked).toEqual([]);
  await member.context().close();
  await owner.dispose();
});

test('AC-16: the preparation page shows the transcriber status beside its steps', async ({
  page,
}) => {
  const owner = await ownerApi();
  const topic = await aCollection(owner);
  const media = await uploadReady(owner, {
    title: `Palestra ${uniqueTag()}`,
    seconds: 30,
    topic,
  });
  await page.goto(`/midia/${media.id}/preparar`);
  const chip = page
    .locator('app-preparation-page')
    .getByRole('button', { name: /^Transcritor|^Nenhum transcritor/ });
  await expect(chip).toBeVisible();
  await noSideScroll(page);
  await shot(page, 'preparation-status');
  await chip.click();
  await expect(page.getByRole('dialog').last()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(chip).toBeFocused();
  await owner.dispose();
});

async function sidebar(page: Page): Promise<Locator> {
  const drawer = page.getByRole('dialog', { name: 'Menu' });
  if (!desktop(page) && !(await drawer.isVisible()))
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
  return desktop(page)
    ? page.getByRole('complementary', { name: 'Lateral' })
    : drawer;
}

async function openCollection(page: Page, title: string): Promise<void> {
  const select = (await sidebar(page)).getByRole('combobox', {
    name: 'Acervo',
    exact: true,
  });
  // The list comes with the page: wait for this test's collection in it.
  let label: string | undefined;
  await expect
    .poll(async () => {
      label = (await select.locator('option').allTextContents())
        .map((text) => text.trim())
        .find((text) => text.startsWith(title));
      return label;
    })
    .toBeTruthy();
  if (!label) throw new Error(`no option for ${title}`);
  await select.selectOption({ label });
  if (!desktop(page)) await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(title);
}

test('AC-9: a master sees the transcriptions that are not documents yet, publishes them, and the Mac makes the collection', async ({
  page,
}) => {
  const owner = await ownerApi();
  const { topic, title } = await screenCollectionWithTracks(owner);
  await page.goto('/');
  await openCollection(page, title);

  const notice = page.locator('app-pending-transcriptions');
  await expect(notice).toContainText(
    '2 transcrições ainda não são documentos deste acervo',
  );
  await expect(notice).toContainText('Custo estimado do kb ≈ US$ 0,002');
  await expect(
    notice.getByRole('button', { name: /^Transcritor|^Nenhum/ }),
  ).toBeVisible();
  await noSideScroll(page);
  expect(await seriousViolations(page)).toEqual([]);
  await shot(page, 'pending-notice');

  // PD-02: a same-frame double click sends exactly one request.
  const posts: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      request.url().endsWith('/api/v1/media/track-documents/publish')
    )
      posts.push(request.url());
  });
  await notice
    .getByRole('button', { name: 'Publicar no acervo' })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  await expect(notice.getByRole('status')).toContainText('Publicação pedida');
  await expect(notice).toContainText('2 transcrições na fila para o Mac.');
  expect(posts).toHaveLength(1);
  await shot(page, 'pending-queued');

  // The Mac takes the job: it makes the collection's folder, then writes the documents.
  const ran = await owner.post('/api/e2e/kb-publish/run', {
    data: { topic },
    headers: CSRF,
  });
  expect(((await ran.json()) as { documents: number }).documents).toBe(2);
  const overview = (await (
    await owner.get('/api/v1/media/track-documents')
  ).json()) as {
    collections: { topic: string; toPublish: number; published: number }[];
  };
  expect(overview.collections.find((one) => one.topic === topic)).toMatchObject(
    { toPublish: 0, published: 2 },
  );
  await page.reload();
  await openCollection(page, title);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(title);
  await expect(page.locator('app-pending-transcriptions')).not.toContainText(
    'ainda não são documentos',
  );
  await owner.dispose();
});

/** A transcriber of this test only, marked for voice prints alone and seen long ago, so no
 * other spec running beside it sees a Mac on for transcriptions or track documents. */
async function aTranscriber(
  owner: APIRequestContext,
  name: string,
): Promise<{ id: string; token: string; name: string }> {
  const full = `${name} ${uniqueTag()}`;
  const paired = await owner.post('/api/v1/media/transcribers', {
    data: { name: full },
    headers: CSRF,
  });
  expect(paired.status(), await paired.text()).toBe(201);
  const body = (await paired.json()) as {
    token: string;
    transcriber: { id: string };
  };
  const id = body.transcriber.id;
  const marked = await owner.patch(`/api/v1/media/transcribers/${id}`, {
    data: { kinds: ['voice-profile'] },
    headers: CSRF,
  });
  expect(marked.status()).toBe(200);
  return { id, token: body.token, name: full };
}

async function longAgo(owner: APIRequestContext, id: string): Promise<void> {
  const aged = await owner.post('/api/e2e/transcribers/last-seen', {
    data: { id, hoursAgo: 2 },
    headers: CSRF,
  });
  expect(aged.status()).toBe(204);
}

async function sendStatus(
  owner: APIRequestContext,
  mac: { id: string; token: string },
): Promise<void> {
  const sent = await owner.post('/api/v1/media-worker/status', {
    headers: { ...CSRF, authorization: `Bearer ${mac.token}` },
    data: {
      state: 'working',
      detail: null,
      version: '0.1.0 (2026-10-28.1)',
      kinds: ['transcribe', 'kb-publish'],
      startedAt: new Date(Date.now() - 600_000).toISOString(),
      currentJob: {
        id: '11111111-1111-4111-8111-111111111111',
        kind: 'kb-publish',
        label: 'publicando udv (3 documentos)',
        startedAt: new Date().toISOString(),
        progress: 40,
      },
      recentJobs: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          kind: 'kb-publish',
          label: 'publicando hermetismo (2 documentos)',
          outcome: 'failed',
          finishedAt: new Date(Date.now() - 60_000).toISOString(),
          detail: 'kb classify: OpenRouter 502',
        },
      ],
      lastError: {
        at: new Date(Date.now() - 60_000).toISOString(),
        message: 'kb classify: OpenRouter 502',
      },
      counts: { done: 2, failed: 1 },
      vaultPath: '/Users/dono/dev/personal/hermetismo',
      kbVersion: '0.0.12 (commit=1297f06)',
    },
  });
  expect(sent.status(), await sent.text()).toBe(204);
  // Seen by the status call: back to long ago at once (other specs run beside this one).
  await longAgo(owner, mac.id);
}

async function openTranscribers(page: Page): Promise<Locator> {
  if (!desktop(page))
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('button', { name: 'Configurações' }).click();
  const dialog = page.getByRole('dialog', { name: 'Configurações' });
  await dialog.getByRole('button', { name: 'Transcritores' }).click();
  return dialog;
}

test('AC-12, AC-13, AC-14: the status chip opens the details, and an off transcriber says how to turn it on', async ({
  page,
}) => {
  const owner = await ownerApi();
  const working = await aTranscriber(owner, 'Mac trabalhando');
  const off = await aTranscriber(owner, 'Mac desligado');
  await longAgo(owner, off.id);
  try {
    await sendStatus(owner, working);
    await page.goto('/');
    const settings = await openTranscribers(page);
    const row = settings
      .getByRole('listitem')
      .filter({ hasText: working.name });
    const chip = row.getByRole('button', {
      name: 'Transcritor: Trabalhando, no acervo: publicando udv (3 documentos) (40%)',
    });
    await expect(chip).toBeVisible();
    await noSideScroll(page);

    // Keyboard only: Enter opens, Esc closes, the focus goes back to the chip.
    await chip.focus();
    await page.keyboard.press('Enter');
    const details = page.getByRole('dialog', {
      name: `Transcritor "${working.name}"`,
    });
    await expect(details).toBeVisible();
    await expect(details).toContainText('/Users/dono/dev/personal/hermetismo');
    await expect(details).toContainText('0.0.12 (commit=1297f06)');
    await expect(details).toContainText('kb classify: OpenRouter 502');
    await expect(details).toContainText('2 feitos · 1 falharam');
    await expect(details).not.toContainText('Como ligar');
    expect(await seriousViolations(page)).toEqual([]);
    await shot(page, 'status-details');
    await page.keyboard.press('Escape');
    await expect(details).toBeHidden();
    await expect(chip).toBeFocused();

    const offChip = settings
      .getByRole('listitem')
      .filter({ hasText: off.name })
      .getByRole('button', { name: /^Transcritor: Desligado desde / });
    await offChip.click();
    const offDetails = page.getByRole('dialog', {
      name: `Transcritor "${off.name}"`,
    });
    await expect(offDetails).toContainText('Como ligar');
    // On the same Mac it starts by itself; never a uv command to run (KBC-114 AC-15).
    await expect(offDetails).toContainText(
      'Ele liga sozinho assim que um áudio espera por ele',
    );
    await expect(offDetails).not.toContainText('uv run');
    await shot(page, 'status-off');
    await noSideScroll(page);
    await offDetails.getByRole('button', { name: 'Ligar transcritor' }).click();
    await expect(offDetails.getByRole('status')).toContainText(
      'Pedido enviado ao macOS',
    );
    await offDetails.getByRole('button', { name: 'Fechar' }).click();
    await expect(offChip).toBeFocused();
  } finally {
    for (const mac of [working, off])
      await owner.delete(`/api/v1/media/transcribers/${mac.id}`, {
        headers: CSRF,
      });
    await owner.dispose();
  }
});
