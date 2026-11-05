import type {
  APIRequestContext,
  Browser,
  Locator,
  Page,
} from '@playwright/test';
import type { Feature } from '@kb-chat/contracts';
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
import { audioWithTracks, trackRow } from './tracks-helpers.js';
import {
  seedTranscript,
  separateVoices,
  transcribedAudio,
} from './voices-helpers.js';

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
  page,
}) => {
  const owner = await ownerApi();
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

/** Separated voices, a plan on step 2 and a proposal that names them, as a run leaves it. */
async function proposedAudio(
  owner: APIRequestContext,
  input: { tracks: object[]; voices: object[] },
) {
  const media = await transcribedAudio(owner);
  await separateVoices(owner, media.id);
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
  const seeded = await owner.post(`/api/e2e/media/${media.id}/proposal`, {
    data: input,
    headers: CSRF,
  });
  expect(seeded.status(), await seeded.text()).toBe(204);
  return media;
}

async function correctVoice(page: Page, voice: number, name: string) {
  await page
    .getByRole('button', { name: `Corrigir o nome da Voz ${voice}` })
    .click();
  const field = page.getByRole('combobox', { name: `Quem é a Voz ${voice}?` });
  await expect(field).toBeFocused();
  await field.fill(name);
  // Not any option: "Carregando…" is one too, and Enter registers nothing while it shows.
  await expect(
    page.getByRole('option', { name: `Cadastrar «${name}»`, exact: true }),
  ).toBeVisible();
  await field.press('Enter');
  await expect(field).toHaveCount(0);
}

const FIRST = { startMs: 0, endMs: 20_000, answererVoice: 1 };
const SECOND = { startMs: 20_000, endMs: 45_000, answererVoice: 2 };

test('KBC-090: a correction and a refusal reach the published track', async ({
  page,
}) => {
  const owner = await ownerApi();
  const tag = uniqueTag();
  const wrong = `Márcio da Roça ${tag}`;
  const refused = `Joana Prado ${tag}`;
  const media = await proposedAudio(owner, {
    tracks: [
      { ...FIRST, title: `Conversa com ${wrong}` },
      { ...SECOND, title: `Pergunta de ${refused}` },
    ],
    voices: [
      { voice: 1, name: wrong },
      { voice: 2, name: refused },
    ],
  });
  await page.goto(`/midia/${media.id}/preparar`);
  await expect(page.getByText('Voz 1 parece ser')).toBeVisible();

  const right = `Márcio da Rós ${tag}`;
  await correctVoice(page, 1, right);
  await expect(page.getByText(`Conversa com ${right}`)).toBeVisible();
  await expect(page.getByText(`Resposta: ${right}`)).toBeVisible();

  await page
    .getByRole('button', { name: 'Recusar o nome sugerido para a Voz 2' })
    .click();
  await expect(page.getByText(/Reveja estes títulos/)).toContainText(refused);
  await expect(page.getByText('Voz 2 parece ser')).toHaveCount(0);

  await page.getByRole('button', { name: 'Validar faixas' }).click();
  await expect(page).toHaveURL(/\/faixas$/);
  await expect(page.getByText(/Reveja estes títulos/)).toBeVisible();
  await expect(page.getByText(/Alguns títulos podem citar/)).toBeInViewport();

  // The screen may still be saving what it opened with.
  await expect(async () => {
    const edit = await owner.get(`/api/v1/media/${media.id}/edit`);
    const { version } = (await edit.json()) as { version: number };
    const approved = await owner.post(
      `/api/v1/media/${media.id}/edit/approve`,
      { data: {}, headers: { ...CSRF, 'if-match': `"${version}"` } },
    );
    expect(approved.status(), await approved.text()).toBe(200);
  }).toPass({ timeout: 10_000 });
  const track = await publishedTitled(owner, media.id, right);

  const later = `Márcio Rocha ${tag}`;
  await page.goto(`/midia/${media.id}/faixas`);
  await correctVoice(page, 1, later);
  await publishedTitled(owner, media.id, later);
  const history = await owner.get(`/api/v1/media/${track.id}/history`);
  const { changes } = (await history.json()) as {
    changes: { field: string; after: string | null }[];
  };
  expect(changes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        field: 'title',
        after: `Conversa com ${later}`,
      }),
    ]),
  );
  await owner.dispose();
});

/** Waits for the recording's track with this name in its title, published. */
async function publishedTitled(
  owner: APIRequestContext,
  mediaId: string,
  name: string,
) {
  let found: { id: string; title: string } | undefined;
  await expect
    .poll(
      async () => {
        const page = await owner.get('/api/v1/media/library?q=' + 'Conversa');
        const { items } = (await page.json()) as {
          items: {
            id: string;
            tracks: { id: string; title: string }[];
          }[];
        };
        found = items
          .find((item) => item.id === mediaId)
          ?.tracks.find((one) => one.title.includes(name));
        return found?.title;
      },
      { timeout: 30_000 },
    )
    .toBeTruthy();
  if (!found) throw new Error('no published track');
  return found;
}

test('KBC-090: a voice already accepted is corrected from step 3, and the focus stays', async ({
  page,
}) => {
  const owner = await ownerApi();
  const tag = uniqueTag();
  const wrong = `Márcio da Roça ${tag}`;
  const media = await proposedAudio(owner, {
    tracks: [{ ...FIRST, title: `Conversa com ${wrong}` }],
    voices: [{ voice: 1, name: wrong }],
  });
  await page.goto(`/midia/${media.id}/preparar`);
  await page.getByRole('button', { name: 'Validar faixas' }).click();
  await expect(page).toHaveURL(/\/faixas$/);

  const accept = page.getByRole('button', {
    name: `Aceitar ${wrong} para a Voz 1`,
  });
  await accept.focus();
  await page.keyboard.press('Enter');
  await expect(accept).toHaveCount(0);
  const correction = page.getByRole('button', {
    name: 'Corrigir o nome da Voz 1',
  });
  await expect(correction).toBeFocused();

  const right = `Márcio da Rós ${tag}`;
  await correctVoice(page, 1, right);
  await expect(correction).toBeFocused();
  await expect(
    page.getByRole('combobox', { name: 'Quem responde' }),
  ).toContainText(right);
  await page.getByRole('button', { name: 'Recusar o nome da Voz 1' }).click();
  await expect(
    page.getByRole('button', { name: 'Recusar o nome da Voz 1' }),
  ).toHaveCount(0);
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
  // Across, not down: the press may scroll the page, which moves nothing on the row.
  const place = async (one: Locator) => {
    const box = await one.boundingBox();
    return { x: box?.x, width: box?.width, height: box?.height };
  };
  const before = [await place(listen), await place(end)];
  await listen.click();
  const stop = page.getByRole('button', { name: '■ Parar' });
  await expect(stop).toBeVisible();
  expect([await place(stop), await place(end)]).toEqual(before);
  await stop.click();
  await expect(listen).toBeVisible();
  await owner.dispose();
});

test('KBC-090: another row selected, the person can still stop, and Space stops', async ({
  browser,
  viewport,
}) => {
  const { page, owner } = await person(browser, viewport);
  const media = await audioWithTracks(owner);
  await page.goto(`/midia/${media.id}/faixas`);
  await trackRow(page, 1).getByRole('button').first().click();
  await page.getByRole('button', { name: '▶ Ouvir' }).click();
  await expect(page.getByRole('button', { name: '■ Parar' })).toBeVisible();

  await trackRow(page, 2).getByRole('button').first().click();
  const stop = page.getByRole('button', { name: '■ Parar o que está tocando' });
  await expect(stop).toBeVisible();
  await trackRow(page, 2).getByRole('button').first().press('Space');
  await expect(stop).toHaveCount(0);
  await expect(page.getByRole('button', { name: '▶ Ouvir' })).toBeVisible();
  await owner.dispose();
});
