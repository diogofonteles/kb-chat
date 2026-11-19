import type { Locator, Page } from '@playwright/test';
import { CSRF, expect, ownerApi, test } from './fixtures.js';
import { uniqueTag, uploadReady, type UploadedMedia } from './media-helpers.js';
import {
  activeCollection,
  chooseCollectionSlug,
  collectionBySlug,
  desktop,
  library,
  openMediaFromLibrary,
} from './shell-helpers.js';

/**
 * Owner, 2026-11-19 (KBC-152): the collection in use is the library's scope and is marked in
 * Sua biblioteca on every page. With the owner's shape — two top-level collections, one with
 * a sub-collection — the library of "Hermes" never lists the other top level, the library of
 * "UDV" lists its sub-collection too (ADR 0028 §6), the chosen row is green with
 * aria-current, the Biblioteca pin is not marked beside it, and a top-level collection
 * without sub-collections is never drawn as one of UDV's.
 */

interface World {
  readonly hermes: string;
  readonly udv: string;
  readonly palavra: string;
  readonly inHermes: UploadedMedia;
  readonly inUdv: UploadedMedia;
  readonly inPalavra: UploadedMedia;
  /** Hermes's audio held in processing: its transcription waits for a transcriber. */
  readonly heldInHermes: UploadedMedia;
}

let world: World;

async function created(
  api: Awaited<ReturnType<typeof ownerApi>>,
  title: string,
  parent: string | null = null,
): Promise<string> {
  const answer = await api.post('/api/v1/topics', {
    headers: CSRF,
    data: { title, parent },
  });
  expect(answer.status(), await answer.text()).toBe(201);
  return ((await answer.json()) as { slug: string }).slug;
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  const api = await ownerApi();
  const tag = uniqueTag();
  const hermes = await created(api, `Zz Hermes ${tag}`);
  const udv = await created(api, `Zz UDV ${tag}`);
  const palavra = await created(api, `Palavra ${tag}`, udv);
  const [inHermes, inUdv, inPalavra, heldInHermes] = await Promise.all([
    uploadReady(api, {
      title: `Aula hermética ${tag}`,
      seconds: 3,
      topic: hermes,
    }),
    uploadReady(api, { title: `Hinário ${tag}`, seconds: 3, topic: udv }),
    uploadReady(api, {
      title: `Palavra gravada ${tag}`,
      seconds: 3,
      topic: encodeURIComponent(palavra),
    }),
    uploadReady(api, {
      title: `Em processamento ${tag}`,
      seconds: 3,
      topic: hermes,
    }),
  ]);
  await holdInProcessing(api, heldInHermes.id);
  world = { hermes, udv, palavra, inHermes, inUdv, inPalavra, heldInHermes };
  await api.dispose();
});

/**
 * A plan that transcribes: the E2E server has no transcriber, so the audio stays in line
 * ("next") for as long as the test runs, as the queue's own specs hold theirs.
 */
async function holdInProcessing(
  api: Awaited<ReturnType<typeof ownerApi>>,
  mediaId: string,
): Promise<void> {
  const started = await api.post(`/api/v1/media/${mediaId}/preparation`, {
    data: {
      plan: {
        transcribe: true,
        speakers: false,
        tracks: 'none',
        subjects: false,
      },
    },
    headers: CSRF,
  });
  expect(started.status(), await started.text()).toBe(200);
  await expect
    .poll(async () => {
      const queue = (await (
        await api.get('/api/v1/media/processing')
      ).json()) as { items: { mediaId: string; phase: string }[] };
      return queue.items.find((item) => item.mediaId === mediaId)?.phase;
    })
    .toMatch(/^(running|next)$/);
}

/** How many audios of these collections the server has at work or in line. */
async function atWorkIn(topics: readonly string[]): Promise<number> {
  const api = await ownerApi();
  const queue = (await (await api.get('/api/v1/media/processing')).json()) as {
    items: { topic: string; phase: string }[];
  };
  await api.dispose();
  return queue.items.filter(
    ({ topic, phase }) =>
      topics.includes(topic) && (phase === 'running' || phase === 'next'),
  ).length;
}

/** The queue's block on the library: its title on a desktop, its one card on a phone. */
const queueBlock = (page: Page): Locator =>
  page.locator('app-library-page app-queue-summary');
const queueCount = (page: Page): Locator =>
  desktop(page)
    ? queueBlock(page).getByRole('heading', { level: 3 })
    : queueBlock(page).locator('.phone-card .name');

const list = (page: Page): Locator =>
  page.getByRole('region', { name: 'Todas' });

/** Closes the phone's Menu again after a look at it. */
async function closeMenu(page: Page): Promise<void> {
  if (!desktop(page)) await page.keyboard.press('Escape');
}

/** The library page itself (its list, its strips, its header on a desktop). */
const libraryPage = (page: Page): Locator => page.locator('app-library-page');

/** The scope the page names: the hero's title (desktop) or the phone's top row. */
const scopeName = (page: Page, name: RegExp): Locator =>
  desktop(page)
    ? page.locator('.library-scope')
    : page.getByText(name).locator('visible=true').first();

async function expectChosen(page: Page, slug: string): Promise<void> {
  const side = await library(page);
  const marked = activeCollection(side);
  await expect(marked).toHaveCount(1);
  await expect(marked).toHaveAttribute('data-slug', slug);
  // The chosen title in the accent green, not white (owner over the frame of cd13ba09).
  const colours = await marked
    .locator('.ui-libitem__title')
    .evaluate((title) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--color-accent-text)';
      document.body.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      return { title: getComputedStyle(title).color, accent };
    });
  expect(colours.title).toBe(colours.accent);
  // The library of one collection marks that row, never the Biblioteca pin too.
  await expect(
    side.getByRole('link', { name: 'Biblioteca', exact: true }),
  ).not.toHaveAttribute('aria-current', /.+/);
  await closeMenu(page);
}

test('the chosen collection is the library: Hermes alone, then UDV with its sub-collection, marked in Sua biblioteca', async ({
  page,
}) => {
  const { hermes, udv, inHermes, inUdv, inPalavra } = world;
  await page.goto('/');
  await chooseCollectionSlug(page, hermes);
  await openMediaFromLibrary(page, 'Biblioteca');
  await expect(page).toHaveURL(/\/biblioteca(\?|$)/);

  await expect(list(page)).toContainText(inHermes.title);
  // Nothing of UDV anywhere on the page: the list, the strips, the queue's block.
  await expect(libraryPage(page)).not.toContainText(inUdv.title);
  await expect(libraryPage(page)).not.toContainText(inPalavra.title);
  await expect(scopeName(page, /^Zz Hermes /)).toHaveText(/^Zz Hermes /);
  // The scope is the page's context, not a removable chip.
  await expect(
    page.getByRole('button', { name: /^Ver todos os acervos \(tirar/ }),
  ).toHaveCount(0);
  await expect(page.getByText('Acervo: ', { exact: false })).toHaveCount(0);
  await expectChosen(page, hermes);

  // Another collection in the sidebar: the library follows, its sub-collection included.
  await chooseCollectionSlug(page, udv);
  await expect(list(page)).toContainText(inUdv.title);
  await expect(list(page)).toContainText(inPalavra.title);
  await expect(libraryPage(page)).not.toContainText(inHermes.title);
  await expect(scopeName(page, /^Zz UDV /)).toHaveText(/^Zz UDV /);
  await expectChosen(page, udv);
});

test('"Todas as mídias" only by choice, and the chosen collection stays marked', async ({
  page,
}) => {
  const { hermes, inHermes, inUdv } = world;
  await page.goto('/');
  await chooseCollectionSlug(page, hermes);
  await openMediaFromLibrary(page, 'Biblioteca');
  await expect(list(page)).toContainText(inHermes.title);
  await page.getByRole('button', { name: 'Ver todas as mídias' }).click();
  await expect(page).toHaveURL(/acervos=todos/);
  await expect(list(page)).toContainText(inUdv.title);
  await expect(list(page)).toContainText(inHermes.title);
  if (desktop(page))
    await expect(page.locator('.library-scope')).toHaveText('Todas as mídias');
  // Every collection: Biblioteca is the page; the collection in use is still marked.
  const side = await library(page);
  await expect(
    side.getByRole('link', { name: 'Biblioteca', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(activeCollection(side)).toHaveAttribute('data-slug', hermes);
  await closeMenu(page);
  // Choosing a collection there ends "Todas as mídias".
  await chooseCollectionSlug(page, hermes);
  await expect(page).not.toHaveURL(/acervos=todos/);
  await expect(list(page)).toContainText(inHermes.title);
  await expect(libraryPage(page)).not.toContainText(inUdv.title);
});

test('a top-level collection is never drawn as a sub-collection of UDV', async ({
  page,
}) => {
  const { hermes, udv, palavra } = world;
  await page.goto('/biblioteca');
  const side = await library(page);
  const coverX = async (slug: string) => {
    const box = await collectionBySlug(side, slug)
      .locator('ui-cover')
      .boundingBox();
    if (!box) throw new Error(`no cover for ${slug}`);
    return box.x;
  };
  await expect(collectionBySlug(side, palavra)).toBeVisible();
  const [top, other, child] = await Promise.all([
    coverX(udv),
    coverX(hermes),
    coverX(palavra),
  ]);
  // Two top levels line up; the sub-collection sits clearly further in.
  expect(Math.abs(top - other)).toBeLessThan(1);
  expect(child - top).toBeGreaterThanOrEqual(12);
  await expect(
    side.locator('ul.children').locator(`[data-slug="${hermes}"]`),
  ).toHaveCount(0);
  await closeMenu(page);
});

test("the library's queue block keeps to its collection: Hermes's audio in processing never shows, nor counts, in UDV's", async ({
  page,
}) => {
  const { hermes, udv, palavra, heldInHermes } = world;
  await page.goto('/');
  await chooseCollectionSlug(page, hermes);
  await openMediaFromLibrary(page, 'Biblioteca');
  // Positive control: Hermes's library has it in its block, counted with Hermes's own.
  const inHermes = await atWorkIn([hermes]);
  expect(inHermes).toBeGreaterThanOrEqual(1);
  await expect(queueBlock(page)).toContainText(heldInHermes.title);
  await expect(queueCount(page)).toHaveText(
    inHermes === 1
      ? '1 áudio em processamento'
      : `${inHermes} áudios em processamento`,
  );

  await chooseCollectionSlug(page, udv);
  await expect(page).toHaveURL(/\/biblioteca(\?|$)/);
  await expect(scopeName(page, /^Zz UDV /)).toHaveText(/^Zz UDV /);
  // UDV's (and its sub-collection's) audios are still waiting for the transcriber here, so
  // the block stays, counting only them: never Hermes's audio.
  const inUdv = await atWorkIn([udv, palavra]);
  expect(inUdv).toBeGreaterThanOrEqual(1);
  await expect(queueCount(page)).toHaveText(
    inUdv === 1
      ? '1 áudio em processamento'
      : `${inUdv} áudios em processamento`,
  );
  await expect(queueBlock(page)).not.toContainText(heldInHermes.title);
});
