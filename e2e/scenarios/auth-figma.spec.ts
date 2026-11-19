import { writeFileSync } from 'node:fs';
import type { Browser, BrowserContext, Page, Response } from '@playwright/test';
import {
  CSRF,
  WEB_ORIGIN,
  codeSentTo,
  expect,
  fakeGoogle,
  ownerApi,
  test,
} from '../specs/fixtures.js';

/**
 * The states of the v2 · Auth frames (auth-*) and the public pages (public-*), at 1440×900
 * and 390×844, on the frames' own sample data: "Bruno Lima" (bruno.lima@exemplo.test), a
 * Google account nobody invited, who asks for access, waits and is refused; "Ana Lima"
 * (ana.lima@exemplo.test), who asks for access without Google and signs in with a code. The
 * capture recipe of the Figma inventory check (figma-recreation/tools/inventory/check.sh
 * auth). It only reaches each state and saves it: the behaviour is proven by
 * e2e/specs/access, auth and v2-foundation.
 *
 * Every step is real on the E2E server except two answers replayed on the phone: a request
 * can be sent once per person, so the phone's "Solicitação enviada." (auth-not-invited-sent,
 * auth-signup-done) gets the answer the desktop got. Needs a fresh E2E server.
 * `KBC_FIDELITY_SHOTS=<dir>` saves `<state-id>[@mobile].png`.
 */

const shots = process.env['KBC_FIDELITY_SHOTS'];
const DESKTOP = { width: 1440, height: 900 } as const;
const PHONE = { width: 390, height: 844 } as const;
type Width = 'desktop' | 'phone';
const WIDTHS: readonly Width[] = ['desktop', 'phone'];
const BRUNO = { email: 'bruno.lima@exemplo.test', name: 'Bruno Lima' } as const;
const ANA = 'ana.lima@exemplo.test';
const PHONE_NUMBER = '(81) 99999-0000';

test.describe.configure({ timeout: 300_000 });

/** fixtures' Google stand-in, with the account's name too (the not-invited account row). */
const NAMED_GIS = `
window.google = { accounts: { id: {
  initialize(options) { this.options = options; },
  renderButton(parent) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Fazer login com o Google';
    button.onclick = async () => {
      const response = await fetch('/api/e2e/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'kb-chat' },
        body: JSON.stringify({ email: '${BRUNO.email}', name: '${BRUNO.name}' }),
      });
      const { credential } = await response.json();
      window.google.accounts.id.options.callback({ credential });
    };
    parent.replaceChildren(button);
  },
  disableAutoSelect() {},
} } };
`;

/** A signed-out page at `width`. */
async function signedOut(
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
  const page = await context.newPage();
  await fakeGoogle(page);
  // After fakeGoogle: the later route wins.
  await context.route('https://accounts.google.com/**', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: NAMED_GIS }),
  );
  return { context, page };
}

async function shoot(page: Page, id: string, width: Width): Promise<void> {
  if (!shots) return;
  await page.addStyleTag({
    content:
      '*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}',
  });
  for (let i = 0; i < 2; i += 1) {
    await page.evaluate(() =>
      document.querySelectorAll('*').forEach((node) => {
        if (node.scrollTop > 0) node.scrollTop = 0;
      }),
    );
    await page.waitForTimeout(300);
  }
  await page.mouse.move(1, 1);
  await page.screenshot({
    path: `${shots}/${id}${width === 'phone' ? '@mobile' : ''}.png`,
  });
}

const googleButton = (page: Page) =>
  page.getByRole('button', { name: 'Fazer login com o Google' });

async function loginPage(page: Page): Promise<void> {
  await page.goto('/');
  await expect(googleButton(page)).toBeVisible();
}

interface Saved {
  readonly path: string;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

/** The desktop's answer to a POST ending in `path`, kept to replay on the phone. */
function answerTo(page: Page, path: string): Promise<Saved> {
  const response = page.waitForResponse(
    (one) => one.request().method() === 'POST' && one.url().endsWith(path),
  );
  return response.then(async (one: Response) => ({
    path,
    status: one.status(),
    headers: one.headers(),
    body: await one.body(),
  }));
}

/**
 * Replays on the phone the answer the desktop got: a request is sent once per person, and a
 * code once a minute per address (KBC-014 BR-5).
 */
async function replay(page: Page, saved: Saved): Promise<void> {
  await page.route(`**${saved.path}`, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: saved.status,
          headers: saved.headers,
          body: saved.body,
        })
      : route.continue(),
  );
}

/**
 * The frame's "a partir de 10/11 às 18:59": the server counts the wait from the refusal's own
 * time, so the sign-in's refused answer carries the frame's instant instead (only that field).
 */
const REFUSED_RETRY_AT = '2026-11-10T21:59:00.000Z';
async function refusedUntil(page: Page, retryAt: string): Promise<void> {
  await page.route('**/api/v1/auth/google', async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    route.fulfill({
      response,
      body: body.replace(
        /"retryAt":"[^"]+"/,
        `"retryAt":${JSON.stringify(retryAt)}`,
      ),
    });
  });
}

test('the login: booting, loading, Google unavailable, not configured, signing in, failed', async ({
  browser,
}) => {
  for (const width of WIDTHS) {
    let { context, page } = await signedOut(browser, width);
    await page.route('**/api/v1/me', () => undefined);
    await page.goto('/');
    await expect(page.getByText('Carregando…').first()).toBeVisible();
    await shoot(page, 'auth-boot', width);
    await context.close();

    ({ context, page } = await signedOut(browser, width));
    await loginPage(page);
    await shoot(page, 'auth-login', width);

    await page.route('**/api/v1/auth/google', () => undefined);
    await googleButton(page).click();
    await expect(page.getByText('Entrando…').first()).toBeVisible();
    await shoot(page, 'auth-login-signing-in', width);
    await page.unroute('**/api/v1/auth/google');

    await page.route('**/api/v1/auth/google', (route) =>
      route.fulfill({
        status: 500,
        json: { error: { code: 'INTERNAL', message: 'down' } },
      }),
    );
    await loginPage(page);
    await googleButton(page).click();
    await expect(
      page.getByText('Algo deu errado do nosso lado.'),
    ).toBeVisible();
    await shoot(page, 'auth-login-failed', width);
    await context.close();

    // Google's script never arrives: "Carregando…"; it fails: "Não consegui carregar…".
    ({ context, page } = await signedOut(browser, width));
    await context.route('https://accounts.google.com/**', () => undefined);
    await page.goto('/');
    await expect(page.getByText('Carregando…').first()).toBeVisible();
    await expect(page.getByText('Entrar com código')).toBeVisible();
    await shoot(page, 'auth-login-loading', width);
    await context.close();

    ({ context, page } = await signedOut(browser, width));
    await context.route('https://accounts.google.com/**', (route) =>
      route.abort(),
    );
    await page.goto('/');
    await expect(
      page.getByText('Não consegui carregar o botão do Google.'),
    ).toBeVisible();
    await shoot(page, 'auth-login-unavailable', width);
    await context.close();

    ({ context, page } = await signedOut(browser, width));
    await page.route('**/api/v1/auth/config', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({
        response,
        json: { ...body, googleClientId: null },
      });
    });
    await page.goto('/');
    await expect(page.getByText('O login não está configurado')).toBeVisible();
    await shoot(page, 'auth-login-not-configured', width);
    await context.close();
  }
});

test('Bruno Lima, not invited: asks for access, waits, is refused', async ({
  browser,
}) => {
  const pages: Partial<Record<Width, Page>> = {};
  for (const width of WIDTHS) {
    const { page } = await signedOut(browser, width);
    pages[width] = page;
    await loginPage(page);
    await googleButton(page).click();
    await expect(
      page.getByText('Seu acesso ainda não foi liberado.'),
    ).toBeVisible();
    await shoot(page, 'auth-not-invited', width);
    await page.getByRole('button', { name: 'Solicitar acesso' }).click();
    await expect(page.getByLabel('Celular (opcional)')).toBeVisible();
    await shoot(page, 'auth-not-invited-form', width);
  }
  let sent: Saved | undefined;
  for (const width of WIDTHS) {
    const page = pages[width];
    if (!page) continue;
    if (sent) await replay(page, sent);
    const answer = answerTo(page, '/access-requests/google');
    await page.getByRole('button', { name: 'Enviar solicitação' }).click();
    sent ??= await answer;
    await expect(page.getByText('Solicitação enviada.')).toBeVisible();
    await shoot(page, 'auth-not-invited-sent', width);
    await page.context().close();
  }

  const again = async (width: Width, retryAt?: string) => {
    const { context, page } = await signedOut(browser, width);
    if (retryAt) await refusedUntil(page, retryAt);
    await loginPage(page);
    await googleButton(page).click();
    return { context, page };
  };
  for (const width of WIDTHS) {
    const { context, page } = await again(width);
    await expect(
      page.getByText('Sua solicitação está em análise.'),
    ).toBeVisible();
    await shoot(page, 'auth-not-invited-pending', width);
    await context.close();
  }

  const owner = await ownerApi();
  const list = await owner.get('/api/v1/access-requests');
  const items = (
    (await list.json()) as { items: { id: string; email: string }[] }
  ).items;
  const id = items.find((one) => one.email === BRUNO.email)?.id;
  expect(id, 'Bruno Lima asked for access').toBeDefined();
  const refused = await owner.post(`/api/v1/access-requests/${id}/refuse`, {
    headers: CSRF,
  });
  expect(refused.status(), await refused.text()).toBeLessThan(300);
  await owner.dispose();
  for (const width of WIDTHS) {
    const { context, page } = await again(width, REFUSED_RETRY_AT);
    await expect(
      page.getByText('Sua solicitação foi recusada.', { exact: true }),
    ).toBeVisible();
    await shoot(page, 'auth-not-invited-refused', width);
    await context.close();
  }
});

test('Ana Lima without Google: the request with its errors and its code, then the code sign-in', async ({
  browser,
}) => {
  const pages: Partial<Record<Width, Page>> = {};
  let codeSent: Saved | undefined;
  for (const width of WIDTHS) {
    const { page } = await signedOut(browser, width);
    pages[width] = page;
    if (codeSent) await replay(page, codeSent);
    await loginPage(page);
    await page
      .getByRole('button', { name: 'Pedir acesso sem conta Google' })
      .click();
    await expect(page.getByLabel('Sobrenome')).toBeVisible();
    await shoot(page, 'auth-signup-form', width);
    await page.getByLabel('E-mail').fill('ana.lima@');
    await page.getByRole('button', { name: 'Enviar código' }).click();
    await expect(page.getByText('Digite seu nome.')).toBeVisible();
    await shoot(page, 'auth-signup-errors', width);

    await page.getByLabel('E-mail').fill(ANA);
    await page.getByLabel('Nome', { exact: true }).fill('Ana');
    await page.getByLabel('Sobrenome').fill('Lima');
    await page.getByLabel('Celular').fill(PHONE_NUMBER);
    const answer = answerTo(page, '/access-requests/signup');
    await page.getByRole('button', { name: 'Enviar código' }).click();
    codeSent ??= await answer;
    await expect(
      page.getByText('Se o e-mail puder ser usado, enviamos um código'),
    ).toBeVisible();
    await page.getByLabel('Dígito 1 de 6').fill('481');
    await shoot(page, 'auth-signup-code', width);
  }
  let done: Saved | undefined;
  const first = pages.desktop;
  if (!first) throw new Error('no desktop page');
  const code = await codeSentTo(first.request, ANA);
  for (const width of WIDTHS) {
    const page = pages[width];
    if (!page) continue;
    if (done) await replay(page, done);
    await page.getByLabel('Dígito 1 de 6').fill(code);
    const answer = answerTo(page, '/access-requests/signup/verify');
    await page.getByRole('button', { name: 'Confirmar' }).click();
    done ??= await answer;
    await expect(page.getByText(/Solicitação enviada/)).toBeVisible();
    await shoot(page, 'auth-signup-done', width);
    await page.context().close();
  }

  let loginSent: Saved | undefined;
  for (const width of WIDTHS) {
    const { context, page } = await signedOut(browser, width);
    if (loginSent) await replay(page, loginSent);
    await loginPage(page);
    await page.getByRole('button', { name: 'Entrar com código' }).click();
    const email = page.getByLabel('Seu e-mail');
    await expect(email).toBeVisible();
    await shoot(page, 'auth-code-email', width);
    await email.fill('ana.lima@');
    await page.getByRole('button', { name: 'Enviar código' }).click();
    await expect(
      page.getByText('Digite um e-mail válido, como nome@exemplo.com.'),
    ).toBeVisible();
    await shoot(page, 'auth-code-email-error', width);
    await email.fill(ANA);
    const answer = answerTo(page, '/api/v1/auth/code');
    await page.getByRole('button', { name: 'Enviar código' }).click();
    loginSent ??= await answer;
    await expect(
      page.getByText(/enviamos um código de 6 dígitos/),
    ).toBeVisible();
    await page.getByLabel('Dígito 1 de 6').fill('481');
    await shoot(page, 'auth-code-code', width);
    await context.close();
  }
});

test('the public pages: privacy and the tutorial', async ({ browser }) => {
  for (const width of WIDTHS) {
    for (const [path, id, title] of [
      ['/privacidade', 'public-privacy', 'Política de privacidade'],
      ['/tutorial', 'public-tutorial', 'Como usar a Nova Alexandria'],
    ] as const) {
      const { context, page } = await signedOut(browser, width);
      await page.goto(path);
      await expect(page.getByRole('heading', { name: title })).toBeVisible();
      await shoot(page, id, width);
      await context.close();
    }
  }
});

test.afterAll(() => {
  if (shots) writeFileSync(`${shots}/.done`, new Date().toISOString());
});
