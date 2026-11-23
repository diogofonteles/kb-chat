import type { Page } from '@playwright/test';
import { expect, invite, ownerApi, test, uniqueEmail } from './fixtures.js';
import {
  activeCollection,
  chooseCollectionSlug,
  desktop,
  library,
  signOut,
} from './shell-helpers.js';

/**
 * KBC-157: the collection in use survives a reload, for each person in this browser. It is
 * highlighted in the Acervos column (1440) and in the phone's Menu (390), and the reload
 * still lands on a new conversation (KBC-164).
 */

const BOTH = ['hermetismo', 'alquimia'];
const SEARCH_GREETING = 'O que você quer estudar hoje?';
const RESEARCH_GREETING = 'O que você quer pesquisar no acervo?';

const shots = process.env['KBC_SHOTS'];
async function shoot(page: Page, name: string): Promise<void> {
  if (shots)
    await page.screenshot({
      path: `${shots}/${name}-${page.viewportSize()?.width}.png`,
    });
}

/** Signs in through the login screen as `email` (the fake Google button). */
async function signInAs(page: Page, email: string): Promise<void> {
  const button = page.getByRole('button', { name: 'Fazer login com o Google' });
  await expect(button).toBeVisible();
  await page.evaluate((who) => {
    (window as Window & { __kbE2eEmail?: string }).__kbE2eEmail = who;
  }, email);
  await button.click();
  await expect(button).toBeHidden();
}

/** The slug highlighted in Acervos (the phone's Menu is closed again after reading it). */
async function inUse(page: Page): Promise<string | null> {
  const side = await library(page);
  const active = activeCollection(side);
  await expect(active).toHaveCount(1);
  const slug = await active.getAttribute('data-slug');
  if (!desktop(page)) {
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Menu' })).toBeHidden();
  }
  return slug;
}

/** The new-conversation home: a greeting and nothing asked. */
async function expectNewConversation(page: Page): Promise<void> {
  await expect(
    page.getByText(SEARCH_GREETING).or(page.getByText(RESEARCH_GREETING)),
  ).toBeVisible();
  await expect(page.locator('app-research-message')).toHaveCount(0);
  await expect(page.locator('app-result-message')).toHaveCount(0);
}

test.use({ signedInAs: null });

let first: string;
let second: string;

test.beforeAll(async () => {
  const owner = await ownerApi();
  first = uniqueEmail('in-use-a');
  second = uniqueEmail('in-use-b');
  await invite(owner, first, { topics: BOTH });
  await invite(owner, second, { topics: BOTH });
  await owner.dispose();
});

test('AC-1/AC-4/AC-7: the chosen collection survives a reload, and the next person gets their own', async ({
  page,
}) => {
  await page.goto('/');
  await signInAs(page, first);
  const fallback = await inUse(page);
  expect(BOTH).toContain(fallback);
  const chosen = BOTH.find((slug) => slug !== fallback) ?? '';

  // The phone's Menu closes by itself on a choice.
  await chooseCollectionSlug(page, chosen);
  expect(await inUse(page)).toBe(chosen);

  await page.reload();
  await expectNewConversation(page);
  expect(await inUse(page)).toBe(chosen);
  if (!desktop(page)) await library(page);
  await shoot(page, 'kbc157-reloaded');
  if (!desktop(page)) await page.keyboard.press('Escape');

  // Another person in the same browser: their own default, not the first one's choice.
  await signOut(page);
  await signInAs(page, second);
  await expectNewConversation(page);
  expect(await inUse(page)).toBe(fallback);

  // The first one back: their choice is still theirs.
  await signOut(page);
  await signInAs(page, first);
  expect(await inUse(page)).toBe(chosen);
});
