import { writeFileSync } from 'node:fs';
import type {
  APIRequestContext,
  Browser,
  BrowserContext,
  Locator,
  Page,
} from '@playwright/test';
import {
  CSRF,
  WEB_ORIGIN,
  expect,
  fakeGoogle,
  ownerApi,
  signIn,
  test,
} from '../specs/fixtures.js';
import { chooseCollectionSlug } from '../specs/shell-helpers.js';
import { separateVoices } from '../specs/voices-helpers.js';
import {
  HELENA_NAME,
  OWNER,
  TOPIC,
  figmaWorld,
  rawOf,
  recentCollections,
  seedWorld,
  type Line,
  type World,
} from './figma-library-world.js';

/**
 * The audio source of an AI answer (ia-audio-source, ia-audio-source-playing), at 1440×900 and
 * 390×844, on the v2 · Mídia frames' own world (figma-library-world.ts: Alquimia Prática, the
 * interview "Entrevista sobre a Tábua de Esmeralda" by Irmã Helena Prado): the capture recipe
 * of the Figma inventory check (figma-recreation/tools/inventory/check.sh ia). The research
 * stream is the frame's fixed answer, sent in place of the stub model's (`frameAnswer`): two
 * documents and the interview, cited at 0:22 and 0:45. It only reaches each state and saves
 * it: the behaviour is proven by e2e/specs/media-audio-source.spec.ts. Needs a fresh E2E
 * server. `KBC_FIDELITY_SHOTS=<dir>` saves `<state-id>[@mobile].png`.
 */

const shots = process.env['KBC_FIDELITY_SHOTS'];
const DESKTOP = { width: 1440, height: 900 } as const;
const PHONE = { width: 390, height: 844 } as const;
type Width = 'desktop' | 'phone';
const WIDTHS: readonly Width[] = ['desktop', 'phone'];
const INTERVIEW = 'Entrevista sobre a Tábua de Esmeralda';
const QUESTION =
  'O que a Tábua de Esmeralda ensina sobre estudar por correspondência?';
const MEDIA = '[data-media-engine]';

test.describe.configure({ timeout: 300_000 });

/** The frame's answer, as the research stream sends it. */
function frameAnswer(w: World): string {
  const sources = [
    {
      n: 1,
      id: 'raw/articles/a-lei-do-ritmo.md',
      title: 'A Lei do Ritmo',
      authorship: 'mestre-laercio',
      genre: 'article_or_essay',
    },
    {
      n: 2,
      id: 'raw/articles/a-pedra-filosofal.md',
      title: 'A Pedra Filosofal',
      authorship: 'outros-autores',
      genre: 'article_or_essay',
    },
    {
      n: 3,
      id: `media/${w.byCode['ES']}`,
      title: INTERVIEW,
      author: HELENA_NAME,
      media: {
        mediaId: w.byCode['ES'],
        kind: 'recording',
        recordingTitle: INTERVIEW,
        durationMs: 60_000,
        confidence: 'normal',
      },
      passages: [
        { at: '0:22', startMs: 22_000, endMs: 31_000 },
        { at: '0:45', startMs: 45_000, endMs: 52_000 },
      ],
    },
  ];
  const text =
    'Nos textos do acervo, a Tábua de Esmeralda é tratada como um método: entender um plano observando o outro.\n\n' +
    'Na entrevista, Irmã Helena Prado resume assim: “não é uma imagem poética, é um método” [3@0:22], [3@0:45]. ' +
    'Ela completa com o exemplo do ritmo, visto em várias escalas: o corpo, as estações e as ideias. [3@0:45] [1] [2]';
  const events = [
    { type: 'start', model: 'stub/model', billing: 'per-token' },
    {
      type: 'step',
      step: { kind: 'search', text: `Buscando “${QUESTION}”` },
    },
    { type: 'sources', sources },
    { type: 'token', text, segment: 0 },
    {
      type: 'done',
      usd: 0,
      billing: 'per-token',
      model: 'stub/model',
      interrupted: false,
      steps: 1,
    },
  ];
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

async function contextAt(
  browser: Browser,
  width: Width,
): Promise<{ context: BrowserContext; page: Page }> {
  const phone = width === 'phone';
  const context = await browser.newContext({
    baseURL: WEB_ORIGIN,
    viewport: phone ? PHONE : DESKTOP,
    deviceScaleFactor: 1,
    hasTouch: phone,
    isMobile: phone,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  });
  await figmaWorld(context, world);
  await recentCollections(context, world, OWNER);
  await context.addInitScript(() => {
    try {
      localStorage.setItem('kb-chat.view', 'research');
    } catch {
      // No storage: the app's own default view.
    }
  });
  await context.route(`**/api/v1/topics/${TOPIC}/research`, (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      body: frameAnswer(world),
    }),
  );
  const page = await context.newPage();
  await fakeGoogle(page);
  await signIn(page.request, OWNER);
  return { context, page };
}

async function shoot(page: Page, id: string, width: Width): Promise<void> {
  if (!shots) return;
  await page.addStyleTag({
    content:
      '*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}',
  });
  await page.waitForTimeout(300);
  await page.mouse.move(1, 1);
  await page.screenshot({
    path: `${shots}/${id}${width === 'phone' ? '@mobile' : ''}.png`,
  });
}

/** The panel beside the answer (desktop) or the reading sheet (phone). */
const source = (page: Page, phone: boolean): Locator =>
  phone
    ? page.getByRole('dialog', { name: 'Fonte' })
    : page.getByRole('dialog', { name: /^Trecho d/ });

/**
 * The interview as the frames quote it (the library world's transcript override, only on
 * this capture's own server; the library's states keep their lines): Irmã Helena Prado at
 * 0:16 and in the cited passage 0:22–0:31, the interviewer ("Voz 2") at 0:31, the second
 * passage at 0:45.
 */
const INTERVIEW_LINES: readonly Line[] = [
  [0, 7.5, 'A Tábua de Esmeralda cabe numa página só.'],
  [8, 15.5, 'E o que ela ensina sobre estudar?'],
  [
    16,
    21.5,
    'A frase mais conhecida diz que o que está em cima é como o que está embaixo.',
  ],
  [
    22,
    31,
    'Isso não é uma imagem poética. É um método: entender um plano observando o outro, a correspondência entre eles.',
  ],
  [31.5, 44.5, 'E na prática, no estudo do dia a dia, como isso aparece?'],
  [45, 52, 'No ritmo: o mesmo vaivém no corpo, nas estações e nas ideias.'],
  [52.5, 59, 'É assim que se estuda por correspondência.'],
];
/**
 * The phone frames quote the same two lines shorter ("…entender um plano observando o outro.",
 * "E na prática, como isso aparece?"): the phone's capture reseeds them, the same times.
 */
const PHONE_LINES: readonly Line[] = INTERVIEW_LINES.map(
  ([start, end, text]) => [
    start,
    end,
    start === 22
      ? 'Isso não é uma imagem poética. É um método: entender um plano observando o outro.'
      : start === 31.5
        ? 'E na prática, como isso aparece?'
        : text,
  ],
);

/** Who speaks: Irmã Helena Prado first (voice 1), the interviewer (voice 2) asks. */
const TURNS = [
  { start: 0, end: 7.8, voice: 'SPEAKER_01' },
  { start: 7.8, end: 15.8, voice: 'SPEAKER_02' },
  { start: 15.8, end: 31.2, voice: 'SPEAKER_01' },
  { start: 31.2, end: 44.8, voice: 'SPEAKER_02' },
  { start: 44.8, end: 59, voice: 'SPEAKER_01' },
];

let helenaSpeaker = '';
/** The interview's voices: Irmã Helena Prado named, the interviewer left as "Voz 2". */
async function interviewVoices(
  owner: APIRequestContext,
  byCode: Readonly<Record<string, string>>,
): Promise<void> {
  const mediaId = byCode['ES'] ?? '';
  await separateVoices(owner, mediaId, { turns: TURNS });
  if (!helenaSpeaker) {
    const made = await owner.post(`/api/v1/topics/${TOPIC}/speakers`, {
      headers: CSRF,
      data: { name: HELENA_NAME },
    });
    expect(made.status(), await made.text()).toBe(201);
    helenaSpeaker = ((await made.json()) as { id: string }).id;
  }
  const speakerId = helenaSpeaker;
  const read = await owner.get(`/api/v1/media/${mediaId}/transcript`);
  const { segments } = (await read.json()) as {
    segments: { startMs: number; voice?: number | null }[];
  };
  const voice = segments.find((one) => one.startMs >= 22_000)?.voice;
  expect(voice, 'the cited passage has a voice').toEqual(expect.any(Number));
  const put = await owner.put(`/api/v1/media/${mediaId}/voices/${voice}`, {
    headers: CSRF,
    data: { version: 1, speakerId, audience: false },
  });
  expect(put.status(), await put.text()).toBe(200);
}

/** The interview's transcript again with `lines`, its voices separated and named again. */
async function reseed(lines: readonly Line[]): Promise<void> {
  const owner = await ownerApi();
  const mediaId = world.byCode['ES'] ?? '';
  // "Transcrever de novo" queues the job the new lines answer.
  const again = await owner.post(`/api/v1/media/${mediaId}/transcription`, {
    data: {},
    headers: CSRF,
  });
  expect(again.status(), await again.text()).toBeLessThan(300);
  const seeded = await owner.post(`/api/e2e/media/${mediaId}/transcript`, {
    data: { raw: rawOf(lines, 60, false) },
    headers: CSRF,
  });
  expect(seeded.status(), await seeded.text()).toBe(204);
  // The new version's voices, separated and named as before (when they did not carry over).
  const read = await owner.get(`/api/v1/media/${mediaId}/transcript`);
  const { segments } = (await read.json()) as {
    segments: { startMs: number; voice?: number | null }[];
  };
  if (typeof segments.find((one) => one.startMs >= 22_000)?.voice !== 'number')
    await interviewVoices(owner, world.byCode);
  await owner.dispose();
}

let world: World;
test.beforeAll(async () => {
  test.setTimeout(300_000);
  world = await seedWorld({
    lines: { ES: INTERVIEW_LINES },
    beforeTracks: interviewVoices,
  });
});

test('the audio source of an answer: open, then its passage playing', async ({
  browser,
}) => {
  for (const width of WIDTHS) {
    const phone = width === 'phone';
    if (phone) await reseed(PHONE_LINES);
    const { context, page } = await contextAt(browser, width);
    await page.goto('/');
    const skip = page.getByRole('button', { name: 'Pular' });
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await chooseCollectionSlug(page, TOPIC);
    await page.getByLabel('Sua pergunta').fill(QUESTION);
    await page.getByRole('button', { name: 'Perguntar' }).click();
    const answer = page.locator('app-research-message').last();
    await expect(answer.getByText(/Resposta gerada por IA/)).toBeVisible({
      timeout: 30_000,
    });
    await answer
      .getByRole('link', { name: /aos 22 segundos/ })
      .first()
      .click();
    const panel = source(page, phone);
    await expect(panel).toBeVisible();
    await expect(
      panel.getByRole('button', { name: 'Ouvir o trecho' }),
    ).toBeVisible();
    await shoot(page, 'ia-audio-source', width);

    await panel.getByRole('button', { name: 'Ouvir o trecho' }).click();
    await expect
      .poll(() =>
        page.evaluate(
          (selector) =>
            document.querySelector<HTMLMediaElement>(selector)?.paused ===
            false,
          MEDIA,
        ),
      )
      .toBe(true);
    // The frame's player is at 0:27, five seconds into the passage.
    await page.evaluate((selector) => {
      const media = document.querySelector<HTMLMediaElement>(selector);
      if (media) media.currentTime = 27.05;
    }, MEDIA);
    await shoot(page, 'ia-audio-source-playing', width);
    await context.close();
  }
});

test.afterAll(() => {
  if (shots) writeFileSync(`${shots}/.done`, new Date().toISOString());
});
