import { randomUUID } from 'node:crypto';
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
import { aCollection, uploadReady, uniqueTag } from './media-helpers.js';
import { seedTranscript } from './voices-helpers.js';

/**
 * KBC-106 (ADR 0036 §3, screens.md T15 and T20): a track above its recording's level. Ana, at
 * the recording's level, hears the recording with that track skipped ("Trecho restrito"), its
 * text gone from the transcript and from "Na fala"; the editor chooses the level on the
 * track's row. Real audio cut by the E2E's media worker, in Chrome and WebKit (NFR-1).
 */

const shots = process.env['KBC_SHOTS'];
async function shoot(page: Page, name: string): Promise<void> {
  if (shots)
    await page.screenshot({
      path: `${shots}/${name}-${page.viewportSize()?.width}.png`,
      fullPage: true,
    });
}

const TRACKS = [
  { startMs: 0, endMs: 15_000, title: 'Primeira pergunta', level: null },
  { startMs: 15_000, endMs: 40_000, title: 'Pergunta sensível', level: 'cdc' },
  { startMs: 40_000, endMs: 59_000, title: 'Terceira pergunta', level: null },
];

/** A collection of its own with QS < CI < CDC. */
async function scaled(owner: APIRequestContext): Promise<string> {
  const slug = await aCollection(owner);
  for (const code of ['QS', 'CI', 'CDC']) {
    const created = await owner.post(`/api/v1/topics/${slug}/levels`, {
      data: { code },
      headers: CSRF,
    });
    expect(created.status(), await created.text()).toBe(201);
  }
  return slug;
}

/** Saves the draft, `levels` per track as given (null: the recording's). */
async function draft(
  owner: APIRequestContext,
  mediaId: string,
  tracks: readonly {
    startMs: number;
    endMs: number;
    title: string;
    level: string | null;
  }[],
): Promise<void> {
  const saved = await owner.put(`/api/v1/media/${mediaId}/edit`, {
    data: {
      step: 3,
      tracks: tracks.map((track) => ({
        ...track,
        id: randomUUID(),
        source: 'manual',
        kind: 'qa',
        askerVoice: null,
        answererVoice: null,
        askerSpeakerId: null,
        answererSpeakerId: null,
      })),
    },
    headers: { ...CSRF, 'if-match': '"0"' },
  });
  expect(saved.status(), await saved.text()).toBe(200);
}

/** Approves the draft and waits for the real worker to cut and publish every track. */
async function approved(owner: APIRequestContext, mediaId: string) {
  const done = await owner.post(`/api/v1/media/${mediaId}/edit/approve`, {
    data: {},
    headers: { ...CSRF, 'if-match': '"1"' },
  });
  expect(done.status(), await done.text()).toBe(200);
  await expect
    .poll(
      async () => {
        const edit = await owner.get(`/api/v1/media/${mediaId}/edit`);
        return ((await edit.json()) as { preparation: unknown }).preparation;
      },
      { timeout: 60_000 },
    )
    .toBeNull();
}

/** A CI recording of a minute, transcribed, in a scaled collection of its own. */
async function recording(owner: APIRequestContext) {
  const topic = await scaled(owner);
  const media = await uploadReady(owner, {
    title: `Palestra ${uniqueTag()}`,
    seconds: 60,
    topic,
    level: 'ci',
  });
  await seedTranscript(owner, media.id);
  return { ...media, topic };
}

/** Ana, at CI in `topic`, who listens, sees tracks and searches. */
async function ana(owner: APIRequestContext, topic: string): Promise<string> {
  const email = uniqueEmail('faixa-nivel');
  const id = await invite(owner, email, {
    topics: [topic],
    features: ['search', 'media', 'media-tracks'],
  });
  const placed = await owner.patch(`/api/v1/people/${id}`, {
    data: { levels: { [topic]: 'ci' } },
    headers: CSRF,
  });
  expect(placed.status(), await placed.text()).toBe(200);
  return email;
}

/** Every position the engine's element passes through, sampled each frame. */
async function watchPositions(page: Page): Promise<void> {
  await page.evaluate(() => {
    const element = document.querySelector<HTMLMediaElement>(
      '[data-media-engine]',
    );
    const seen: number[] = [];
    (window as unknown as { seen: number[] }).seen = seen;
    const tick = () => {
      if (element && !element.paused) seen.push(element.currentTime);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

const positions = (page: Page) =>
  page.evaluate(() => (window as unknown as { seen: number[] }).seen);

const engineTime = (page: Page) =>
  page
    .locator('[data-media-engine]')
    .evaluate((element) => (element as HTMLMediaElement).currentTime);

test('AC-2, NFR-1: Ana hears the recording with track 2 skipped as "Trecho restrito", and its text is nowhere for her', async ({
  browser,
  viewport,
}) => {
  const owner = await ownerApi();
  const media = await recording(owner);
  await draft(owner, media.id, TRACKS);
  await approved(owner, media.id);
  const email = await ana(owner, media.topic);
  await owner.dispose();

  const page = await pageAs(browser, email, viewport);
  const item = await page.request.get(`/api/v1/media/${media.id}`);
  const { hidden } = (await item.json()) as {
    hidden?: { startMs: number; endMs: number }[];
  };
  expect(hidden).toHaveLength(1);
  const span = hidden?.[0] ?? { startMs: 15_000, endMs: 40_000 };
  expect(span.startMs).toBeGreaterThanOrEqual(14_900);
  expect(span.endMs).toBeLessThanOrEqual(41_000);

  await page.goto(`/midia/${media.id}?t=12`);
  const player = page.getByRole('region', { name: 'Player' });
  const restricted = player.getByTestId('restricted');
  await expect(restricted.locator('.restricted')).toHaveCount(1);
  if ((viewport?.width ?? 0) >= 600)
    await expect(restricted.getByText('Trecho restrito')).toBeVisible();
  await expect(
    page.getByRole('slider', { name: 'Posição' }),
  ).toHaveAccessibleDescription(/Trecho restrito de 0:1\d a 0:4\d, pulado\./);

  // The transcript keeps its place for the part and names it; its words are not there.
  const transcript = page.getByRole('list', { name: 'Trechos da transcrição' });
  await expect(transcript.getByText('Trecho restrito').first()).toBeVisible();
  await expect(transcript).toContainText('vegetal');
  await expect(transcript).not.toContainText('construção');
  await expect(transcript).not.toContainText('chegou lá');
  // Track 2 is not in the list of tracks either.
  await expect(player.getByText('Primeira pergunta')).toBeVisible();
  await expect(page.getByText('Pergunta sensível')).toHaveCount(0);
  await shoot(page, 'track-levels-player');

  await watchPositions(page);
  await page.getByRole('button', { name: 'Tocar', exact: true }).click();
  await expect
    .poll(() => engineTime(page), { timeout: 30_000 })
    .toBeGreaterThan(span.endMs / 1000 + 0.5);
  // NFR-1: never more than 250 ms played inside the restricted part.
  const inside = (await positions(page)).filter(
    (at) => at >= span.startMs / 1000 && at < span.endMs / 1000,
  );
  const deepest = inside.length > 0 ? Math.max(...inside) : span.startMs / 1000;
  expect(deepest - span.startMs / 1000).toBeLessThanOrEqual(0.25);

  // "Na fala" finds nothing said inside the track, and still finds the rest.
  const asked = async (q: string) => {
    const found = await page.request.post(
      `/api/v1/topics/${media.topic}/searches`,
      { data: { q, kinds: ['audio'] }, headers: CSRF },
    );
    expect(found.status(), await found.text()).toBe(200);
    return (await found.json()) as {
      kinds: { audio: number | null };
      media: unknown[];
    };
  };
  const secret = await asked('construção');
  expect(secret.kinds.audio ?? 0).toBe(0);
  expect(JSON.stringify(secret)).not.toContain('construção');
  expect((await asked('vegetal')).kinds.audio).toBeGreaterThan(0);
  await page.context().close();
});

test('a landing inside the restricted part goes on to its end', async ({
  browser,
  viewport,
}) => {
  const owner = await ownerApi();
  const media = await recording(owner);
  await draft(owner, media.id, TRACKS);
  await approved(owner, media.id);
  const email = await ana(owner, media.topic);
  await owner.dispose();
  const page = await pageAs(browser, email, viewport);
  await page.goto(`/midia/${media.id}?t=25`);
  await expect.poll(() => engineTime(page)).toBeGreaterThanOrEqual(39.9);
  await page.context().close();
});

test('AC-1, FR-5: the editor gives track 2 its own level on its row, offered from the recording up', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await recording(owner);
  await draft(
    owner,
    media.id,
    TRACKS.map((track) => ({ ...track, level: null })),
  );
  await page.goto(`/midia/${media.id}/faixas`);
  const row = page
    .getByRole('list', { name: 'Faixas' })
    .getByRole('listitem')
    .nth(1);
  await row.getByRole('button').first().click();
  const field = row.getByRole('combobox', { name: 'Nível' });
  await expect(field.locator('option')).toHaveText([
    'O da gravação (CI)',
    'CDC',
  ]);
  await field.selectOption('cdc');
  await expect(row.getByText('Nível: CDC')).toBeVisible();
  await expect
    .poll(async () => {
      const edit = await owner.get(`/api/v1/media/${media.id}/edit`);
      return (
        (await edit.json()) as { tracks: { level: string | null }[] }
      ).tracks.map((track) => track.level);
    })
    .toEqual([null, 'cdc', null]);
  await shoot(page, 'track-levels-row');
  await owner.dispose();
});

test('KBC-106 decision: an editor below track 2 is told why instead of getting the editor', async ({
  browser,
  viewport,
}) => {
  const owner = await ownerApi();
  const media = await recording(owner);
  await draft(owner, media.id, TRACKS);
  await approved(owner, media.id);
  const email = uniqueEmail('editor-abaixo');
  const id = await invite(owner, email, {
    topics: [media.topic],
    features: ['search', 'media', 'media-tracks', 'media-edit'],
  });
  const placed = await owner.patch(`/api/v1/people/${id}`, {
    data: { levels: { [media.topic]: 'ci' } },
    headers: CSRF,
  });
  expect(placed.status(), await placed.text()).toBe(200);
  await owner.dispose();
  const page = await pageAs(browser, email, viewport);
  await page.goto(`/midia/${media.id}/faixas`);
  await expect(
    page.getByRole('alert').filter({
      hasText:
        'Esta gravação tem faixas acima do seu nível. Só quem tem todos os níveis dela pode editá-la.',
    }),
  ).toBeVisible();
  await expect(page.getByRole('list', { name: 'Faixas' })).toHaveCount(0);
  await expect(page.getByText('Pergunta sensível')).toHaveCount(0);
  await shoot(page, 'track-levels-editor-refused');
  await page.context().close();
});
