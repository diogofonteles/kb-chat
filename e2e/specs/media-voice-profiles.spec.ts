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
import { TURNS, separateVoices, transcribedAudio } from './voices-helpers.js';

// KBC-071: voice profiles. A master has the feature by the role; a member never has it.
// Everything here is synthetic: the E2E server plays the Mac with a made-up vector, and no
// voice print is ever made from a recording.

const TOPIC = 'hermetismo';
const PROFILES = `/api/v1/topics/${TOPIC}/voice-profiles`;
const SPEAKERS = `/api/v1/topics/${TOPIC}/speakers`;
const ANSWERS = 2;

const aConsent = {
  subject: 'living',
  grantedBy: 'Pessoa de teste',
  grantedByRole: null,
  grantedOn: '2026-10-01',
  method: 'email',
  purpose: 'suggest-names-when-editing',
  textVersion: 2,
  evidence: { kind: 'text', text: 'Autorizo o uso da minha voz (teste).' },
};

/** The ⚙ dialog: in the side panel on desktop, in the "Menu" drawer on phones. */
async function openSettings(page: Page) {
  if ((page.viewportSize()?.width ?? 0) < 1024)
    await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Configurações' }).click();
  return page.getByRole('dialog', { name: 'Configurações' });
}

/** A person's first visit: past the first-run wizard, at home. */
async function firstVisit(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Pular' }).click();
  // Closed only once the skip is saved: a navigation before that cancels the save, and
  // the wizard comes back over the next page (it hid the voices from a click).
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function openPanel(page: Page) {
  const dialog = await openSettings(page);
  await dialog.getByRole('button', { name: 'Perfis de voz' }).click();
  await expect(
    dialog.getByRole('heading', { name: 'Perfis de voz', level: 3 }),
  ).toBeVisible();
  await dialog.getByLabel('Acervo', { exact: true }).selectOption(TOPIC);
  return dialog;
}

/** A master, signed in, with the API of that browser. */
async function aMaster(
  browser: Parameters<typeof pageAs>[0],
  viewport: Parameters<typeof pageAs>[2],
) {
  const owner = await ownerApi();
  const email = uniqueEmail('master-voz');
  await invite(owner, email, {
    role: 'master',
    topics: [TOPIC],
    features: ['media', 'media-edit'],
  });
  const page = await pageAs(browser, email, viewport);
  return { owner, page, email };
}

const post = async (api: APIRequestContext, url: string, data: object) =>
  api.post(url, { data, headers: CSRF });

/** A speaker named on the answering voice of a new recording. */
async function namedVoice(api: APIRequestContext, owner: APIRequestContext) {
  const speakerName = `Pessoa ${crypto.randomUUID().slice(0, 8)}`;
  const created = await post(api, SPEAKERS, { name: speakerName });
  expect(created.status(), await created.text()).toBe(201);
  const speaker = (await created.json()) as { id: string };
  const media = await transcribedAudio(owner);
  await separateVoices(owner, media.id);
  const named = await api.put(`/api/v1/media/${media.id}/voices/${ANSWERS}`, {
    data: { version: 1, speakerId: speaker.id, audience: false },
    headers: CSRF,
  });
  expect(named.status(), await named.text()).toBe(200);
  return { speakerName, speakerId: speaker.id, mediaId: media.id };
}

async function storedProfile(api: APIRequestContext, owner: APIRequestContext) {
  const voice = await namedVoice(api, owner);
  const created = await post(api, PROFILES, {
    speakerId: voice.speakerId,
    sources: [{ mediaId: voice.mediaId, voice: ANSWERS }],
    consent: aConsent,
  });
  expect(created.status(), await created.text()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const printed = await owner.post(`/api/e2e/voice-profiles/${id}/print`, {
    headers: CSRF,
  });
  expect(printed.status(), await printed.text()).toBe(204);
  return { ...voice, profileId: id };
}

async function suggested(owner: APIRequestContext, profileId: string) {
  const media = await transcribedAudio(owner);
  await separateVoices(owner, media.id, {
    turns: TURNS,
    voiceMatches: [{ voice: 'SPEAKER_01', profileId, similarity: 0.62 }],
  });
  return media.id;
}

test('AC-7: a member with `media-edit` sees no screen and the API refuses', async ({
  browser,
  viewport,
}) => {
  const owner = await ownerApi();
  const email = uniqueEmail('edita-voz');
  await invite(owner, email, {
    topics: [TOPIC],
    features: ['media', 'media-edit'],
  });
  const page = await pageAs(browser, email, viewport);
  await page.goto('/');
  const dialog = await openSettings(page);
  await expect(dialog.getByRole('heading').first()).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Perfis de voz' }),
  ).toHaveCount(0);
  const refused = await page.request.get(PROFILES);
  expect(refused.status()).toBe(403);
});

test('a master has the screen with no grant by name', async ({
  browser,
  viewport,
}) => {
  const owner = await ownerApi();
  const email = uniqueEmail('master-voz');
  await invite(owner, email, { role: 'master', topics: [TOPIC] });
  const page = await pageAs(browser, email, viewport);
  expect((await page.request.get(PROFILES)).status()).toBe(200);
  await firstVisit(page);
  await expect(
    (await openPanel(page)).getByText('Cadastrar perfil'),
  ).toBeVisible();
});

test('AC-1: the consent comes first, on screen and at the API (axe)', async ({
  browser,
  viewport,
}) => {
  const { owner, page } = await aMaster(browser, viewport);
  const voice = await namedVoice(page.request, owner);
  const refused = await post(page.request, PROFILES, {
    speakerId: voice.speakerId,
    sources: [{ mediaId: voice.mediaId, voice: ANSWERS }],
  });
  expect(refused.status()).toBe(422);

  await firstVisit(page);
  const dialog = await openPanel(page);
  await dialog.getByRole('button', { name: 'Cadastrar perfil' }).click();
  await expect(dialog.getByText('Consentimento específico')).toBeVisible();
  await expect(dialog.getByText('De quais vozes calcular')).toHaveCount(0);
  await dialog.getByLabel('Pessoa', { exact: true }).selectOption({
    label: voice.speakerName,
  });
  await dialog.getByRole('button', { name: 'Continuar' }).click();
  await expect(dialog.getByRole('alert')).toContainText(
    'Preencha os campos do consentimento.',
  );
  const violations = (
    await new AxeBuilder({ page }).include('app-voice-profiles-panel').analyze()
  ).violations.filter(({ impact }) =>
    ['serious', 'critical'].includes(impact ?? ''),
  );
  expect(violations).toEqual([]);

  await dialog.getByLabel('Quem autorizou').fill('Pessoa de teste');
  await dialog.getByLabel('Data da autorização').fill('2026-10-01');
  await dialog.getByLabel('Colar o texto do aceite').check();
  await dialog
    .getByLabel('Texto do aceite', { exact: true })
    .fill('Autorizo o uso da voz.');
  await dialog.getByRole('checkbox', { name: /Confirmo/ }).check();
  await dialog.getByRole('button', { name: 'Continuar' }).click();

  await expect(dialog.getByText('De quais vozes calcular')).toBeVisible();
  await dialog.getByRole('checkbox', { name: /Voz 2/ }).check();
  await dialog.getByRole('button', { name: 'Calcular perfil' }).click();
  await expect(dialog.getByRole('status').first()).toContainText(
    'Consentimento registrado',
  );
  await expect(
    dialog.getByRole('listitem').filter({ hasText: voice.speakerName }),
  ).toContainText('Calculando');
});

test('AC-2, AC-3: a suggestion needs a person, and revoking takes what is pending', async ({
  browser,
  viewport,
}) => {
  const { owner, page } = await aMaster(browser, viewport);
  const { speakerName, profileId } = await storedProfile(page.request, owner);
  const accepted = await suggested(owner, profileId);
  const pending = await suggested(owner, profileId);

  await firstVisit(page);
  await page.goto(`/midia/${accepted}`);
  const voices = page.getByRole('region', { name: 'Vozes' });
  await expect(voices).toContainText(
    `Parece ser ${speakerName} (semelhança alta)`,
  );
  await voices
    .getByRole('button', { name: `Aceitar ${speakerName} para a Voz 2` })
    .click();
  await expect(voices).toContainText('Nome salvo.');
  await expect(voices.getByText(/Parece ser/)).toHaveCount(0);
  await expect(
    voices.getByRole('combobox', { name: 'Quem é a Voz 2?' }),
  ).toHaveValue(speakerName);

  const dialog = await openPanel(page);
  const row = dialog
    .getByRole('listitem')
    .filter({ hasText: speakerName })
    .first();
  await expect(row).toContainText('Pronto');
  await row
    .getByRole('button', {
      name: `Revogar o consentimento de ${speakerName}`,
    })
    .click();
  await expect(row.getByRole('button', { name: 'Cancelar' })).toBeFocused();
  await row.getByRole('button', { name: 'Revogar e apagar' }).click();
  await expect(dialog.getByRole('status').first()).toContainText(
    'Consentimento revogado',
  );

  await page.goto(`/midia/${pending}`);
  await expect(voices.getByRole('combobox').first()).toBeVisible();
  await expect(voices.getByText(/Parece ser/)).toHaveCount(0);
  await page.goto(`/midia/${accepted}`);
  await expect(
    voices.getByRole('combobox', { name: 'Quem é a Voz 2?' }),
  ).toHaveValue(speakerName);
});

test('AC-6: nothing the browser reads has a print', async ({
  browser,
  viewport,
}) => {
  const { owner, page } = await aMaster(browser, viewport);
  const { profileId } = await storedProfile(page.request, owner);
  const mediaId = await suggested(owner, profileId);
  for (const url of [PROFILES, `/api/v1/media/${mediaId}/speakers`]) {
    const body = await (await page.request.get(url)).text();
    expect(body).not.toContain('embedding');
    expect(body).not.toContain('similarity');
  }
});

test('AC-8: the owner reads each consent, the revocation and the counts', async ({
  page,
}) => {
  const owner = await ownerApi();
  const { speakerName, profileId } = await storedProfile(owner, owner);
  const mediaId = await suggested(owner, profileId);
  await post(owner, `/api/v1/media/${mediaId}/voices/${ANSWERS}/suggestion`, {
    version: 1,
    decision: 'accept',
  });
  const revoked = await owner.delete(`/api/v1/voice-profiles/${profileId}`, {
    headers: CSRF,
  });
  expect(revoked.status()).toBe(204);

  await page.goto('/');
  const dialog = await openPanel(page);
  await expect(dialog.getByText('Perfis e consentimentos')).toBeVisible();
  const entry = dialog
    .getByRole('listitem')
    .filter({ hasText: speakerName })
    .first();
  await expect(entry).toContainText(/Revogado em \d{2}\/\d{2}\/\d{4}/);
  await expect(entry).toContainText('1 feitas, 1 aceitas, 0 recusadas');
  await expect(
    entry.getByRole('link', { name: 'Baixar a prova do consentimento' }),
  ).toBeVisible();
});

test('a lost revocation list says so, with the step of the owner (axe)', async ({
  browser,
  viewport,
}) => {
  const { page } = await aMaster(browser, viewport);
  await page.route(`**${PROFILES}`, async (route) => {
    const answer = await route.fetch();
    const body = (await answer.json()) as object;
    await route.fulfill({
      response: answer,
      json: { ...body, revocationList: 'lost' },
    });
  });
  await firstVisit(page);
  const dialog = await openPanel(page);
  const alert = dialog.getByRole('alert');
  await expect(alert).toContainText('A lista de revogações se perdeu');
  await expect(alert).toContainText('Passo do dono');
  await expect(
    dialog.getByRole('button', { name: 'Cadastrar perfil' }),
  ).toHaveCount(0);
  const { violations } = await new AxeBuilder({ page })
    .include('app-voice-profiles-panel')
    .analyze();
  expect(
    violations.filter(({ impact }) =>
      ['serious', 'critical'].includes(impact ?? ''),
    ),
  ).toEqual([]);
});
