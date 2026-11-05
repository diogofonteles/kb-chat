import type { Browser, Locator, Page } from '@playwright/test';
import type { Feature, MediaPreparation } from '@kb-chat/contracts';
import {
  CSRF,
  expect,
  invite,
  ownerApi,
  pageWith,
  test,
  uniqueEmail,
} from './fixtures.js';
import { makeMp3, uniqueTag, uploadReady } from './media-helpers.js';
import { seedTranscript, transcribedAudio } from './voices-helpers.js';

// KBC-090 and KBC-091: the queue of what is being processed, the library that follows the
// selected collection and the names of the voices. Uploads, conversions and plans are real;
// the paid stage's suggestions come as the contract's shape (the E2E server's model is fake).

const FEATURES: Feature[] = [
  'search',
  'media',
  'media-library',
  'media-upload',
  'media-edit',
];

type Viewport = { width: number; height: number } | null;

async function person(
  browser: Browser,
  viewport: Viewport,
  features: Feature[] = FEATURES,
) {
  const email = uniqueEmail('fila');
  const owner = await ownerApi();
  await invite(owner, email, { topics: ['hermetismo', 'alquimia'], features });
  return { page: await pageWith(browser, email, { viewport }), owner };
}

const openMenu = async (page: Page, viewport: Viewport) => {
  if ((viewport?.width ?? 0) < 900)
    await page.getByRole('button', { name: 'Menu' }).click();
};

async function openUpload(page: Page): Promise<Locator> {
  await page.goto('/biblioteca');
  await page.getByRole('button', { name: 'Enviar mídia' }).first().click();
  return page.getByRole('dialog', { name: 'Enviar áudio' });
}

test('KBC-090: several files go to the queue, which says where each one is', async ({
  browser,
  viewport,
}) => {
  const { page, owner } = await person(browser, viewport);
  const tag = uniqueTag();
  const dialog = await openUpload(page);
  await dialog
    .locator('input[type="file"]')
    .setInputFiles([
      makeMp3(`fila-${tag}-a`, 60),
      makeMp3(`fila-${tag}-b`, 61),
    ]);
  await expect(dialog.getByRole('textbox', { name: 'Título' })).toHaveCount(2);
  await dialog.getByRole('button', { name: 'Enviar', exact: true }).click();

  await expect(page).toHaveURL(/\/fila$/);
  await expect(
    page.getByRole('heading', { name: 'Fila de processamento' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Nova Alexandria',
  );
  const rows = page.locator('app-queue-row').filter({ hasText: tag });
  await expect(rows).toHaveCount(2, { timeout: 15_000 });
  await expect(rows.first()).toContainText('Depois: ');
  await owner.dispose();
});

test('KBC-090: the queue takes the person to what is left, and empties', async ({
  browser,
  viewport,
}) => {
  const { page, owner } = await person(browser, viewport);
  const title = `Fila ${uniqueTag()}`;
  const media = await uploadReady(owner, { title, seconds: 60 });
  await seedTranscript(owner, media.id);
  const started = await owner.post(`/api/v1/media/${media.id}/preparation`, {
    data: {
      plan: {
        transcribe: false,
        speakers: false,
        tracks: 'manual',
        subjects: false,
      },
    },
    headers: CSRF,
  });
  expect(started.status(), await started.text()).toBe(200);

  await page.goto('/fila');
  await expect(page.getByRole('link', { name: title })).toBeVisible();
  const validate = page
    .getByRole('region', { name: 'Precisa de você' })
    .locator('app-queue-row')
    .filter({ hasText: title })
    .getByRole('button', { name: 'Validar faixas' });
  await expect(validate).toBeVisible();
  await validate.dblclick();
  await expect(page).toHaveURL(new RegExp(`/midia/${media.id}/faixas$`));
  await owner.dispose();
});

test('KBC-090: who cannot send media has no queue', async ({
  browser,
  viewport,
}) => {
  const { page, owner } = await person(browser, viewport, [
    'search',
    'media',
    'media-library',
  ]);
  await page.goto('/fila');
  await expect(page).toHaveURL(/\/$/);
  await openMenu(page, viewport);
  await expect(page.getByRole('link', { name: /^Fila/ })).toHaveCount(0);
  await owner.dispose();
});

test('KBC-091: the library follows the collection, and the header never lies', async ({
  browser,
  viewport,
}) => {
  const { page, owner } = await person(browser, viewport);
  const tag = uniqueTag();
  const here = await uploadReady(owner, {
    title: `Daqui ${tag}`,
    seconds: 5,
  });
  const there = await uploadReady(owner, {
    title: `De lá ${tag}`,
    seconds: 5,
    topic: 'alquimia',
  });
  await page.goto('/biblioteca');
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toContainText('Hermetismo');
  const search = page.getByLabel('Buscar na biblioteca');
  await search.fill(tag);
  await expect(page.getByRole('link', { name: here.title })).toBeVisible();
  await expect(page.getByRole('link', { name: there.title })).toHaveCount(0);

  await page
    .getByLabel('Acervo')
    .last()
    .selectOption({ label: 'Todos os acervos' });
  await expect(heading).toHaveText('Todos os acervos');
  await expect(page.getByRole('link', { name: there.title })).toBeVisible();

  await page.reload();
  await expect(heading).toHaveText('Todos os acervos');

  await page.goto(`/midia/${there.id}`);
  await expect(heading).toContainText('Alquimia');
  await owner.dispose();
});

const VOICE_READING = (id: string): Partial<MediaPreparation> => ({
  mediaId: id,
  title: 'Palestra de 1998',
  topic: 'hermetismo',
  author: null,
  step: 2,
  skipped: false,
  finished: false,
  plan: {
    transcribe: true,
    speakers: true,
    tracks: 'manual',
    subjects: false,
    acceptedUsd: null,
  },
  stages: [],
  separation: 1,
  voices: [{ voice: 1, speakingMs: 60_000, name: null, audience: false }],
  suggestions: [
    {
      voice: 1,
      name: 'Márcio da Roça',
      audience: false,
      reason: 'se apresenta',
    },
  ],
  refusedVoices: [],
  tracks: [],
  next: null,
  canSwitchToManual: false,
  transcriber: 'on',
  transcriberOffSince: null,
});

test('KBC-090: a suggested name can be corrected and refused on step 2', async ({
  browser,
  viewport,
}) => {
  const { page, owner } = await person(browser, viewport);
  const media = await transcribedAudio(owner);
  await page.route(`**/api/v1/media/${media.id}/preparation`, (route) =>
    route.fulfill({ json: VOICE_READING(media.id) }),
  );
  await page.goto(`/midia/${media.id}/preparar`);
  await expect(page.getByText('Voz 1 parece ser')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Aceitar Márcio da Roça para a Voz 1' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: 'Recusar o nome sugerido para a Voz 1',
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Corrigir o nome da Voz 1' }).click();
  const field = page.getByRole('combobox', { name: 'Quem é a Voz 1?' });
  await expect(field).toHaveValue('Márcio da Roça');
  await expect(field).toBeFocused();
  await page.getByRole('button', { name: 'Cancelar' }).click();
  await expect(
    page.getByRole('button', { name: 'Corrigir o nome da Voz 1' }),
  ).toBeFocused();
  await owner.dispose();
});

test('KBC-090: the button that plays offers to stop, with nothing moving around it', async ({
  browser,
  viewport,
}) => {
  const { page, owner } = await person(browser, viewport);
  const media = await transcribedAudio(owner);
  await page.goto(`/midia/${media.id}/faixas`);
  await page.getByRole('button', { name: 'Nova faixa aqui' }).click();
  const listen = page.getByRole('button', { name: '▶ Ouvir' });
  const end = page.getByRole('button', { name: 'Ouvir o fim' });
  await expect(listen).toBeVisible();
  const before = [await listen.boundingBox(), await end.boundingBox()];
  await listen.click();
  const stop = page.getByRole('button', { name: '■ Parar' });
  await expect(stop).toBeVisible();
  expect([await stop.boundingBox(), await end.boundingBox()]).toEqual(before);
  await stop.click();
  await expect(listen).toBeVisible();
  await owner.dispose();
});
