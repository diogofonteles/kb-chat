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
import { TURNS, transcribedAudio } from './voices-helpers.js';

// KBC-064: "Separar vozes" on the audio page, for whoever edits recordings. The E2E server
// stores the transcript and the turns through the real paths (E2E-only routes), as a
// transcriber would; no spec leases through the worker routes.

const seriousViolations = async (page: Page, include: string) =>
  (await new AxeBuilder({ page }).include(include).analyze()).violations.filter(
    (violation) => ['serious', 'critical'].includes(violation.impact ?? ''),
  );

const voicesBlock = (page: Page) => page.getByRole('region', { name: 'Vozes' });

for (const theme of ['light', 'dark', 'esoteric'] as const) {
  test(`AC-1, AC-8, AC-9: an editor separates the voices and sees "Voz N" (${theme} theme, axe)`, async ({
    page,
  }) => {
    await useTheme(page, theme);
    const owner = await ownerApi();
    const media = await transcribedAudio(owner);
    await page.goto(`/midia/${media.id}`);
    const block = voicesBlock(page);
    await expect(block.getByRole('heading', { name: 'Vozes' })).toBeVisible();
    await expect(block).toContainText('nenhuma impressão de voz é guardada');
    expect(await seriousViolations(page, 'app-voices-panel')).toEqual([]);

    await block.getByRole('button', { name: 'Separar vozes' }).click();
    // No transcriber in the E2E run is marked to separate voices (AC-9), unless a local
    // check paired one: then it waits for it.
    await expect(block.getByRole('status')).toHaveText(
      /^(Nenhum transcritor separa vozes; marque em Transcritores|Aguardando o transcritor.*)$/,
    );
    await expect(
      block.getByRole('button', { name: /Separar vozes/ }),
    ).toHaveCount(0);

    const leased = await owner.post(
      `/api/e2e/media/${media.id}/diarization/lease`,
      { headers: CSRF },
    );
    expect(leased.status()).toBe(204);
    await page.reload();
    await expect(voicesBlock(page).getByRole('status')).toHaveText(
      'Separando vozes…',
    );

    const done = await owner.post(`/api/e2e/media/${media.id}/diarization`, {
      data: { turns: TURNS },
      headers: CSRF,
    });
    expect(done.status(), await done.text()).toBe(204);
    await owner.dispose();
    // The block asks again every few seconds while the separation runs.
    await expect(voicesBlock(page).getByRole('status')).toHaveText(
      'Vozes separadas: 3',
    );
    const voices = voicesBlock(page)
      .getByRole('list', { name: 'Vozes encontradas' })
      .getByRole('listitem');
    await expect(voices.nth(0)).toContainText(/Voz 1\s+0:12 de fala/);
    await expect(voices.nth(1)).toContainText(/Voz 2\s+0:41 de fala/);
    await expect(voices.nth(2)).toContainText(/Voz 3\s+0:05 de fala/);
    await expect(
      voicesBlock(page).getByRole('button', { name: 'Separar vozes de novo' }),
    ).toBeVisible();
    expect(await seriousViolations(page, 'app-voices-panel')).toEqual([]);
    // The transcript beside the player labels each change of voice (FR-5).
    const transcript = page.getByRole('list', {
      name: 'Trechos da transcrição',
    });
    await expect(transcript.getByText(/^Voz \d+$/)).toHaveText([
      'Voz 1',
      'Voz 2',
      'Voz 1',
      'Voz 2',
      'Voz 3',
      'Voz 2',
    ]);
    expect(await seriousViolations(page, 'app-transcript-panel')).toEqual([]);
  });
}

test('AC-6: "número de vozes" travels with the request and a wrong one is said at the field', async ({
  page,
}) => {
  const owner = await ownerApi();
  const media = await transcribedAudio(owner);
  await page.goto(`/midia/${media.id}`);
  const block = voicesBlock(page);
  const field = block.getByLabel('Número de vozes (opcional)');
  await field.fill('11');
  await block.getByRole('button', { name: 'Separar vozes' }).click();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(block).toContainText(
    'Informe um número de 1 a 10, ou deixe em branco.',
  );
  await field.fill('2');
  await block.getByRole('button', { name: 'Separar vozes' }).click();
  await expect(block.getByRole('status')).toHaveText(
    /Nenhum transcritor separa vozes|Aguardando o transcritor/,
  );
  const done = await owner.post(`/api/e2e/media/${media.id}/diarization`, {
    data: {
      turns: TURNS.map((turn) =>
        turn.voice === 'SPEAKER_03' ? { ...turn, voice: 'SPEAKER_02' } : turn,
      ),
    },
    headers: CSRF,
  });
  expect(done.status()).toBe(204);
  const speakers = (await (
    await owner.get(`/api/v1/media/${media.id}/speakers`)
  ).json()) as { diarization: { requestedVoices: number; voiceCount: number } };
  expect(speakers.diarization).toMatchObject({
    requestedVoices: 2,
    voiceCount: 2,
  });
  await owner.dispose();
  await page.reload();
  await expect(voicesBlock(page).getByRole('status')).toHaveText(
    'Vozes separadas: 2',
  );
});

test('AC-2: a person who only listens sees no voices and the API refuses them', async ({
  browser,
  viewport,
}) => {
  const owner = await ownerApi();
  const media = await transcribedAudio(owner);
  const asked = await owner.post(`/api/v1/media/${media.id}/diarize`, {
    data: {},
    headers: CSRF,
  });
  expect(asked.status()).toBe(202);
  const separated = await owner.post(`/api/e2e/media/${media.id}/diarization`, {
    data: { turns: TURNS },
    headers: CSRF,
  });
  expect(separated.status(), await separated.text()).toBe(204);
  const email = uniqueEmail('ouvinte-vozes');
  await invite(owner, email, { topics: ['hermetismo'], features: ['media'] });
  await owner.dispose();
  const page = await pageAs(browser, email, viewport);
  await page.goto(`/midia/${media.id}`);
  await expect(
    page.getByRole('heading', { name: media.title, level: 2 }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Vozes' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Separar vozes/ })).toHaveCount(
    0,
  );
  // The transcript is there, with no voice labels, and its body carries no voices.
  await expect(
    page.getByText('Mestre, o senhor está lembrado daquele dia?'),
  ).toBeVisible();
  await expect(page.getByText(/^Voz \d+$/)).toHaveCount(0);
  const transcript = await page.request.get(
    `/api/v1/media/${media.id}/transcript`,
  );
  expect(transcript.status()).toBe(200);
  expect(await transcript.json()).not.toHaveProperty('speakers');
  const refused = await page.request.post(`/api/v1/media/${media.id}/diarize`, {
    data: {},
    headers: CSRF,
  });
  expect(refused.status()).toBe(403);
  const read = await page.request.get(`/api/v1/media/${media.id}/speakers`);
  expect(read.status()).toBe(403);
  await page.context().close();
});
