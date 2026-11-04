import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { CSRF, expect } from './fixtures.js';
import { transcribedAudio } from './voices-helpers.js';

export interface SeedTrack {
  readonly startMs: number;
  readonly endMs: number;
  readonly title: string | null;
}

/** Saves a draft through the real route, as the screen would. */
export async function seedDraft(
  owner: APIRequestContext,
  mediaId: string,
  tracks: readonly SeedTrack[],
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

/** A minute of interview with three tracks in the draft. */
export async function audioWithTracks(
  owner: APIRequestContext,
  tracks: readonly SeedTrack[] = [
    { startMs: 0, endMs: 15_000, title: 'Primeira pergunta' },
    { startMs: 15_000, endMs: 40_000, title: 'Segunda pergunta' },
    { startMs: 40_000, endMs: 59_000, title: 'Terceira pergunta' },
  ],
) {
  const media = await transcribedAudio(owner);
  await seedDraft(owner, media.id, tracks);
  return media;
}

export async function approve(
  owner: APIRequestContext,
  mediaId: string,
): Promise<void> {
  const approved = await owner.post(`/api/v1/media/${mediaId}/edit/approve`, {
    data: {},
    headers: { ...CSRF, 'if-match': '"1"' },
  });
  expect(approved.status(), await approved.text()).toBe(200);
}

export const handle = (page: Page, name: string): Locator =>
  page.getByRole('slider', { name });

export const trackRow = (page: Page, ordinal: number): Locator =>
  page
    .getByRole('list', { name: 'Faixas' })
    .getByRole('listitem')
    .nth(ordinal - 1);

/** The server's draft, in seconds, by time. */
export async function draftTracks(owner: APIRequestContext, mediaId: string) {
  const read = await owner.get(`/api/v1/media/${mediaId}/edit`);
  const edit = (await read.json()) as {
    tracks: { startMs: number; endMs: number; title: string | null }[];
  };
  return edit.tracks;
}

/** Waits for "Rascunho salvo" and for the server to have `expected`. */
export async function expectSaved(
  owner: APIRequestContext,
  mediaId: string,
  check: (tracks: Awaited<ReturnType<typeof draftTracks>>) => boolean,
): Promise<void> {
  await expect
    .poll(async () => check(await draftTracks(owner, mediaId)), {
      timeout: 5_000,
    })
    .toBe(true);
}

/** Drags a handle to a time in the detail, pointer or finger, and releases it. */
export async function dragHandle(
  page: Page,
  input: { readonly name: string; readonly toFraction: number },
): Promise<void> {
  const detail = page.getByTestId('track-detail');
  const box = await detail.boundingBox();
  const grip = await handle(page, input.name).boundingBox();
  if (!box || !grip) throw new Error('the bar is not on screen');
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * input.toFraction, grip.y + 30, {
    steps: 6,
  });
  await page.mouse.up();
}
