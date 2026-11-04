import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import {
  CSRF,
  expect,
  invite,
  ownerApi,
  pageAs,
  test,
  uniqueEmail,
} from './fixtures.js';
import { uniqueTag, useTheme } from './media-helpers.js';
import {
  audioWithTracks,
  draftTracks,
  dragHandle,
  expectSaved,
  handle,
  trackRow,
} from './tracks-helpers.js';
import { transcribedAudio } from './voices-helpers.js';

// KBC-066, the guided flow's steps 3 and 4 (T20): the draft is seeded through the real
// routes; everything else is done on the screen.

const open = async (page: Page, id: string) => {
  await page.goto(`/midia/${id}/faixas`);
  await expect(page.getByTestId('step-text')).toContainText(
    /3.*Validar faixas/,
  );
};

test('AC-8, AC-17: the step comes back after a reload and after leaving', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  await open(page, media.id);
  await handle(page, 'Fim da faixa 1').focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await expectSaved(owner, media.id, (tracks) => tracks[0]?.endMs === 14_500);

  await page.reload();
  await expect(page.getByTestId('step-text')).toContainText('Validar faixas');
  await expect(
    page.getByText('O histórico de desfazer recomeçou'),
  ).toBeVisible();
  await expect(trackRow(page, 1)).toContainText('0:14,5');

  await page.getByRole('button', { name: 'Sair e continuar depois' }).click();
  await expect(page).toHaveURL(new RegExp(`/midia/${media.id}$`));
  await expect(page.getByText('Preparação parada no passo 3')).toBeVisible();
  await page.getByRole('link', { name: 'Continuar' }).click();
  await expect(page.getByTestId('step-text')).toContainText('Validar faixas');
  await owner.dispose();
});

test('AC-2: a released handle snaps to the word, and saves', async ({
  page,
}) => {
  const owner = await ownerApi();
  // "E como foi que o senhor chegou lá?" starts at 15.5 s with a word every 812.5 ms.
  const media = await audioWithTracks(owner, [
    { startMs: 18_000, endMs: 30_000, title: 'Faixa' },
  ]);
  await open(page, media.id);
  await page.getByRole('button', { name: 'Afastar' }).click();
  const view = 60_000;
  await dragHandle(page, {
    name: 'Início da faixa 1',
    toFraction: 16_450 / view,
  });
  await expectSaved(
    owner,
    media.id,
    (tracks) => Math.abs((tracks[0]?.startMs ?? 0) - 16_313) <= 1,
  );
  await owner.dispose();
});

test('AC-3: the keys of a handle: nudge without snapping, then the next word', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner, [
    { startMs: 16_000, endMs: 30_000, title: 'Faixa' },
  ]);
  await open(page, media.id);
  const end = handle(page, 'Fim da faixa 1');
  await end.focus();
  await page.keyboard.press('Alt+ArrowRight');
  await page.keyboard.press('Alt+ArrowRight');
  await expect(end).toHaveAttribute(
    'aria-valuetext',
    'Fim da faixa 1: 31 segundos',
  );
  await page.keyboard.press('ArrowRight');
  const landed = Number(await end.getAttribute('aria-valuenow'));
  expect(landed).toBeGreaterThan(31);
  expect(landed).toBeLessThan(35);
  await owner.dispose();
});

test('AC-4: an end stops at the next track and says so', async ({ page }) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  await open(page, media.id);
  await page
    .getByRole('list', { name: 'Faixas' })
    .getByRole('button')
    .nth(0)
    .click();
  const end = handle(page, 'Fim da faixa 1');
  await end.focus();
  await page.keyboard.press('Shift+ArrowRight');
  await expect(page.getByText('Encostou na faixa 2')).toBeVisible();
  await expect(end).toHaveAttribute('aria-valuenow', '15');
  await owner.dispose();
});

test('AC-5: a handle stops at 5 s; a track of 9 s has no "Dividir aqui"', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner, [
    { startMs: 10_000, endMs: 16_000, title: 'Curta' },
    { startMs: 20_000, endMs: 29_000, title: 'Nove segundos' },
  ]);
  await open(page, media.id);
  const start = handle(page, 'Início da faixa 1');
  await start.focus();
  await page.keyboard.press('End');
  await expect(start).toHaveAttribute('aria-valuenow', '11');
  await page.keyboard.press('Alt+ArrowRight');
  await expect(page.getByText('Mínimo de 5 s')).toBeVisible();
  await expect(start).toHaveAttribute('aria-valuenow', '11');

  await trackRow(page, 2).getByRole('button').first().click();
  await page.getByRole('button', { name: 'Mais ações da faixa' }).click();
  await expect(
    page.getByRole('menuitem', { name: 'Dividir aqui' }),
  ).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Apagar' })).toBeVisible();
  await owner.dispose();
});

test('AC-9: Ctrl+Z brings back a moved start and a deleted track; Ctrl+Shift+Z redoes', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  await open(page, media.id);
  await trackRow(page, 2).getByRole('button').first().click();
  const start = handle(page, 'Início da faixa 2');
  await start.focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect(start).toHaveAttribute('aria-valuenow', '15.5');
  await trackRow(page, 3).getByRole('button').first().click();
  await page.getByRole('button', { name: 'Mais ações da faixa' }).click();
  await page.getByRole('menuitem', { name: 'Apagar' }).click();
  await expect(page.getByText('Faixa 3 apagada')).toBeVisible();
  await expect(trackRow(page, 3)).toHaveCount(0);

  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('Control+z');
  await expect(trackRow(page, 3)).toContainText('Terceira pergunta');
  await page.keyboard.press('Control+z');
  await expect(trackRow(page, 2)).toContainText('0:15,0');
  await page.keyboard.press('Control+Shift+z');
  await expect(trackRow(page, 2)).toContainText('0:15,5');
  await owner.dispose();
});

test('AC-10: dividing makes two touching tracks, joining keeps the first title', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner, [
    { startMs: 0, endMs: 30_000, title: 'Duas perguntas' },
  ]);
  await open(page, media.id);
  await page.getByRole('button', { name: '0:15', exact: true }).click();
  await page.getByRole('button', { name: 'Mais ações da faixa' }).click();
  await page.getByRole('menuitem', { name: 'Dividir aqui' }).click();
  await expectSaved(owner, media.id, (tracks) => tracks.length === 2);
  const [first, second] = await draftTracks(owner, media.id);
  expect(first?.endMs).toBe(second?.startMs);
  expect((first?.endMs ?? 0) - (first?.startMs ?? 0)).toBeGreaterThanOrEqual(
    5_000,
  );

  await trackRow(page, 1).getByRole('button').first().click();
  await page.getByRole('button', { name: 'Mais ações da faixa' }).click();
  await page.getByRole('menuitem', { name: 'Juntar com a próxima' }).click();
  await expectSaved(owner, media.id, (tracks) => tracks.length === 1);
  expect((await draftTracks(owner, media.id))[0]).toMatchObject({
    title: 'Duas perguntas',
    endMs: 30_000,
  });
  await owner.dispose();
});

test('AC-11: an untitled track blocks the approval and takes the focus to its title', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner, [
    { startMs: 0, endMs: 15_000, title: 'Com título' },
    { startMs: 15_000, endMs: 30_000, title: null },
  ]);
  await open(page, media.id);
  await page.getByRole('button', { name: 'Aprovar faixas' }).click();
  await expect(page.getByRole('alert')).toContainText('Faixa 2: Sem título');
  await expect(page.getByRole('textbox', { name: 'Título' })).toBeFocused();
  await page.keyboard.type('Agora tem título');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Aprovar faixas' }).click();
  await expect(
    page.getByRole('heading', { name: '2 faixas aplicadas.' }),
  ).toBeVisible();
  await owner.dispose();
});

test('AC-14: on a phone, a finger moves the handle and "+0,5 s" too, and the target is 48 px', async ({
  browser,
  isMobile,
  viewport,
}) => {
  test.skip(!isMobile, 'touch: the 390 px project');
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  const email = uniqueEmail('dedo');
  await invite(owner, email, {
    topics: ['hermetismo'],
    features: ['media', 'media-edit'],
  });
  const page = await pageAs(browser, email, viewport);
  await open(page, media.id);
  await expect(page.getByTestId('step-text')).toContainText(
    '3/4 Validar faixas',
  );
  const start = handle(page, 'Início da faixa 1');
  const box = await start.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(48);
  expect(box?.height).toBeGreaterThanOrEqual(48);

  await page.getByRole('button', { name: 'Mais 0,5 segundo' }).click();
  await expect(start).toHaveAttribute('aria-valuenow', '0.5');
  await expectSaved(owner, media.id, (tracks) => tracks[0]?.startMs === 500);
  await page.context().close();
  await owner.dispose();
});

test('AC-15: the second to save is told, and keeps the change to copy', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  await open(page, media.id);
  const read = await owner.get(`/api/v1/media/${media.id}/edit`);
  const edit = (await read.json()) as { tracks: Record<string, unknown>[] };
  const tracks = edit.tracks.map((track) => ({
    id: track['id'],
    source: track['source'],
    startMs: track['startMs'],
    endMs: track['endMs'],
    kind: track['kind'],
    title: 'Da outra pessoa',
    askerVoice: null,
    answererVoice: null,
    askerSpeakerId: null,
    answererSpeakerId: null,
  }));
  const other = await owner.put(`/api/v1/media/${media.id}/edit`, {
    data: { step: 3, tracks },
    headers: { ...CSRF, 'if-match': '"1"' },
  });
  expect(other.status()).toBe(200);

  await handle(page, 'Fim da faixa 1').focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(page.getByRole('alert')).toContainText(
    'Outra pessoa mudou esta edição; recarregue para ver.',
  );
  await expect(
    page.getByRole('textbox', { name: 'Suas faixas, para copiar' }),
  ).toHaveValue(/0:14,5 Primeira pergunta/);
  await page.getByRole('button', { name: 'Recarregar' }).click();
  await expect(trackRow(page, 1)).toContainText('Da outra pessoa');
  await owner.dispose();
});

test('AC-18: the whole step by keyboard, from an empty draft to the approval', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'a keyboard: the desktop projects');
  const owner = await ownerApi();
  const media = await transcribedAudio(owner);
  await page.goto(`/midia/${media.id}/faixas`);
  await expect(page.getByText('Nenhuma faixa ainda.')).toBeVisible();
  const newTrack = page.getByRole('button', { name: 'Nova faixa aqui' });
  await newTrack.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Título' })).toBeFocused();
  await page.keyboard.type('Pelo teclado');
  await page.keyboard.press('Enter');

  const end = handle(page, 'Fim da faixa 1');
  await end.focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(end).toHaveAttribute('aria-valuenow', /59\.\d|59/);
  await page.keyboard.press('Control+z');
  await page.getByRole('button', { name: 'Aprovar faixas' }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: '1 faixas aplicadas.' }),
  ).toBeVisible();
  await owner.dispose();
});

for (const theme of ['light', 'dark', 'esoteric'] as const) {
  test(`AC-18: axe on the step (${theme} theme)`, async ({ page }) => {
    await useTheme(page, theme);
    const owner = await ownerApi();
    const media = await audioWithTracks(owner);
    await open(page, media.id);
    await expect(handle(page, 'Início da faixa 1')).toBeVisible();
    const { violations } = await new AxeBuilder({ page })
      .include('app-track-editor-page')
      .analyze();
    expect(
      violations.filter((one) =>
        ['serious', 'critical'].includes(one.impact ?? ''),
      ),
    ).toEqual([]);
    await owner.dispose();
  });
}

test('the page has no horizontal scroll and the title is the recording`s', async ({
  page,
}) => {
  const owner = await ownerApi();
  const tag = uniqueTag();
  const media = await audioWithTracks(owner);
  await open(page, media.id);
  await expect(page.getByRole('heading', { name: media.title })).toBeVisible();
  const width = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(width, tag).toBeLessThanOrEqual(0);
  await owner.dispose();
});

test('an editor without the permission reads why', async ({
  browser,
  viewport,
}) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  const email = uniqueEmail('sem-edicao');
  await invite(owner, email, { topics: ['hermetismo'], features: ['media'] });
  const page = await pageAs(browser, email, viewport);
  await page.goto(`/midia/${media.id}/faixas`);
  await expect(
    page.getByText('Você não tem permissão para editar esta gravação.'),
  ).toBeVisible();
  await page.context().close();
  await owner.dispose();
});
