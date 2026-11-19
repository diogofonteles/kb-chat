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
import {
  openSection,
  openSettings,
  SETTINGS_AXE,
  showTab,
} from './settings-helpers.js';

/**
 * QA of KBC-022 on "Pessoas e permissões" and the section's visibility (AC-2, AC-12, NFR-3).
 * Only "Aplicar às selecionadas" runs here: "Aplicar a todos os usuários" changes every person
 * of the shared E2E server and would break the specs running beside this one.
 */

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
}

test('AC-2: a member sees no "IA da aplicação" section', async ({
  browser,
  page,
}) => {
  const email = uniqueEmail('member');
  const owner = await ownerApi();
  await invite(owner, email, {
    topics: ['hermetismo'],
    features: ['search', 'research', 'own-ai-settings'],
  });
  const member = await pageAs(browser, email, page.viewportSize());
  await member.goto('/');
  await member.getByRole('button', { name: 'Pular' }).click();
  await expect(member.getByRole('dialog')).toHaveCount(0);
  const dialog = await openSettings(member);
  await expect(
    dialog.getByRole('link', { name: 'Preferências', exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('link', { name: 'IA da aplicação', exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole('link', { name: 'Pessoas e permissões', exact: true }),
  ).toHaveCount(0);
  await member.context().close();
  await owner.dispose();
});

test('AC-12: the master lends the house plan to two of three selected people, with an audit trail', async ({
  page,
}) => {
  const owner = await ownerApi();
  const [first, second, third] = [
    uniqueEmail('bulk-a'),
    uniqueEmail('bulk-b'),
    uniqueEmail('bulk-c'),
  ];
  const firstId = await invite(owner, first);
  const secondId = await invite(owner, second);
  const thirdId = await invite(owner, third);

  await page.goto('/');
  const dialog = await openSettings(page);
  await openSection(dialog, 'Pessoas e permissões');
  // A phone's list shows its boxes once a selection is on: a long press (its context menu)
  // on a row starts it.
  if ((page.viewportSize()?.width ?? 0) < 1024)
    await dialog
      .getByRole('button', { name: new RegExp(first.replace(/[.]/g, '\\.')) })
      .dispatchEvent('contextmenu');
  await dialog.getByLabel(`Selecionar ${first}`).check();
  await dialog.getByLabel(`Selecionar ${second}`).check();
  const bar = dialog.getByRole('group', {
    name: 'IA da aplicação para várias pessoas',
  });
  await bar
    .getByRole('combobox')
    .selectOption({ label: 'Plano da casa (OpenRouter)' });
  await page.waitForFunction(() => document.getAnimations().length === 0);
  const axe = await new AxeBuilder({ page }).include(SETTINGS_AXE).analyze();
  expect(axe.violations).toEqual([]);
  await noHorizontalScroll(page);

  await bar
    .getByRole('button', { name: 'Aplicar às selecionadas (2)' })
    .click();
  await expect(
    dialog
      .getByRole('status')
      .filter({ hasText: 'IA da aplicação atualizada para 2 pessoa(s).' }),
  ).toBeVisible();

  const { items: list } = (await (
    await owner.get('/api/v1/people')
  ).json()) as {
    items: { id: string; ai: { appAi: string; history: { by: string }[] } }[];
  };
  const ai = (id: string) => list.find((person) => person.id === id)?.ai;
  expect(ai(firstId)?.appAi).toBe('house');
  expect(ai(secondId)?.appAi).toBe('house');
  expect(ai(thirdId)?.appAi).toBe('default');
  expect(ai(firstId)?.history.at(-1)?.by).toBe('owner@kb-chat.test');
  expect(ai(thirdId)?.history).toEqual([]);

  // The person's editor shows the AI fieldset and its history (T9).
  await dialog.getByRole('button', { name: new RegExp(first) }).click();
  // The person's editor is a modal, the AI in its own tab (KBC-132).
  await showTab(dialog, 'IA e limites');
  const fieldset = dialog.getByRole('group', { name: 'IA da aplicação' });
  await expect(fieldset.getByLabel('Qual IA atende esta pessoa')).toHaveValue(
    'house',
  );
  await fieldset.getByLabel('Liberar o modelo pago de reserva').check();
  await expect(fieldset.getByLabel('Teto por mês (US$)')).toBeVisible();
  await dialog.getByText('Histórico da IA').click();
  await page.waitForFunction(() => document.getAnimations().length === 0);
  const editorAxe = await new AxeBuilder({ page })
    .include(SETTINGS_AXE)
    .analyze();
  expect(editorAxe.violations).toEqual([]);
  await noHorizontalScroll(page);
  await owner.patch(`/api/v1/people/${firstId}`, {
    data: { ai: { paidFallback: { enabled: false, monthlyCapUsd: 1 } } },
    headers: CSRF,
  });
  await owner.dispose();
});
