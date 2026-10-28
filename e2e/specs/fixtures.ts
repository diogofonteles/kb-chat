import {
  test as base,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type Browser,
  type Page,
} from '@playwright/test';

/** The E2E server's owner (apps/api/src/e2e/server.ts): a master with the seeded data. */
export const OWNER_EMAIL = 'owner@kb-chat.test';
export const WEB_ORIGIN = `http://localhost:${process.env['KBC_E2E_WEB_PORT'] ?? '4317'}`;
/** The CSRF header every state-changing call carries (ADR 0008). */
export const CSRF = { 'x-requested-with': 'kb-chat' };

/**
 * A stand-in for Google Identity Services: its button asks the E2E server for a test ID
 * token (for `window.__kbE2eEmail`, else the owner) and hands it to the app's callback,
 * as Google would. No request ever reaches Google.
 */
const FAKE_GIS = `
window.google = { accounts: { id: {
  initialize(options) { this.options = options; },
  renderButton(parent) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Fazer login com o Google';
    button.onclick = async () => {
      const email = window.__kbE2eEmail || '${OWNER_EMAIL}';
      const response = await fetch('/api/e2e/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'kb-chat' },
        body: JSON.stringify({ email }),
      });
      const { credential } = await response.json();
      window.google.accounts.id.options.callback({ credential });
    };
    parent.replaceChildren(button);
  },
  disableAutoSelect() {},
} } };
`;

export async function fakeGoogle(page: Page): Promise<void> {
  await page.route('https://accounts.google.com/**', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: FAKE_GIS }),
  );
  // Web fonts come from Google too: a request that never ends holds the page's load event
  // (a 60 s timeout seen in the media specs). The specs use the fallback fonts.
  await page.route('https://fonts.googleapis.com/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '' }),
  );
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort());
}

/** Signs `api` (a page's or a standalone request context) in as `email`. */
export async function signIn(
  api: APIRequestContext,
  email: string = OWNER_EMAIL,
): Promise<void> {
  const token = await api.post('/api/e2e/token', {
    data: { email },
    headers: CSRF,
  });
  const { credential } = (await token.json()) as { credential: string };
  const response = await api.post('/api/v1/auth/google', {
    data: { credential },
    headers: CSRF,
  });
  expect(response.status(), await response.text()).toBe(200);
}

/** The owner's API, outside any page (to invite and grant). */
export async function ownerApi(): Promise<APIRequestContext> {
  const api = await playwrightRequest.newContext({ baseURL: WEB_ORIGIN });
  await signIn(api);
  return api;
}

export interface Grant {
  readonly topics?: readonly string[];
  readonly features?: readonly string[];
  readonly role?: 'master' | 'member';
}

/** Invites `email` with `grant`; returns the person's id. */
export async function invite(
  owner: APIRequestContext,
  email: string,
  grant: Grant = {},
): Promise<string> {
  const invited = await owner.post('/api/v1/people', {
    data: { email },
    headers: CSRF,
  });
  expect(invited.status(), await invited.text()).toBe(201);
  const { id } = (await invited.json()) as { id: string };
  if (Object.keys(grant).length > 0) {
    const patched = await owner.patch(`/api/v1/people/${id}`, {
      data: grant,
      headers: CSRF,
    });
    expect(patched.status()).toBe(200);
  }
  return id;
}

/** A fresh browser context signed in as `email`, at the test's viewport. */
export async function pageAs(
  browser: Browser,
  email: string,
  viewport: { width: number; height: number } | null,
): Promise<Page> {
  const context = await browser.newContext({
    baseURL: WEB_ORIGIN,
    viewport: viewport ?? undefined,
  });
  const page = await context.newPage();
  await fakeGoogle(page);
  await signIn(page.request, email);
  return page;
}

/**
 * The six-digit code of the newest message to `to` (KBC-014), read from the E2E server's
 * outbox once more than `seen` messages arrived (delivery runs after the reply).
 */
export async function codeSentTo(
  api: APIRequestContext,
  to: string,
  seen = 0,
): Promise<string> {
  const read = async () => {
    const response = await api.get(
      `/api/e2e/outbox?to=${encodeURIComponent(to)}`,
    );
    return ((await response.json()) as { items: { text: string }[] }).items;
  };
  await expect.poll(async () => (await read()).length).toBeGreaterThan(seen);
  const text = (await read()).at(-1)?.text ?? '';
  const code = /\b(\d{6})\b/.exec(text)?.[1];
  if (!code) throw new Error(`no code in the message to ${to}`);
  return code;
}

/** How many messages went to `to` so far. */
export async function sentCount(
  api: APIRequestContext,
  to: string,
): Promise<number> {
  const response = await api.get(
    `/api/e2e/outbox?to=${encodeURIComponent(to)}`,
  );
  return ((await response.json()) as { items: unknown[] }).items.length;
}

/** A unique test e-mail, so parallel runs never share a person. */
export const uniqueEmail = (label: string): string =>
  `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@kb-chat.test`;

/**
 * Every spec runs signed in as the owner unless it says `test.use({ signedInAs: null })`
 * (or another e-mail). Google is always faked.
 */
export const test = base.extend<{ signedInAs: string | null }>({
  signedInAs: [OWNER_EMAIL, { option: true }],
  page: async ({ page, signedInAs }, use) => {
    await fakeGoogle(page);
    if (signedInAs) await signIn(page.request, signedInAs);
    await use(page);
  },
});

export { expect };
