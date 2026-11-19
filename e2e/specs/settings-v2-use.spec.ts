import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import {
  desktop,
  openSection,
  settingsPage,
  settingsSection,
} from './settings-helpers.js';

/**
 * KBC-131/KBC-132, v2 fidelity: Configurações is used for real at 1440 and 390, not only
 * looked at. Its text scrolls with the wheel, a touch and the keyboard; every control the
 * frames show answers (the corner search, the phone's "‹", the people's modals and tabs,
 * the profiles, the bulk AI, Groq's cards, the voice consent) and every menu, modal and
 * sheet opens and closes. Nothing here changes what other specs rely on: no write is kept.
 */

/** The element that scrolls Configurações (the page's host in the main panel). */
const scroller = (page: Page): Locator => page.locator('app-settings-page');

const scrollTop = (page: Page): Promise<number> =>
  scroller(page).evaluate((element) => element.scrollTop);

/** A finger dragged up over `point` (Chromium's compositor gesture, as a real touch). */
async function swipeUp(
  page: Page,
  point: { x: number; y: number },
  distance: number,
): Promise<void> {
  // WebKit has no CDP touch gesture: the wheel over the same point moves the same scroller.
  if (page.context().browser()?.browserType().name() !== 'chromium') {
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, distance);
    return;
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.synthesizeScrollGesture', {
    x: point.x,
    y: point.y,
    yDistance: -distance,
    gestureSourceType: 'touch',
  });
  await cdp.detach();
}

/** Scrolls the page down over its content as the person would at this width. */
async function scrollDown(page: Page, distance = 600): Promise<void> {
  const box = await scroller(page).boundingBox();
  if (!box) throw new Error('Configurações is not on screen');
  const point = {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2),
  };
  if (desktop(page)) {
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, distance);
  } else {
    await swipeUp(page, point, distance);
  }
}

/** Opens Configurações at `slug` (the root without one) and waits for its sections. */
async function open(page: Page, slug = ''): Promise<Locator> {
  await page.goto(slug ? `/configuracoes/${slug}` : '/configuracoes');
  const settings = settingsPage(page);
  await expect(settings).toBeVisible();
  await expect(settings.getByText('Carregando…')).toHaveCount(0);
  return settings;
}

test.describe('the page scrolls', () => {
  test('desktop: the wheel and the keyboard move the page and the index follows', async ({
    page,
  }) => {
    test.skip(!desktop(page), 'desktop only: the phone pushes one section');
    const settings = await open(page);
    const index = settings.getByRole('navigation', { name: 'Seções' });
    await expect(
      index.getByRole('link', { name: 'Conta', exact: true }),
    ).toHaveAttribute('aria-current', 'location');

    await scrollDown(page, 900);
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(400);
    await expect(
      index.getByRole('link', { name: 'Conta', exact: true }),
    ).not.toHaveAttribute('aria-current', 'location');

    // The keyboard: from the top, Page Down moves it; End reaches "Sobre".
    await scroller(page).evaluate((element) => (element.scrollTop = 0));
    await settings
      .getByRole('heading', { name: 'Configurações', level: 1 })
      .click();
    const before = await scrollTop(page);
    await page.keyboard.press('PageDown');
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(before + 200);
    await page.keyboard.press('End');
    await expect(
      index.getByRole('link', { name: 'Sobre', exact: true }),
    ).toHaveAttribute('aria-current', 'location');
    await expect(
      settingsSection(page, 'Sobre').getByRole('button', {
        name: 'Rever o assistente de início',
      }),
    ).toBeInViewport();
  });

  for (const [slug, label] of [
    ['sua-ia', 'Sua IA'],
    ['preferencias', 'Preferências'],
    ['pessoas', 'Pessoas e permissões'],
    ['ia-da-aplicacao', 'IA da aplicação'],
    ['termos', 'Termos da transcrição'],
    ['groq', 'Groq de reserva'],
  ] as const) {
    test(`${label}: its text moves with a touch on a phone, with the wheel on desktop`, async ({
      page,
    }) => {
      await open(page, slug);
      await expect(settingsSection(page, label)).toBeVisible();
      const before = await scrollTop(page);
      // A short section (few people on a fresh server) moves to its end, not 100 px. Its
      // data comes after the page: wait for the room it makes before measuring it.
      const roomNow = () =>
        scroller(page).evaluate(
          (element) => element.scrollHeight - element.clientHeight,
        );
      await expect.poll(roomNow).toBeGreaterThan(40);
      const room = await roomNow();
      await scrollDown(page, 500);
      await expect
        .poll(() => scrollTop(page))
        .toBeGreaterThanOrEqual(Math.min(before + 100, room - 1));
    });
  }
});

test.describe('the keyboard with nothing focused', () => {
  for (const slug of ['pessoas', 'ia-da-aplicacao', 'termos'] as const) {
    test(`${slug}: End reaches the end and Home the top, with the focus on nothing`, async ({
      page,
    }) => {
      await open(page, slug);
      // Opening a section leaves the focus on the body: the keys still move the page.
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.tagName))
        .toBe('BODY');
      // The section's data comes after the page: wait for the room it makes.
      const roomNow = () =>
        scroller(page).evaluate(
          (element) => element.scrollHeight - element.clientHeight,
        );
      await expect.poll(roomNow).toBeGreaterThan(40);
      const room = await roomNow();
      await page.keyboard.press('End');
      await expect.poll(() => scrollTop(page)).toBeGreaterThanOrEqual(room - 1);
      await page.keyboard.press('Home');
      await expect.poll(() => scrollTop(page)).toBe(0);
      await page.keyboard.press('PageDown');
      await expect.poll(() => scrollTop(page)).toBeGreaterThan(100);
    });
  }
});

test.describe('the corner search and the phone screens', () => {
  test('the search icon opens the field; it narrows the index and Escape folds it', async ({
    page,
  }) => {
    const settings = await open(page);
    await settings
      .getByRole('button', { name: 'Buscar nas configurações' })
      .first()
      .click();
    const field = settings.getByRole('searchbox', {
      name: 'Buscar nas configurações',
    });
    await expect(field).toBeFocused();
    await field.fill('groq');
    const index = settings.getByRole('navigation', { name: 'Seções' });
    await expect(
      index.getByRole('link', { name: 'Groq de reserva', exact: true }),
    ).toBeVisible();
    await expect(
      index.getByRole('link', { name: 'Sua IA', exact: true }),
    ).toHaveCount(0);
    await field.press('Escape');
    await expect(field).toHaveCount(0);
    await expect(
      index.getByRole('link', { name: 'Sua IA', exact: true }),
    ).toBeVisible();
  });

  test('phone: a pushed screen with its own "‹", no tab bar, and "‹" at the root leaves', async ({
    page,
  }) => {
    test.skip(desktop(page), 'phone only');
    const settings = await open(page);
    await expect(
      page.getByRole('navigation', { name: /Navegação/ }),
    ).toHaveCount(0);
    await openSection(page, 'Preferências');
    await expect(
      settings.getByRole('heading', { name: 'Preferências', level: 2 }),
    ).toBeVisible();
    await settings
      .getByRole('button', { name: 'Voltar às configurações' })
      .click();
    await expect(page).toHaveURL(/\/configuracoes$/);
    await settings
      .getByRole('button', { name: 'Sair das configurações' })
      .click();
    await expect(page).not.toHaveURL(/\/configuracoes/);
  });
});

test.describe('Pessoas e permissões', () => {
  test('the profiles row folds and unfolds, and "Novo perfil" opens its modal and closes', async ({
    page,
  }) => {
    await open(page, 'pessoas');
    const section = settingsSection(page, 'Pessoas e permissões');
    const profiles = section.getByRole('region', { name: /Perfis de convite/ });
    const toggle = profiles.getByRole('button', { name: /Perfis de convite/ });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await profiles.getByRole('button', { name: 'Novo perfil' }).click();
    const modal = page.getByRole('dialog', { name: 'Novo perfil' });
    await expect(modal).toBeVisible();
    await expect(modal.getByLabel('Nome do perfil')).toBeVisible();
    await modal.getByRole('tab', { name: 'IA e limites' }).click();
    await expect(
      modal.getByRole('tab', { name: 'IA e limites' }),
    ).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  test("a person's row opens the editor with its tabs; ✕ closes it", async ({
    page,
  }) => {
    await open(page, 'pessoas');
    const section = settingsSection(page, 'Pessoas e permissões');
    await section.getByRole('button', { name: /owner@kb-chat\.test/ }).click();
    const editor = page.getByRole('dialog').filter({ hasText: 'Pessoa' });
    await expect(editor).toBeVisible();
    await expect(editor.getByText('owner@kb-chat.test')).toBeVisible();
    await editor.getByRole('tab', { name: 'IA e limites' }).click();
    await expect(editor.getByLabel('Qual IA atende esta pessoa')).toBeVisible();
    await editor.getByRole('tab', { name: 'Acessos' }).click();
    await expect(
      editor.getByRole('group', { name: 'Funcionalidades' }),
    ).toBeVisible();
    await editor.getByRole('button', { name: 'Fechar' }).first().click();
    await expect(editor).toBeHidden();
  });

  test('the invitation: Convidar asks for the e-mail; "Configurar agora" opens the modal and ✕ discards it', async ({
    page,
  }) => {
    await open(page, 'pessoas');
    const section = settingsSection(page, 'Pessoas e permissões');
    const invite = section.locator('form.invite');
    // Lit as in the frames: with no address, pressing it says what is missing.
    const send = invite.getByRole('button', { name: 'Convidar' });
    await expect(send).toBeEnabled();
    await send.click();
    await expect(invite.getByRole('alert')).toContainText(
      'Escreva o e-mail de quem você quer convidar.',
    );
    await expect(invite.getByLabel('Convidar por e-mail')).toBeFocused();
    await invite
      .getByLabel('Convidar por e-mail')
      .fill('alguem.novo@exemplo.test');
    await expect(send).toBeEnabled();
    await invite.getByRole('button', { name: 'Configurar agora' }).click();
    const modal = page.getByRole('dialog', { name: 'Configurar o convite' });
    await expect(modal).toBeVisible();
    await expect(modal.getByLabel('Convidar por e-mail')).toHaveValue(
      'alguem.novo@exemplo.test',
    );
    await modal.getByRole('tab', { name: 'Preferências iniciais' }).click();
    await expect(modal.getByLabel('Acervo padrão')).toBeVisible();
    // ✕ on a desktop; the phone sheet's header "Cancelar" discards it.
    await modal
      .getByRole('button', { name: desktop(page) ? 'Fechar' : 'Cancelar' })
      .first()
      .click();
    await expect(modal).toBeHidden();
    await expect(
      invite.getByRole('button', { name: 'Configurar agora' }),
    ).toBeVisible();
  });

  test('the bulk AI asks before "Aplicar a todos os usuários" and Cancelar keeps everyone', async ({
    page,
  }) => {
    await open(page, 'pessoas');
    const bar = settingsSection(page, 'Pessoas e permissões').getByRole(
      'group',
      { name: 'IA da aplicação para várias pessoas' },
    );
    await expect(
      bar.getByRole('button', { name: /Aplicar às selecionadas/ }),
    ).toBeDisabled();
    await bar
      .getByRole('button', { name: 'Aplicar a todos os usuários' })
      .click();
    await expect(bar.getByRole('alert')).toContainText('Aplicar');
    await bar.getByRole('button', { name: 'Cancelar' }).click();
    await expect(bar.getByRole('alert')).toHaveCount(0);
  });
});

test.describe('Auditoria do Ver como', () => {
  test('a phone shows the records without the table head; a desktop keeps it', async ({
    page,
  }) => {
    await open(page, 'auditoria');
    const head = settingsSection(page, 'Auditoria do Ver como').locator(
      '.table-head',
    );
    if ((await head.count()) === 0) return; // no record yet on this server
    if (desktop(page)) await expect(head).toBeVisible();
    else await expect(head).toBeHidden();
  });
});

test.describe('the media sections', () => {
  test('Groq: the cards are radios; choosing one marks it, without saving', async ({
    page,
  }) => {
    await open(page, 'groq');
    const section = settingsSection(page, 'Groq de reserva');
    const ask = section.getByRole('radio', { name: /Só quando eu pedir/ });
    await ask.check();
    await expect(ask).toBeChecked();
    await expect(
      section.getByRole('radio', { name: /Nunca/ }),
    ).not.toBeChecked();
  });

  test('Perfis de voz: "Cadastrar perfil" opens the consent, its text scrolls, Cancelar closes', async ({
    page,
  }) => {
    await open(page, 'perfis-de-voz');
    const section = settingsSection(page, 'Perfis de voz');
    await section.getByRole('button', { name: 'Cadastrar perfil' }).click();
    const modal = page.getByRole('dialog', { name: 'Novo perfil de voz' });
    await expect(modal).toBeVisible();
    const consent = modal.locator('.consent-box');
    await expect(consent).toBeVisible();
    const top = () => consent.evaluate((element) => element.scrollTop);
    const box = await consent.boundingBox();
    if (!box) throw new Error('the consent text is not on screen');
    const point = {
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + box.height / 2),
    };
    if (desktop(page)) {
      await page.mouse.move(point.x, point.y);
      await page.mouse.wheel(0, 200);
    } else {
      await swipeUp(page, point, 150);
    }
    await expect.poll(top).toBeGreaterThan(20);
    if (!desktop(page)) {
      // The phone sheet's header holds Continuar: lit, it says what the consent misses.
      const header = modal.locator('.ui-dialog__primary');
      await expect(header).toHaveText('Continuar');
      await expect(header).toBeEnabled();
      await header.click();
      await expect(modal.getByRole('alert').first()).toBeVisible();
    }
    await modal.getByRole('radio', { name: 'Colar o texto do aceite' }).check();
    await expect(
      modal.getByLabel('Texto do aceite', { exact: true }),
    ).toBeVisible();
    await modal.getByRole('button', { name: 'Cancelar' }).first().click();
    await expect(modal).toBeHidden();
  });
});

test.describe('the v2 controls in use', () => {
  test('Pessoas: the owner on gold with one letter, the selects with their own chevron', async ({
    page,
  }) => {
    await open(page, 'pessoas');
    const section = settingsSection(page, 'Pessoas e permissões');
    const ownerRow = section.getByRole('button', {
      name: /owner@kb-chat\.test/,
    });
    const avatar = ownerRow.locator('app-person-avatar');
    await expect(avatar).toHaveAttribute('data-tone', 'owner');
    await expect(avatar).toHaveText(/^[A-Z]$/);
    // The bulk AI's select: no native caret, the frame's chevron drawn in the field.
    const select = section
      .locator('app-ai-assignment-bar select.select')
      .first();
    await expect(select).toBeVisible();
    const look = await select.evaluate((element) => {
      const style = getComputedStyle(element);
      return { appearance: style.appearance, image: style.backgroundImage };
    });
    expect(look.appearance).toBe('none');
    expect(look.image).toContain('linear-gradient');
    // It still chooses, by keyboard as by pointer.
    const values = await select.evaluate((element) =>
      Array.from(
        (element as HTMLSelectElement).options,
        (option) => option.value,
      ),
    );
    const current = await select.inputValue();
    const other = values.find((value) => value !== current);
    if (other !== undefined) {
      await select.selectOption(other);
      await expect(select).toHaveValue(other);
    }
  });

  test("a master's editor: the info banner, and the locked boxes keep their tick's colour", async ({
    page,
  }) => {
    await open(page, 'pessoas');
    const section = settingsSection(page, 'Pessoas e permissões');
    await section.getByRole('button', { name: /owner@kb-chat\.test/ }).click();
    const editor = page.getByRole('dialog').filter({ hasText: 'Pessoa' });
    await expect(editor).toBeVisible();
    await expect(
      editor.getByText(
        'Masters veem todos os acervos e usam todas as funcionalidades.',
      ),
    ).toBeVisible();
    const locked = editor
      .getByRole('group', { name: 'Acervos' })
      .getByRole('checkbox')
      .first();
    await expect(locked).toBeDisabled();
    await expect(locked).toBeChecked();
    // The row dims as one (50 %); the box itself is not dimmed again into grey.
    expect(await locked.evaluate((box) => getComputedStyle(box).opacity)).toBe(
      '1',
    );
    expect(
      await locked.evaluate(
        (box) => getComputedStyle(box.closest('.check') as Element).opacity,
      ),
    ).toBe('0.5');
    if (!desktop(page)) {
      // The phone sheet: the e-mail on its own line, the pills under it.
      const email = editor.locator('.phone-person .dialog-sub > span').first();
      const pill = editor.locator('.phone-person .dialog-sub ui-pill').first();
      const [emailBox, pillBox] = await Promise.all([
        email.boundingBox(),
        pill.boundingBox(),
      ]);
      if (!emailBox || !pillBox) throw new Error('the person is not on screen');
      expect(pillBox.y).toBeGreaterThan(emailBox.y + emailBox.height - 1);
    }
    await editor.getByRole('button', { name: 'Fechar' }).first().click();
    await expect(editor).toBeHidden();
  });

  test('IA da aplicação: the paid model is typed and Salvar sits beside it, under it on a phone', async ({
    page,
  }) => {
    await open(page, 'ia-da-aplicacao');
    const field = page.locator('#house-paid-model');
    await field.scrollIntoViewIfNeeded();
    await field.click();
    await field.pressSequentially('fake/paid');
    await expect(field).toHaveValue('fake/paid');
    await field.fill('');
    // The paid model's own Salvar, in the same row as its field.
    const save = page
      .locator('.row', { has: field })
      .getByRole('button', { name: 'Salvar', exact: true });
    const [fieldBox, saveBox] = await Promise.all([
      field.boundingBox(),
      save.boundingBox(),
    ]);
    if (!fieldBox || !saveBox)
      throw new Error('the paid model is not on screen');
    if (desktop(page))
      expect(Math.abs(saveBox.y - fieldBox.y)).toBeLessThan(fieldBox.height);
    else
      expect(saveBox.y).toBeGreaterThanOrEqual(
        fieldBox.y + fieldBox.height - 1,
      );
  });
});
