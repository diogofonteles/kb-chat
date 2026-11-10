import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
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
import {
  aCollection,
  makeMp3,
  uniqueTag,
  uploadReady,
} from './media-helpers.js';

/**
 * KBC-105 (ADR 0036, screens.md T14): in a collection with levels, a member chooses the level
 * of every audio she sends, from her own down; an audio above her is nowhere for her, and the
 * same file there is refused without a name. Each test makes its own collections (a scale
 * changes what everyone sees in one).
 */
const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;
const viewport = () => test.info().project.use.viewport ?? null;

const shots = process.env['KBC_SHOTS'];
async function shoot(page: Page, name: string): Promise<void> {
  if (shots)
    await page.screenshot({
      path: `${shots}/${name}-${page.viewportSize()?.width}.png`,
      fullPage: true,
    });
}

/** A collection of its own with the scale `codes`, lowest first; its slug and title. */
async function scaled(
  owner: APIRequestContext,
  codes: readonly string[],
): Promise<{ slug: string; title: string }> {
  const slug = await aCollection(owner);
  for (const code of codes) {
    const created = await owner.post(`/api/v1/topics/${slug}/levels`, {
      data: { code },
      headers: CSRF,
    });
    expect(created.status(), await created.text()).toBe(201);
  }
  const topic = await owner.get(`/api/v1/topics/${slug}/levels`);
  expect(topic.status()).toBe(200);
  const listed = await owner.get('/api/v1/topics');
  const { items } = (await listed.json()) as {
    items: { slug: string; title: string }[];
  };
  return { slug, title: items.find((one) => one.slug === slug)?.title ?? slug };
}

/** Ana, who sends audio, at `level` in the collections `topics` (the first is hers). */
async function member(
  owner: APIRequestContext,
  topics: readonly string[],
  levels: Record<string, string>,
): Promise<string> {
  const email = uniqueEmail('nivel-midia');
  const id = await invite(owner, email, {
    topics,
    features: ['search', 'media', 'media-upload'],
  });
  const placed = await owner.patch(`/api/v1/people/${id}`, {
    data: { levels },
    headers: CSRF,
  });
  expect(placed.status(), await placed.text()).toBe(200);
  return email;
}

async function openMedia(page: Page, title: string): Promise<void> {
  await page.goto('/');
  if (!desktop(page)) await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('link', { name: 'Mídia' }).click();
  await expect(
    page.getByRole('heading', { name: `Mídia — ${title}` }),
  ).toBeVisible();
}

const seriousViolations = async (page: Page) =>
  (
    await new AxeBuilder({ page }).include('dialog').analyze()
  ).violations.filter((violation) =>
    ['serious', 'critical'].includes(violation.impact ?? ''),
  );

test('AC-1, AC-2, AC-6, AC-7, AC-11: the member chooses her level, never sees above it, and the master sees the badge', async ({
  page,
  browser,
}) => {
  const owner = await ownerApi();
  const { slug, title } = await scaled(owner, ['QS', 'CI', 'CDC']);
  const email = await member(owner, [slug], { [slug]: 'ci' });
  const hidden = await uploadReady(owner, {
    title: `Velado ${uniqueTag()}`,
    seconds: 1,
    topic: slug,
    level: 'cdc',
  });
  // The same bytes as a file Ana will choose, kept at CDC (AC-7).
  const repeated = makeMp3(`repetido-${uniqueTag()}`, 1);
  const sha256 = createHash('sha256')
    .update(readFileSync(repeated))
    .digest('hex');
  const kept = await owner.post(`/api/v1/topics/${slug}/media`, {
    data: {
      title: `Guardado ${uniqueTag()}`,
      author: null,
      fileName: 'guardado.mp3',
      bytes: readFileSync(repeated).length,
      sha256,
      level: 'cdc',
    },
    headers: CSRF,
  });
  expect(kept.status(), await kept.text()).toBe(201);

  const ana = await pageAs(browser, email, viewport());
  await openMedia(ana, title);
  await expect(ana.getByText(hidden.title)).toHaveCount(0);
  await ana.getByRole('button', { name: 'Enviar áudio' }).first().click();
  const dialog = ana.getByRole('dialog', { name: 'Enviar áudio' });
  const own = `Minha palestra ${uniqueTag()}`;
  await dialog
    .locator('input[type="file"]')
    .setInputFiles(makeMp3(own.replace(/\s+/g, '_'), 2));
  const level = dialog.getByRole('group', { name: 'Nível' });
  await expect(level.getByRole('radio')).toHaveCount(2);
  await expect(level.getByRole('radio', { name: 'QS' })).not.toBeChecked();
  await expect(level.getByRole('radio', { name: 'CI' })).not.toBeChecked();
  await expect(level.getByText('CDC')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(level.getByRole('alert')).toHaveText(
    /Escolha o nível deste áudio\./,
  );
  await expect(dialog).toBeVisible();
  expect(await seriousViolations(ana)).toEqual([]);
  await shoot(ana, 'upload-level-missing');
  await level.getByRole('radio', { name: 'CI' }).check();
  await dialog.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(dialog).toBeHidden();
  const row = ana.getByRole('listitem').filter({ hasText: own });
  await expect(row).toBeVisible();
  await expect(row.getByText('Pronta')).toBeVisible({ timeout: 30_000 });
  // Members see no badge (ADR 0036 §9).
  await expect(ana.getByText(/Nível:/)).toHaveCount(0);
  await shoot(ana, 'list-member');

  // AC-7: the same file at a level she does not see is named nowhere.
  await ana.getByRole('button', { name: 'Enviar áudio' }).first().click();
  await dialog.locator('input[type="file"]').setInputFiles(repeated);
  await expect(
    dialog.getByText(
      'Este arquivo já está no acervo, num nível que você não vê. Fale com um master.',
    ),
  ).toBeVisible();
  await expect(dialog.getByRole('link')).toHaveCount(0);
  await shoot(ana, 'upload-duplicate-hidden');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();

  // AC-11: the master sees every audio with its level on the library's lines.
  await page.goto(`/biblioteca?acervo=${encodeURIComponent(slug)}`);
  const all = page.getByRole('region', { name: 'Todas' });
  await expect(
    all
      .getByRole('listitem')
      .filter({ hasText: hidden.title })
      .getByText('Nível: CDC'),
  ).toBeVisible();
  await expect(
    all.getByRole('listitem').filter({ hasText: own }).getByText('Nível: CI'),
  ).toBeVisible();
  await shoot(page, 'library-master');
  await ana.context().close();
  await owner.dispose();
});

test('AC-9: moving her audio to another collection with levels asks for a level there', async ({
  browser,
}) => {
  const owner = await ownerApi();
  const home = await scaled(owner, ['QS', 'CI', 'CDC']);
  const other = await scaled(owner, ['A1', 'A2']);
  const email = await member(owner, [home.slug, other.slug], {
    [home.slug]: 'ci',
  });
  const ana = await pageAs(browser, email, viewport());
  const audio = await uploadReady(ana.request, {
    title: `Para mover ${uniqueTag()}`,
    seconds: 1,
    topic: home.slug,
    level: 'ci',
  });

  await ana.goto(`/midia/${audio.id}`);
  await ana.getByRole('button', { name: 'Editar informações' }).click();
  const editor = ana.getByRole('dialog', { name: 'Editar informações' });
  await expect(
    editor.getByRole('group', { name: 'Nível' }).getByRole('radio', {
      name: 'CI',
    }),
  ).toBeChecked();
  await editor.getByLabel('Acervo', { exact: true }).selectOption(other.slug);
  const there = editor.getByRole('group', { name: `Nível em ${other.title}` });
  await expect(there).toBeVisible();
  // She holds the lowest level there (no entry): only A1 is hers to give.
  await expect(there.getByRole('radio')).toHaveCount(1);
  await expect(there.getByRole('radio', { name: 'A1' })).not.toBeChecked();
  await editor.getByRole('button', { name: 'Salvar' }).click();
  await expect(there.getByRole('alert')).toHaveText(
    /Escolha o nível deste áudio\./,
  );
  await shoot(ana, 'edit-level-move');
  await there.getByRole('radio', { name: 'A1' }).check();
  await editor.getByRole('button', { name: 'Salvar' }).click();
  await expect(editor).toBeHidden();

  const item = await ana.request.get(`/api/v1/media/${audio.id}`);
  expect(await item.json()).toMatchObject({
    topic: other.slug,
    level: { id: 'a1', code: 'A1' },
  });
  await ana.context().close();
  await owner.dispose();
});

test('review round 2: with the levels failed nothing is sent, and "Carregar níveis de novo" brings them back', async ({
  browser,
}) => {
  const owner = await ownerApi();
  const { slug, title } = await scaled(owner, ['QS', 'CI']);
  const email = await member(owner, [slug], { [slug]: 'ci' });
  const ana = await pageAs(browser, email, viewport());
  await ana.route('**/media/levels', (route) =>
    route.fulfill({ status: 503, body: '' }),
  );
  await openMedia(ana, title);
  await ana.getByRole('button', { name: 'Enviar áudio' }).first().click();
  const dialog = ana.getByRole('dialog', { name: 'Enviar áudio' });
  await dialog
    .locator('input[type="file"]')
    .setInputFiles(makeMp3(`falha-${uniqueTag()}`, 1));
  const created: string[] = [];
  ana.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      request.url().endsWith(`/topics/${slug}/media`)
    )
      created.push(request.url());
  });
  await dialog.getByRole('button', { name: 'Enviar', exact: true }).click();
  const retry = dialog.getByRole('button', { name: 'Carregar níveis de novo' });
  await expect(retry).toBeFocused();
  await expect(dialog.getByRole('alert')).toHaveText(
    /Não consegui carregar os níveis deste acervo\. Carregue de novo para escolher o nível\./,
  );
  expect(created).toEqual([]);
  expect(await seriousViolations(ana)).toEqual([]);
  await shoot(ana, 'upload-levels-failed');

  await ana.unroute('**/media/levels');
  await retry.click();
  const level = dialog.getByRole('group', { name: 'Nível' });
  await expect(level.getByRole('radio', { name: 'QS' })).toBeFocused();
  await ana.context().close();
  await owner.dispose();
});

test('review round 3: a send held for the levels that then fail leaves the focus on "Carregar níveis de novo"', async ({
  browser,
}) => {
  const owner = await ownerApi();
  const { slug, title } = await scaled(owner, ['QS', 'CI']);
  const other = await scaled(owner, ['A1']);
  const email = await member(owner, [slug, other.slug], { [slug]: 'ci' });
  const ana = await pageAs(browser, email, viewport());
  let failNow: () => void = () => undefined;
  const asked = new Promise<void>((resolve) => (failNow = resolve));
  await openMedia(ana, title);
  await ana.getByRole('button', { name: 'Enviar áudio' }).first().click();
  const dialog = ana.getByRole('dialog', { name: 'Enviar áudio' });
  await dialog
    .locator('input[type="file"]')
    .setInputFiles(makeMp3(`espera-${uniqueTag()}`, 1));
  await expect(dialog.getByRole('group', { name: 'Nível' })).toBeVisible();
  // The other collection's levels are held, then fail.
  await ana.route(`**/topics/${other.slug}/media/levels`, async (route) => {
    await asked;
    await route.fulfill({ status: 503, body: '' });
  });
  await dialog.getByLabel(/^Acervo/).selectOption(other.slug);
  const send = dialog.getByRole('button', { name: 'Enviar', exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  const waiting = dialog.getByRole('button', { name: 'Carregando níveis…' });
  await expect(waiting).toBeFocused();
  failNow();
  await expect(
    dialog.getByRole('button', { name: 'Carregar níveis de novo' }),
  ).toBeFocused();
  await shoot(ana, 'upload-levels-failed-after-wait');
  await ana.context().close();
  await owner.dispose();
});
