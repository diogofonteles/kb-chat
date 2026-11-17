import type { APIRequestContext, Page } from '@playwright/test';
import {
  CSRF,
  expect,
  invite,
  ownerApi,
  pageAs,
  uniqueEmail,
} from './fixtures.js';
import { aCollectionInVault, uniqueTag, uploadReady } from './media-helpers.js';
import { approve, seedDraft } from './tracks-helpers.js';
import { rawOf, seedTranscript } from './transcript-helpers.js';

/*
 * A track published as a document of the collection, cited by the research (KBC-099, T22),
 * shared by the specs of the audio source (KBC-099, KBC-150).
 */

export const TITLE = 'O que é o ritmo?';
export const SPEECH = [
  { at: 2, text: 'Pergunta sobre o ritmo de tudo' },
  { at: 41, text: 'O ritmo é a lei do pêndulo que tudo governa' },
  { at: 50, text: 'Tudo flui para fora e para dentro' },
  { at: 65, text: 'Outra pergunta sobre a polaridade' },
];

/** Waits for the real worker to cut and publish every track. */
async function published(owner: APIRequestContext, mediaId: string) {
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

/** A collection of its own with one recording, two tracks published through the Mac. */
export async function publishedTrack(
  owner: APIRequestContext,
  speech: readonly { at: number; text: string }[] = SPEECH,
): Promise<string> {
  const topic = await aCollectionInVault(owner);
  const media = await uploadReady(owner, {
    title: `Palestra ${uniqueTag()}`,
    seconds: 90,
    topic,
  });
  await seedTranscript(owner, { id: media.id, raw: rawOf(speech) });
  await seedDraft(owner, media.id, [
    { startMs: 0, endMs: 60_000, title: TITLE },
    { startMs: 60_000, endMs: 89_000, title: 'E a polaridade?' },
  ]);
  await approve(owner, media.id);
  await published(owner, media.id);
  const ran = await owner.post('/api/e2e/kb-publish/run', {
    data: { topic },
    headers: CSRF,
  });
  expect(ran.status(), await ran.text()).toBe(200);
  expect(((await ran.json()) as { documents: number }).documents).toBe(2);
  return topic;
}

/** A researcher of that collection only, with the tracks (FR-10). */
export async function researcher(
  page: Page,
  topic: string,
  {
    features = [
      'search',
      'research',
      'media',
      'media-tracks',
      'media-research',
    ],
    viewport = page.viewportSize(),
  }: {
    readonly features?: readonly string[];
    readonly viewport?: { width: number; height: number } | null;
  } = {},
): Promise<Page> {
  const email = uniqueEmail('faixas');
  const owner = await ownerApi();
  await invite(owner, email, { topics: [topic], features });
  await owner.dispose();
  const browser = page.context().browser();
  if (!browser) throw new Error('no browser');
  const member = await pageAs(browser, email, viewport);
  await member.goto('/');
  const skip = member.getByRole('button', { name: 'Pular' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await expect(member.getByLabel('Sua pergunta')).toBeVisible();
  return member;
}

export async function ask(page: Page) {
  await page.getByLabel('Sua pergunta').fill('pêndulo');
  await page.getByRole('button', { name: 'Perguntar' }).click();
  const answer = page.locator('app-research-message').last();
  await expect(answer.getByText(/Resposta gerada por IA/)).toBeVisible({
    timeout: 30_000,
  });
  return answer;
}

const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

/** The phone's reading sheet (KBC-127 FR-2): one tab per source of the answer. */
export const readingSheet = (page: Page) =>
  page.getByRole('dialog', { name: 'Fonte' });

/**
 * The audio source of a cited track (KBC-150): the panel beside the answer on a desktop, the
 * reading sheet's tab panel on a phone.
 */
export const audioSource = (page: Page) =>
  isDesktop(page)
    ? page.getByRole('dialog', { name: /^Trecho da faixa/ })
    : readingSheet(page).locator('app-track-passage-panel');

/** ✕: the panel's own on a desktop, the sheet's on a phone. */
export async function closeAudioSource(page: Page): Promise<void> {
  const where = isDesktop(page) ? audioSource(page) : readingSheet(page);
  await where
    .getByRole('button', { name: 'Fechar', exact: true })
    .first()
    .click();
}
