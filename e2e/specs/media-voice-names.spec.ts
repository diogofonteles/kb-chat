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
import { useTheme } from './media-helpers.js';
import { TURNS, separateVoices, transcribedAudio } from './voices-helpers.js';

// KBC-065: "Vozes" names the voices; whoever listens reads who speaks. Voice 1 asks, voice 2
// answers (it speaks most), voice 3 is the audience (TURNS).

const voicesBlock = (page: Page) => page.getByRole('region', { name: 'Vozes' });
const whoIs = (page: Page, voice: number) =>
  voicesBlock(page).getByRole('combobox', { name: `Quem é a Voz ${voice}?` });
const transcriptList = (page: Page) =>
  page.getByRole('list', { name: 'Trechos da transcrição' });
const caption = (page: Page) => page.locator('app-media-player .caption');

async function audioWithVoices() {
  const owner = await ownerApi();
  const media = await transcribedAudio(owner);
  await separateVoices(owner, media.id);
  return { owner, media };
}

/** Types in the voice's field and takes the option with Enter: only the keyboard. */
async function nameByKeyboard(page: Page, voice: number, text: string) {
  const field = whoIs(page, voice);
  await field.focus();
  await field.fill(text);
  await field.press('ArrowDown');
  await field.press('Enter');
  await expect(voicesBlock(page)).toContainText('Nome salvo.');
}

const listenerPage = async (
  browser: Parameters<typeof pageAs>[0],
  viewport: Parameters<typeof pageAs>[2],
  features: string[],
) => {
  const owner = await ownerApi();
  const email = uniqueEmail('ouvinte-nomes');
  await invite(owner, email, { topics: ['hermetismo'], features });
  await owner.dispose();
  return pageAs(browser, email, viewport);
};

const seriousViolations = async (page: Page, include: string) =>
  (await new AxeBuilder({ page }).include(include).analyze()).violations.filter(
    (violation) => ['serious', 'critical'].includes(violation.impact ?? ''),
  );

for (const theme of ['light', 'dark', 'esoteric'] as const) {
  test(`AC-1, AC-8: named by keyboard, a listener reads who speaks (${theme} theme, axe)`, async ({
    page,
    browser,
    viewport,
  }) => {
    await useTheme(page, theme);
    const { owner, media } = await audioWithVoices();
    await owner.dispose();
    await page.goto(`/midia/${media.id}`);
    await expect(whoIs(page, 2)).toBeVisible();
    expect(await seriousViolations(page, 'app-voices-panel')).toEqual([]);

    await nameByKeyboard(page, 2, 'Mestre Laércio');
    await expect(whoIs(page, 2)).toHaveValue('Mestre Laércio');
    await nameByKeyboard(page, 1, 'Pergunta');
    await nameByKeyboard(page, 3, 'Pergunta');
    await expect(whoIs(page, 3)).toHaveValue('Pergunta da plateia');
    await expect(transcriptList(page)).toContainText('Mestre Laércio');
    expect(await seriousViolations(page, 'app-voices-panel')).toEqual([]);
    expect(await seriousViolations(page, 'app-transcript-panel')).toEqual([]);

    const listener = await listenerPage(browser, viewport, [
      'media',
      'media-speakers',
    ]);
    await listener.goto(`/midia/${media.id}?t=6`);
    await expect(transcriptList(listener)).toContainText('✦');
    await expect(transcriptList(listener)).toContainText('Mestre Laércio');
    await expect(transcriptList(listener)).toContainText('Pergunta da plateia');
    await expect(listener.getByRole('heading', { name: 'Vozes' })).toHaveCount(
      0,
    );
    await listener.getByRole('button', { name: 'Legendas' }).click();
    await expect(caption(listener)).toContainText('— ✦ Mestre Laércio:');
  });
}

test('AC-3: two voices become one, and the join can be undone', async ({
  page,
}) => {
  const { owner, media } = await audioWithVoices();
  await owner.dispose();
  await page.goto(`/midia/${media.id}`);
  const block = voicesBlock(page);
  await block.getByLabel('Juntar a voz').selectOption({ label: 'Voz 3' });
  await block.getByLabel('com a voz').selectOption({ label: 'Voz 1' });
  await block.getByRole('button', { name: 'Juntar', exact: true }).click();
  await expect(block.getByRole('status')).toHaveText('Vozes separadas: 2');
  await expect(block).toContainText('Voz 3 junta à Voz 1');
  await expect(transcriptList(page).getByText(/^Voz 3$/)).toHaveCount(0);

  await block.getByRole('button', { name: 'Separar a Voz 3' }).click();
  await expect(block.getByRole('status')).toHaveText('Vozes separadas: 3');
  await expect(transcriptList(page).getByText(/^Voz 3$/)).toHaveCount(1);
});

test('AC-3: undoing a join gives each voice back what it had', async ({
  page,
}) => {
  const { owner, media } = await audioWithVoices();
  await owner.dispose();
  await page.goto(`/midia/${media.id}`);
  const block = voicesBlock(page);
  await nameByKeyboard(page, 3, 'Pergunta');
  await block.getByLabel('Juntar a voz').selectOption({ label: 'Voz 3' });
  await block.getByLabel('com a voz').selectOption({ label: 'Voz 1' });
  await block.getByRole('button', { name: 'Juntar', exact: true }).click();
  await expect(whoIs(page, 1)).toHaveValue('Pergunta da plateia');

  await block.getByRole('button', { name: 'Separar a Voz 3' }).click();
  await expect(whoIs(page, 1)).toHaveValue('');
  await expect(whoIs(page, 3)).toHaveValue('Pergunta da plateia');
});

test('AC-8: Enter saves only what was chosen or spelled out', async ({
  page,
}) => {
  const { owner, media } = await audioWithVoices();
  await page.goto(`/midia/${media.id}`);
  await nameByKeyboard(page, 2, 'Mestre Laércio');
  const named = whoIs(page, 2);
  await named.press('Enter');
  await named.blur();
  await named.focus();
  await named.press('Enter');
  await expect(named).toHaveValue('Mestre Laércio');

  const partial = whoIs(page, 1);
  await partial.fill('Mes');
  await partial.press('Enter');
  await expect(partial).toHaveAttribute('aria-expanded', 'true');
  await expect(partial).toHaveValue('Mes');
  await partial.blur();
  await expect(partial).toHaveValue('');
  await page.reload();
  await expect(whoIs(page, 2)).toHaveValue('Mestre Laércio');
  const list = await owner.get('/api/v1/topics/hermetismo/speakers');
  const { items } = (await list.json()) as { items: { name: string }[] };
  expect(items.some(({ name }) => name === 'Mes')).toBe(false);
  await owner.dispose();
});

test('AC-6: a new separation keeps the names and asks to confirm them', async ({
  page,
  browser,
  viewport,
}) => {
  const { owner, media } = await audioWithVoices();
  await page.goto(`/midia/${media.id}`);
  await nameByKeyboard(page, 2, 'Mestre Laércio');
  await separateVoices(owner, media.id, TURNS);
  await owner.dispose();
  await page.reload();
  const block = voicesBlock(page);
  await expect(block).toContainText('Confirme os nomes das vozes');
  await expect(whoIs(page, 2)).toHaveValue('Mestre Laércio');

  const listener = await listenerPage(browser, viewport, [
    'media',
    'media-speakers',
  ]);
  await listener.goto(`/midia/${media.id}`);
  await expect(transcriptList(listener)).toContainText(
    'Falante não identificado',
  );
  await expect(transcriptList(listener)).not.toContainText('Mestre Laércio');

  await block.getByRole('button', { name: 'Confirmar nomes' }).click();
  await expect(block).not.toContainText('Confirme os nomes das vozes');
  await listener.reload();
  await expect(transcriptList(listener)).toContainText('Mestre Laércio');
});

test('AC-4, AC-5: without the permission nothing changes; "Mostrar quem fala" is remembered', async ({
  browser,
  viewport,
}) => {
  const { owner, media } = await audioWithVoices();
  await owner.dispose();
  const plain = await listenerPage(browser, viewport, ['media']);
  await plain.goto(`/midia/${media.id}`);
  await expect(transcriptList(plain)).toContainText('Mestre, o senhor');
  await expect(transcriptList(plain)).not.toContainText(
    'Falante não identificado',
  );
  const refused = await plain.request.put(
    `/api/v1/media/${media.id}/voices/1`,
    {
      data: { version: 1, speakerId: null, audience: false },
      headers: CSRF,
    },
  );
  expect(refused.status()).toBe(403);

  const listener = await listenerPage(browser, viewport, [
    'media',
    'media-speakers',
  ]);
  await listener.goto(`/midia/${media.id}`);
  await expect(transcriptList(listener)).toContainText(
    'Falante não identificado',
  );
  await listener.getByRole('button', { name: 'Mais opções' }).click();
  const showSpeakers = listener.getByRole('menuitem', {
    name: 'Mostrar quem fala: ligado',
  });
  await expect(showSpeakers).toBeInViewport({ ratio: 1 });
  await showSpeakers.click();
  await expect(transcriptList(listener)).not.toContainText(
    'Falante não identificado',
  );
  await listener.reload();
  await expect(transcriptList(listener)).toContainText('Mestre, o senhor');
  await expect(transcriptList(listener)).not.toContainText(
    'Falante não identificado',
  );
});

test('AC-7: a name of 121 characters is said at the field and nothing is created', async ({
  page,
}) => {
  const { owner, media } = await audioWithVoices();
  await page.goto(`/midia/${media.id}`);
  const field = whoIs(page, 1);
  await field.fill('a'.repeat(121));
  await field.press('Enter');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(voicesBlock(page)).toContainText(
    'O nome deve ter de 1 a 120 caracteres',
  );
  const list = await owner.get('/api/v1/topics/hermetismo/speakers');
  const { items } = (await list.json()) as { items: { name: string }[] };
  expect(items.some(({ name }) => name.startsWith('aaa'))).toBe(false);
  await owner.dispose();
});

test('FR-3: a voice plays a short sample and leaves the player where it was', async ({
  page,
}) => {
  const { owner, media } = await audioWithVoices();
  await owner.dispose();
  await page.goto(`/midia/${media.id}?t=2`);
  const block = voicesBlock(page);
  await block.getByRole('button', { name: 'Ouvir amostra da Voz 3' }).click();
  await expect(
    block.getByRole('button', { name: 'Parar amostra da Voz 3' }),
  ).toBeVisible();
  // Voice 3's only turn lasts 5 s: the button comes back when it ends.
  await expect(
    block.getByRole('button', { name: 'Ouvir amostra da Voz 3' }),
  ).toBeVisible({ timeout: 12_000 });
  await expect(block.getByRole('alert')).toHaveCount(0);
});

test('FR-3: the player goes on after one sample replaced another', async ({
  page,
}) => {
  const { owner, media } = await audioWithVoices();
  await owner.dispose();
  await page.goto(`/midia/${media.id}`);
  const block = voicesBlock(page);
  await page.getByRole('button', { name: 'Tocar', exact: true }).click();
  const pause = page.getByRole('button', { name: 'Pausar', exact: true });
  await expect(pause).toBeVisible();

  await block.getByRole('button', { name: 'Ouvir amostra da Voz 3' }).click();
  await expect(
    block.getByRole('button', { name: 'Parar amostra da Voz 3' }),
  ).toBeVisible();
  await expect(pause).toHaveCount(0);
  await block.getByRole('button', { name: 'Ouvir amostra da Voz 1' }).click();
  await expect(
    block.getByRole('button', { name: 'Parar amostra da Voz 1' }),
  ).toBeVisible();
  await expect(pause).toBeVisible({ timeout: 12_000 });
});
