import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { CSRF, OUT_DIR, Shooter, fakeGoogle, signIn } from './capture-kit.js';

/**
 * The tutorial's screenshots (KBC-032), against the E2E server: the fixture vault, fake AI
 * providers and fictitious people (`@exemplo.test`). Run with `pnpm tutorial:screenshots`;
 * the files land in apps/web/public/assets/tutorial with the manifest beside the page.
 */
const OWNER = { email: 'owner@kb-chat.test', name: 'Administrador' };
const ANA = { email: 'ana.souza@exemplo.test', name: 'Ana Souza' };
const BRUNO = { email: 'bruno.lima@exemplo.test', name: 'Bruno Lima' };
const CARLA = 'carla.mendes@exemplo.test';
const DANIEL = 'daniel.rocha@exemplo.test';

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

test.describe.configure({ mode: 'serial' });

let shooter: Shooter;
let owner: APIRequestContext;

async function desktopPage(
  browser: Browser,
  person: { email: string; name: string } | null,
  height = DESKTOP.height,
): Promise<Page> {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport: { width: DESKTOP.width, height },
    deviceScaleFactor: 1.5,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  });
  return pageIn(context, person);
}

async function phonePage(
  browser: Browser,
  person: { email: string; name: string } | null,
): Promise<Page> {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport: PHONE,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  });
  return pageIn(context, person);
}

async function pageIn(
  context: BrowserContext,
  person: { email: string; name: string } | null,
): Promise<Page> {
  const page = await context.newPage();
  await fakeGoogle(page);
  if (person) await signIn(page.request, person.email, person.name);
  return page;
}

async function expectOk(pending: Promise<APIResponse>): Promise<void> {
  const response = await pending;
  if (!response.ok())
    throw new Error(
      `${response.url()}: ${response.status()} ${await response.text()}`,
    );
}

/** Creates or reuses a person (a reused server already has them). */
async function invitePerson(
  email: string,
  sendEmail: boolean,
): Promise<string> {
  const created = await owner.post('/api/v1/people', {
    data: { email, sendEmail },
    headers: CSRF,
  });
  if (created.status() === 201)
    return ((await created.json()) as { id: string }).id;
  const list = (await (await owner.get('/api/v1/people')).json()) as {
    items: { id: string; email: string }[];
  };
  const found = list.items.find((person) => person.email === email);
  if (!found) throw new Error(`could not invite ${email}`);
  return found.id;
}

/** Bruno, with no invitation, asks for access with his Google account. */
async function pendingRequest(api: APIRequestContext): Promise<void> {
  const token = await api.post('/api/e2e/token', {
    data: BRUNO,
    headers: CSRF,
  });
  const { credential } = (await token.json()) as { credential: string };
  const refused = await api.post('/api/v1/auth/google', {
    data: { credential },
    headers: CSRF,
  });
  if (refused.status() !== 403) return;
  const { ticket } = (
    (await refused.json()) as { error: { details: { ticket: string } } }
  ).error.details;
  await api.post('/api/v1/access-requests/google', {
    data: { ticket },
    headers: CSRF,
  });
}

async function seed(browser: Browser): Promise<void> {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
  });
  owner = context.request;
  await signIn(owner, OWNER.email, OWNER.name);
  await expectOk(
    owner.put('/api/v1/house-ai', {
      data: { key: 'sk-or-v1-house-valid' },
      headers: CSRF,
    }),
  );
  const ana = await invitePerson(ANA.email, false);
  await expectOk(
    owner.patch(`/api/v1/people/${ana}`, {
      data: {
        topics: ['hermetismo', 'alquimia'],
        features: ['search', 'research', 'own-ai-settings'],
        ai: { appAi: 'house' },
      },
      headers: CSRF,
    }),
  );
  await invitePerson(CARLA, true);
  const profiles = (await (
    await owner.get('/api/v1/invite-profiles')
  ).json()) as { items: unknown[] };
  if (profiles.items.length === 0)
    await expectOk(
      owner.post('/api/v1/invite-profiles', {
        data: {
          name: 'Aluno',
          isDefault: true,
          preset: {
            topics: ['hermetismo'],
            features: ['search', 'research'],
            ai: { appAi: 'house', dailyResearches: 5 },
            preferences: {
              defaultTopic: 'hermetismo',
              defaultView: 'research',
            },
          },
        },
        headers: CSRF,
      }),
    );
  await pendingRequest(
    (await browser.newContext({ baseURL: test.info().project.use.baseURL }))
      .request,
  );
}

/** Ana's first visit asks for her setup: skipped, as most people do. */
async function openAsAna(page: Page): Promise<void> {
  await page.goto('/');
  const skip = page.getByRole('button', { name: 'Pular' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await expect(page.getByLabel('Sua pergunta')).toBeVisible();
}

async function chooseView(
  page: Page,
  view: 'Buscar documentos' | 'Pesquisa com IA',
): Promise<void> {
  await page.getByRole('radio', { name: view }).check({ force: true });
}

async function ask(page: Page, question: string): Promise<void> {
  await page.getByLabel('Sua pergunta').fill(question);
  await page.getByLabel('Sua pergunta').press('Enter');
}

async function openSettings(page: Page, section?: string) {
  await page.getByRole('button', { name: 'Configurações' }).click();
  const dialog = page.getByRole('dialog', { name: 'Configurações' });
  await expect(dialog).toBeVisible();
  if (section) await dialog.getByRole('button', { name: section }).click();
  return dialog;
}

/** Test hooks of the E2E stub model (stub-llm-adapter.ts), added on the way out only. */
const SLOW = '[lento]';
const SLOW_SWEEP = '[varredura lenta]';

/**
 * Runs `act` with `marker` appended to the research question the page sends: the stub slows
 * down or fails, while the screen keeps the question as typed.
 */
async function withStubMarker(
  page: Page,
  marker: string,
  act: () => Promise<void>,
): Promise<void> {
  const pattern = '**/api/v1/topics/*/research';
  await page.route(pattern, async (route) => {
    const body = route.request().postDataJSON() as { question: string };
    await route.continue({
      postData: JSON.stringify({
        ...body,
        question: `${body.question} ${marker}`,
      }),
    });
  });
  await act();
  await page.unroute(pattern);
}

/** A one-turn research conversation, saved as the app saves a finished one. */
async function seedResearch(
  api: APIRequestContext,
  question: string,
  turn: Record<string, unknown>,
): Promise<void> {
  const id = randomUUID();
  const at = new Date().toISOString();
  await expectOk(
    api.put(`/api/v1/conversations/${id}`, {
      headers: CSRF,
      data: {
        kind: 'research',
        id,
        topic: 'hermetismo',
        title: question,
        createdAt: at,
        updatedAt: at,
        turns: [
          {
            question,
            answer: '',
            sources: [],
            steps: 0,
            usd: 0,
            billing: 'per-token',
            model: 'stub/model',
            interrupted: false,
            profile: 'fast',
            at,
            id: randomUUID(),
            ...turn,
          },
        ],
      },
    }),
  );
}

/**
 * A sweep a limit stopped (KBC-030), saved as the app saves it: the stub sweeps the fixture
 * vault too fast to stop one for real.
 */
async function seedUnfinishedSweep(page: Page): Promise<string> {
  const id = randomUUID();
  const title = 'Quais obras o Mestre cita como referência?';
  const at = new Date().toISOString();
  const totals = { documents: 22, scanned: 10, withHits: null, read: 10 };
  await expectOk(
    page.request.put(`/api/v1/conversations/${id}`, {
      headers: CSRF,
      data: {
        kind: 'research',
        id,
        topic: 'hermetismo',
        title,
        createdAt: at,
        updatedAt: at,
        turns: [
          {
            question: title,
            answer:
              'Lista parcial: “A Lei do Ritmo” e “Ritmo, lição 01” citam obras de referência.',
            sources: [],
            steps: 3,
            usd: 0,
            billing: 'per-token',
            model: 'stub/model',
            interrupted: false,
            profile: 'exhaustive',
            coverage: {
              target: {},
              phrases: [],
              ...totals,
              needed: 22,
              missing: 12,
              batches: 1,
              reason: 'requests',
            },
            sweep: {
              plan: { target: {}, phrases: [], extract: 'obras citadas' },
              after: 'raw/articles/ritmo-serie-06.md',
              totals: { ...totals, batches: 1 },
            },
            at,
          },
        ],
      },
    }),
  );
  return title;
}

test.beforeAll(async ({ browser }) => {
  mkdirSync(OUT_DIR, { recursive: true });
  shooter = await Shooter.create(browser);
  await seed(browser);
});

// A partial run keeps the previous manifest: the page never points at a missing image.
let failed = false;
test.afterEach(() => {
  const info = test.info();
  if (info.status !== info.expectedStatus) failed = true;
});

test.afterAll(() => {
  if (!failed) shooter.finish();
});

test('sign in', async ({ browser }) => {
  const page = await phonePage(browser, null);
  await page.goto('/');
  const google = page.getByRole('button', { name: 'Fazer login com o Google' });
  await expect(google).toBeVisible();
  await shooter.shoot(page, 'login', {
    marks: [
      { n: 1, target: google },
      { n: 2, target: page.getByRole('button', { name: 'Entrar com código' }) },
      {
        n: 3,
        target: page.getByRole('button', {
          name: 'Pedir acesso sem conta Google',
        }),
      },
    ],
  });

  await page.getByRole('button', { name: 'Entrar com código' }).click();
  await page.getByLabel('Seu e-mail').fill(ANA.email);
  await page.getByRole('button', { name: 'Enviar código' }).click();
  const code = page.getByLabel('Código');
  await expect(code).toBeVisible();
  await code.fill('482915');
  await shooter.shoot(page, 'sign-in-code', {
    marks: [
      { n: 1, target: code },
      { n: 2, target: page.getByRole('button', { name: 'Entrar' }) },
    ],
  });

  await page.goto('/');
  await page
    .getByRole('button', { name: 'Pedir acesso sem conta Google' })
    .click();
  await page.getByLabel('E-mail').fill('bruno.lima@exemplo.test');
  await page.getByLabel('Nome', { exact: true }).fill('Bruno');
  await page.getByLabel('Sobrenome').fill('Lima');
  await page.getByLabel('Celular').fill('(81) 99999-0000');
  await shooter.shoot(page, 'request-access', {
    marks: [
      { n: 1, target: page.getByRole('button', { name: 'Enviar código' }) },
    ],
  });
  await page.context().close();
});

test('search without AI', async ({ browser }) => {
  const page = await desktopPage(browser, ANA);
  await openAsAna(page);
  await shooter.shoot(page, 'home', {
    marks: [
      { n: 1, target: page.getByRole('group', { name: 'Modo da conversa' }) },
      { n: 2, target: page.locator('app-composer') },
      {
        n: 3,
        target: page.getByRole('complementary', { name: 'Lateral' }),
      },
    ],
  });

  await chooseView(page, 'Buscar documentos');
  await ask(page, 'lei do ritmo');
  const card = page.locator('app-result-card').first();
  await expect(card).toBeVisible();
  await shooter.shoot(page, 'search-results', {
    clip: page.locator('main.conversation'),
    marks: [
      { n: 1, target: page.getByLabel('Como buscar') },
      { n: 2, target: page.getByRole('radiogroup', { name: /Autoria/ }) },
      { n: 3, target: page.getByRole('group', { name: 'Filtros' }).first() },
      { n: 4, target: card },
    ],
  });

  await card.getByRole('button').first().click();
  const panel = page.locator('app-document-panel');
  await expect(panel.getByRole('heading', { level: 2 })).toBeVisible();
  const highlight = panel.locator('mark').first();
  await expect(highlight).toBeVisible();
  await shooter.shoot(page, 'document-panel', {
    clip: panel,
    marks: [
      { n: 1, target: highlight },
      {
        n: 2,
        target: panel.getByRole('button', { name: 'Próxima ocorrência' }),
      },
    ],
  });
  await page.context().close();
});

test('filters on a phone', async ({ browser }) => {
  const page = await phonePage(browser, ANA);
  await openAsAna(page);
  await chooseView(page, 'Buscar documentos');
  await ask(page, 'lei do ritmo');
  await expect(page.locator('app-result-card').first()).toBeVisible();
  await page
    .getByRole('button', { name: /^Filtros/ })
    .last()
    .click();
  const sheet = page.getByRole('dialog', { name: 'Filtros' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('checkbox').first().check();
  await shooter.shoot(page, 'filters-phone', {
    marks: [{ n: 1, target: sheet.getByRole('button', { name: 'Aplicar' }) }],
  });
  await page.context().close();
});

test('research with AI', async ({ browser }) => {
  const ana = await desktopPage(browser, ANA);
  await openAsAna(ana);
  await chooseView(ana, 'Pesquisa com IA');
  await ana
    .getByLabel('Sua pergunta')
    .fill('Quais textos do Mestre falam da lei do ritmo?');
  await ana.getByRole('radio', { name: 'Exaustivo' }).check({ force: true });
  await shooter.shoot(ana, 'research-profiles', {
    clip: ana.locator('.composer-dock'),
    marks: [
      { n: 1, target: ana.getByRole('group', { name: 'Tipo de pesquisa' }) },
      { n: 2, target: ana.getByRole('button', { name: 'Perguntar' }) },
    ],
  });
  await ana.context().close();

  const page = await desktopPage(browser, OWNER);
  await page.goto('/');
  await chooseView(page, 'Pesquisa com IA');
  await ask(page, 'O que é a lei do ritmo?');
  const answer = page.locator('app-research-message').last();
  await expect(answer.getByText(/Respondido por/)).toBeVisible();
  await shooter.shoot(page, 'research-answer', {
    clip: page.locator('section.thread'),
    marks: [
      { n: 1, target: answer.locator('details.steps summary') },
      { n: 2, target: answer.locator('.answer') },
      { n: 3, target: answer.locator('.sources') },
      { n: 4, target: answer.locator('.footer') },
    ],
  });

  await page.getByRole('button', { name: 'Nova conversa' }).click();
  await page.getByRole('radio', { name: 'Exaustivo' }).check({ force: true });
  await withStubMarker(page, SLOW_SWEEP, () =>
    ask(page, 'Liste todos os textos que falam da lei do ritmo.'),
  );
  const exhaustive = page.locator('app-research-message').last();
  const sweep = exhaustive.getByRole('region', {
    name: 'Varredura do conjunto inteiro',
  });
  await expect(sweep.getByRole('status')).toContainText(/Lote \d+ de/);
  await shooter.shoot(page, 'research-sweep', {
    settle: false,
    clip: page.locator('section.thread'),
    marks: [
      { n: 1, target: sweep },
      { n: 2, target: sweep.getByRole('status') },
    ],
  });
  await expect(exhaustive.getByText(/Respondido por/)).toBeVisible({
    timeout: 90_000,
  });
  await shooter.shoot(page, 'research-exhaustive', {
    clip: page.locator('section.thread'),
    marks: [
      {
        n: 1,
        target: exhaustive.getByText(/Cobertura \(medida pelo aplicativo\)/),
      },
    ],
  });

  const unfinished = await seedUnfinishedSweep(page);
  await page.reload();
  await page
    .getByRole('navigation', { name: 'Histórico' })
    .getByRole('button', { name: unfinished })
    .click();
  const cut = page.locator('app-research-message').first();
  const resume = cut.getByRole('button', { name: 'Continuar varredura' });
  await expect(resume).toBeVisible();
  await shooter.shoot(page, 'research-continue', {
    clip: page.locator('section.thread'),
    marks: [
      { n: 1, target: cut.getByText(/Faltaram \d+ documentos/) },
      { n: 2, target: resume },
    ],
  });
  await page.context().close();

  const phone = await phonePage(browser, OWNER);
  await phone.goto('/');
  await chooseView(phone, 'Pesquisa com IA');
  await ask(phone, 'O que é a lei do ritmo?');
  await expect(
    phone
      .locator('app-research-message')
      .last()
      .getByText(/Respondido por/),
  ).toBeVisible();
  await shooter.shoot(phone, 'research-phone');
  await phone.context().close();
});

test('history', async ({ browser }) => {
  // Taller, so the whole history list shows without scrolling.
  const page = await desktopPage(browser, OWNER, 1000);
  // A failed and a stopped research, saved as the app saves them (KBC-029).
  await seedResearch(page.request, 'O que é a natureza sétupla?', {
    interrupted: true,
  });
  const failed = 'Quais livros o Mestre recomenda?';
  await seedResearch(page.request, failed, {
    status: 'failed',
    error: 'INTERNAL',
  });
  await page.goto('/');
  const side = page.getByRole('complementary', { name: 'Lateral' });
  const list = side.getByRole('navigation', { name: 'Histórico' });
  await list.getByRole('button', { name: new RegExp(failed) }).click();
  const retry = page.getByRole('button', { name: 'Tentar de novo' });
  await expect(retry).toBeVisible();
  await shooter.shoot(page, 'history-retry', {
    clip: page.locator('section.thread'),
    marks: [
      { n: 1, target: page.getByRole('alert') },
      { n: 2, target: retry },
    ],
  });

  await page.getByRole('button', { name: 'Nova conversa' }).click();
  await chooseView(page, 'Pesquisa com IA');
  await withStubMarker(page, SLOW, () =>
    ask(page, 'Como o ritmo aparece na música?'),
  );
  const running = list.getByRole('button', { name: /pesquisando…/ });
  await expect(running).toBeVisible();
  await expect(list.getByText('interrompida', { exact: true })).toBeVisible();
  await expect(list.getByText('falhou', { exact: true })).toBeVisible();
  await shooter.shoot(page, 'history', {
    clip: side,
    // The spinner of the running research never stops animating.
    settle: false,
    marks: [
      { n: 1, target: running },
      { n: 2, target: list.getByRole('button', { name: /falhou/ }) },
      { n: 3, target: list.getByRole('button', { name: /interrompida/ }) },
    ],
  });
  await page.getByRole('button', { name: 'Parar' }).click();
  await page.context().close();
});

test('own AI and preferences', async ({ browser }) => {
  const page = await desktopPage(browser, ANA, 900);
  await openAsAna(page);
  const dialog = await openSettings(page);
  const status = dialog.getByText('Quem atende você agora');
  await expect(status).toBeVisible();
  await shooter.shoot(page, 'own-ai', {
    clip: dialog,
    marks: [
      { n: 1, target: dialog.locator('app-ai-status-card') },
      { n: 2, target: dialog.locator('label.card').first() },
    ],
  });

  await dialog.getByRole('radio', { name: /OpenRouter/ }).check();
  const connect = dialog.getByRole('button', { name: 'Conectar OpenRouter' });
  const freeOnly = dialog.getByText('Só modelos gratuitos (recomendado)');
  await freeOnly.evaluate((text) => text.scrollIntoView({ block: 'end' }));
  await shooter.shoot(page, 'own-ai-openrouter', {
    clip: dialog,
    marks: [
      { n: 1, target: connect },
      { n: 2, target: freeOnly },
    ],
  });

  await dialog.getByRole('button', { name: 'Preferências' }).click();
  await expect(dialog.getByText('Ao abrir a Nova Alexandria')).toBeVisible();
  await shooter.shoot(page, 'preferences', { clip: dialog });
  await page.context().close();
});

test('administrators', async ({ browser }) => {
  const page = await desktopPage(browser, OWNER, 1000);
  await page.goto('/');
  let dialog = await openSettings(page, 'IA da aplicação');
  await expect(dialog.getByText(/Pedidos gratuitos hoje/)).toBeVisible();
  await shooter.shoot(page, 'house-ai', {
    clip: dialog,
    marks: [
      {
        n: 1,
        target: dialog
          .getByText(/Conectada/)
          .first()
          .locator('..'),
      },
      {
        n: 2,
        target: dialog.getByText('Escolher automaticamente (recomendado)'),
      },
    ],
  });
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: /Pessoas e permissões/ }).click();
  dialog = page.getByRole('dialog', { name: 'Configurações' });
  const request = dialog.getByRole('listitem').filter({ hasText: BRUNO.email });
  await expect(request).toBeVisible();
  await shooter.shoot(page, 'access-requests', {
    clip: dialog,
    marks: [
      { n: 1, target: request.getByRole('button', { name: 'Aprovar' }) },
      { n: 2, target: request.getByRole('button', { name: 'Recusar' }) },
    ],
  });

  const anaRow = dialog.getByRole('button', { name: new RegExp(ANA.email) });
  await anaRow.click();
  const topics = dialog.getByRole('group', { name: 'Acervos' });
  await anaRow.evaluate((row) => row.scrollIntoView({ block: 'start' }));
  await shooter.shoot(page, 'people', {
    clip: dialog,
    marks: [
      { n: 1, target: topics },
      { n: 2, target: dialog.getByRole('group', { name: 'Funcionalidades' }) },
      {
        n: 3,
        target: dialog.getByLabel('Qual IA atende esta pessoa'),
      },
    ],
  });

  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: /Pessoas e permissões/ }).click();
  dialog = page.getByRole('dialog', { name: 'Configurações' });
  const email = dialog.getByLabel('Convidar por e-mail');
  await email.fill(DANIEL);
  const configure = dialog.getByRole('button', { name: 'Configurar agora' });
  await shooter.shoot(page, 'invite-preset', {
    clip: dialog,
    marks: [
      { n: 1, target: email },
      { n: 2, target: dialog.locator('select[name="profile"]') },
      { n: 3, target: configure },
    ],
  });

  // The owner lends a subscription right in the invitation (KBC-031), terms first.
  await configure.click();
  await dialog
    .getByLabel('Qual IA atende a pessoa')
    .selectOption({ label: 'Claude do administrador' });
  const confirm = dialog.getByRole('button', { name: 'Ceder assim mesmo' });
  await confirm.evaluate((button) =>
    button.scrollIntoView({ block: 'center' }),
  );
  await shooter.shoot(page, 'lend-subscription', {
    clip: dialog,
    marks: [
      { n: 1, target: dialog.getByText(/Os termos da Anthropic/) },
      { n: 2, target: confirm },
    ],
  });
  await page.context().close();
});
