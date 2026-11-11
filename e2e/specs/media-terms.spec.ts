import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, ownerApi, test } from './fixtures.js';
import { newListener, uniqueTag, uploadReady } from './media-helpers.js';
import { rawOf, seedTranscript } from './transcript-helpers.js';

// KBC-040: the term list a master edits and "Transcrever de novo" on a media.

const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

/** The API is shared with the other projects, which may save the one list meanwhile. */
async function openTerms(page: Page): Promise<Locator> {
  await page.goto('/biblioteca');
  if (!desktop(page))
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('button', { name: 'Configurações' }).click();
  const dialog = page.getByRole('dialog', { name: 'Configurações' });
  await dialog.getByRole('button', { name: 'Termos da transcrição' }).click();
  await expect(dialog.getByText(/\d+ de 224 do limite/)).toBeVisible();
  return dialog;
}

async function addTerms(dialog: Locator, lines: string) {
  await dialog.getByLabel('Adicionar termos').fill(lines);
  await dialog.getByRole('button', { name: 'Adicionar', exact: true }).click();
}

const seriousViolations = async (page: Page) =>
  (
    await new AxeBuilder({ page }).include('dialog').analyze()
  ).violations.filter((violation) =>
    ['serious', 'critical'].includes(violation.impact ?? ''),
  );

/** A ready audio with a first transcript, as the owner. */
async function transcribedAudio(text: string) {
  const owner = await ownerApi();
  const { id, title } = await uploadReady(owner, {
    title: `Termos ${uniqueTag()}`,
    seconds: 3,
  });
  await seedTranscript(owner, { id, raw: rawOf([{ at: 0, text }]) });
  return { owner, id, title };
}

test('AC-1, AC-6: a master adds a term, the version goes up, and the screen passes axe', async ({
  page,
}) => {
  const term = `Termo${uniqueTag().replace(/\W/g, '')}`;
  await expect(async () => {
    const dialog = await openTerms(page);
    expect(await seriousViolations(page)).toEqual([]);
    await addTerms(dialog, term);
    await expect(
      dialog.getByRole('textbox', { name: /^Termo \d+$/ }).last(),
    ).toHaveValue(term);
    await dialog.getByRole('button', { name: 'Salvar lista' }).click();
    await expect(dialog.getByText(/Lista salva: versão \d+\./)).toBeVisible({
      timeout: 5_000,
    });
  }).toPass();
});

test('AC-3: a list past the limit is refused with the numbers, and nothing is saved', async ({
  page,
}) => {
  const dialog = await openTerms(page);
  const version = await dialog.getByText(/Versão \d+, de/).innerText();
  const many = Array.from(
    { length: 40 },
    (_, n) => `Palavra Comprida Número ${n}`,
  );
  await addTerms(dialog, many.join('\n'));
  await expect(dialog.getByRole('alert')).toContainText(
    /A lista passou do limite do transcritor \(\d+ de 224\)\. Remova alguns termos\./,
  );
  await dialog.getByRole('button', { name: 'Salvar lista' }).click();
  // The list's own live region: "Aprendido das correções" (KBC-113) has one after it.
  await expect(
    dialog.locator('app-terms-panel').getByRole('status').last(),
  ).toContainText('A lista passou do limite');
  await expect(dialog.getByText(version)).toBeVisible();
  await dialog.getByRole('button', { name: 'Descartar mudanças' }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('AC-2, AC-5: the text stays while it is redone, and the new version brings the new name', async ({
  page,
}) => {
  const { owner, id, title } = await transcribedAudio('O Tioaco falou aqui.');
  await page.goto(`/midia/${id}`);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  const transcript = page.getByRole('list', { name: 'Trechos da transcrição' });
  await expect(transcript).toContainText('Tioaco');
  await expect(
    page.getByText(/Feita com a lista de termos v\d+ \(\d{2}\/\d{2}\/\d{4}\)/),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Transcrever de novo' }).click();
  const question = page.getByRole('group', { name: /Transcrever de novo com/ });
  await expect(
    question.getByRole('button', { name: 'Cancelar' }),
  ).toBeFocused();
  await question.getByRole('button', { name: 'Transcrever de novo' }).click();

  await expect(page.locator('app-media-player-page .meta')).toContainText(
    'Retranscrevendo',
  );
  await expect(transcript).toContainText('Tioaco');
  await expect(
    page.getByRole('button', { name: 'Transcrever de novo' }),
  ).toHaveCount(0);

  await seedTranscript(owner, {
    id,
    raw: rawOf([{ at: 0, text: 'O Tiuaco falou aqui.' }]),
  });
  await owner.dispose();
  await page.reload();
  await expect(transcript).toContainText('Tiuaco');
  await expect(page.locator('app-media-player-page .meta')).not.toContainText(
    'Retranscrevendo',
  );
});

test('a person who only listens sees neither the button nor the list version', async ({
  browser,
  viewport,
}) => {
  const { owner, id, title } = await transcribedAudio('Uma frase qualquer.');
  await owner.dispose();
  const { page } = await newListener(browser, { viewport });
  await page.goto(`/midia/${id}`);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Trechos da transcrição' }),
  ).toContainText('frase qualquer');
  await expect(
    page.getByRole('button', { name: 'Transcrever de novo' }),
  ).toHaveCount(0);
  await expect(page.getByText(/Feita com a lista de termos/)).toHaveCount(0);
  await page.context().close();
});
