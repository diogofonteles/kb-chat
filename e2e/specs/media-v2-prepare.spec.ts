import { expect, ownerApi, test } from './fixtures.js';
import { aCollection, uniqueTag, uploadReady } from './media-helpers.js';
import { approve, audioWithTracks } from './tracks-helpers.js';
import { capture, expectInsideViewport } from './v2-media-helpers.js';

// KBC-130 (v2): "Preparar áudio" with the four-bar stepper, a track picked on the waveform
// selects its row, the approve bar never covers the last row, and "Desfazer" on /limites.

test.describe.configure({ mode: 'default' });

test('KBC-130 AC-1: on step 2 the stepper marks step 1 done and step 2 current, with the v1 names', async ({
  page,
}, info) => {
  const owner = await ownerApi();
  const media = await uploadReady(owner, {
    title: `Aula ${uniqueTag()}`,
    seconds: 6,
  });
  await page.goto(`/midia/${media.id}/preparar`);
  await expect(page.getByText('Preparar áudio', { exact: true })).toBeVisible();
  await capture(page, 'prepare-choose', info.project.name);
  await page.getByRole('button', { name: 'Preparar', exact: true }).click();
  await expect(page.getByTestId('step-text')).toContainText(/2.*Processar/);
  const steps = page.getByRole('list', { name: 'Preparar áudio' });
  // The guided flow keeps the four bars in sight at every width: nothing to open (v2).
  await expect(page.getByRole('button', { name: 'Ver os passos' })).toHaveCount(
    0,
  );
  await expect(steps.getByRole('listitem').nth(0)).toHaveClass(/done/);
  await expect(steps.getByRole('listitem').nth(0)).toContainText(
    '1 Enviar e escolher',
  );
  await expect(steps.getByRole('listitem').nth(0)).toContainText('✓');
  await expect(steps.getByRole('listitem').nth(1)).toHaveAttribute(
    'aria-current',
    'step',
  );
  await expect(steps.getByRole('listitem').nth(1)).toContainText('2 Processar');
  await capture(page, 'prepare-process', info.project.name);
  await owner.dispose();
});

test('KBC-130 AC-2, AC-4: a track picked on the waveform selects its row, and the last row ends above the approve bar', async ({
  page,
}, info) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  await page.goto(`/midia/${media.id}/faixas`);
  // The track's region on the waveform (the frames have no overview strip).
  const blocks = page.getByTestId('track-detail').locator('[data-track]');
  await expect(blocks).toHaveCount(3);
  await blocks.nth(1).click();
  const rows = page.getByRole('list', { name: 'Faixas' }).getByRole('listitem');
  await expect(
    rows.nth(1).getByRole('button', { name: /Segunda pergunta/ }),
  ).toHaveAttribute('aria-current', 'true');
  await expect(rows.nth(1)).toBeInViewport();
  await capture(page, 'tracks', info.project.name);

  const last = rows.last();
  await last.scrollIntoViewIfNeeded();
  await page
    .locator('app-track-editor-page')
    .evaluate((host) => host.scrollTo(0, host.scrollHeight));
  const bar = page.locator('footer.foot');
  await expect(
    bar.getByRole('button', { name: 'Aprovar faixas' }),
  ).toBeVisible();
  const rowBox = await last.boundingBox();
  const barBox = await bar.boundingBox();
  expect(rowBox && barBox).toBeTruthy();
  if (rowBox && barBox)
    expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(barBox.y + 1);
  await capture(page, 'tracks-end', info.project.name);
  await owner.dispose();
});

test('KBC-130 AC-5: on /limites "Desfazer" brings the previous bound back', async ({
  page,
}, info) => {
  const owner = await ownerApi();
  const topic = await aCollection(owner);
  const media = await audioWithTracks(owner, undefined, topic);
  await approve(owner, media.id);
  await expect
    .poll(
      async () => {
        const edit = await owner.get(`/api/v1/media/${media.id}/edit`);
        return ((await edit.json()) as { preparation: unknown }).preparation;
      },
      { timeout: 30_000 },
    )
    .toBeNull();
  const library = await owner.get(
    `/api/v1/media/library?topic=${encodeURIComponent(topic)}`,
  );
  const { items } = (await library.json()) as {
    readonly items: readonly {
      readonly id: string;
      readonly tracks: readonly { readonly id: string }[];
    }[];
  };
  const first = items.find((one) => one.id === media.id)?.tracks[0];
  if (!first) throw new Error('no track');

  await page.goto(`/midia/${first.id}/limites`);
  const times = page.getByRole('paragraph').filter({ hasText: /^Início/ });
  await expect(times).toContainText('Início 0:00,0');
  await expect(page.getByText('Não salvo')).toHaveCount(0);
  await page.getByRole('button', { name: 'Mais 0,5 segundo' }).click();
  await expect(times).toContainText('0:00,5');
  await expect(page.getByText('Não salvo')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Salvar limites' }),
  ).toBeEnabled();
  await capture(page, 'bounds-adjusted', info.project.name);
  await page.getByRole('button', { name: 'Desfazer' }).click();
  await expect(times).toContainText('Início 0:00,0');
  await expect(page.getByText('Não salvo')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Salvar limites' }),
  ).toBeDisabled();
  await owner.dispose();
});

test('D5: the subject list of the last track rises above the approve bar and stays whole on screen', async ({
  page,
}, info) => {
  const owner = await ownerApi();
  const media = await audioWithTracks(owner);
  await approve(owner, media.id);
  await page.goto(`/midia/${media.id}/faixas`);
  await expect(page.getByRole('heading', { name: 'Assuntos' })).toBeVisible();
  const rows = page
    .getByRole('list', { name: 'Assuntos por faixa' })
    .getByRole('listitem')
    .filter({ has: page.locator('app-track-subject-row') });
  const last = rows.last();
  await last.scrollIntoViewIfNeeded();
  const field = last.getByRole('combobox', {
    name: /^Adicionar assunto à faixa/,
  });
  await field.click();
  await expect(field).toHaveAttribute('aria-expanded', 'true');
  const list = page.getByRole('listbox', { name: 'Assuntos do acervo' });
  await expect(list.getByRole('option').first()).toBeVisible();
  await expectInsideViewport(page, list);
  // Nothing covers it: its middle is its own (the approve bar and the panels stay under).
  const onTop = await list.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return hit !== null && element.contains(hit);
  });
  expect(onTop).toBe(true);
  await capture(page, 'subjects-last-open', info.project.name);
  await page.keyboard.press('Escape');
  await owner.dispose();
});
