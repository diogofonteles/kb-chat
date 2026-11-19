import { writeFileSync } from 'node:fs';
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import {
  CSRF,
  WEB_ORIGIN,
  expect,
  fakeGoogle,
  test,
} from '../specs/fixtures.js';
import {
  ANA_SOUZA,
  EDUARDO,
  MAC,
  OWNER,
  seedSettingsWorld,
  signInNamed,
  settingsWorld,
  type SettingsOptions,
} from './figma-settings-world.js';

/**
 * The states of the v2 · Configurações frames (settings-*), at 1440×900 and 390×844, on the
 * frames' own sample data (figma-settings-world.ts): the capture recipe of the Figma inventory
 * check (figma-recreation/tools/inventory/check.sh settings). It only reaches each state and
 * saves it: the behaviour is proven by e2e/specs/settings, access, act-as, house-ai*,
 * invite-presets, media-groq, media-terms, media-voice-profiles and media-transcriber-status.
 *
 * Every step is real on the E2E server, except the response patches of the world and these
 * stand-ins: IA da aplicação "não conectada" and Groq "conectado, só quando eu pedir" are the
 * API's answers with the connection taken off / put on in the browser (the server keeps the
 * house plan connected for the other frames, and a Groq key would change them); the first-run
 * wizard sees the person's settings as not yet saved. A transcriber paired on screen is revoked
 * again after its shot. Needs a fresh E2E server. `KBC_FIDELITY_SHOTS=<dir>` saves
 * `<state-id>[@mobile].png`.
 */

const shots = process.env['KBC_FIDELITY_SHOTS'];
const DESKTOP = { width: 1440, height: 900 } as const;
const PHONE = { width: 390, height: 844 } as const;
type Width = 'desktop' | 'phone';
const WIDTHS: readonly Width[] = ['desktop', 'phone'];
const NEW_MAC = 'Mac da biblioteca';

test.describe.configure({ timeout: 300_000 });

/** Who signs in (the owner when not given) and the world's stand-ins for that page. */
interface Who extends SettingsOptions {
  readonly email?: string;
}

async function contextAt(
  browser: Browser,
  width: Width,
  { email = OWNER, ...options }: Who = {},
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
  await settingsWorld(context, options);
  const page = await context.newPage();
  await fakeGoogle(page);
  await signInNamed(page.request, email);
  return { context, page };
}

/** The shot as the page is: the scroll each state set is kept. */
async function shoot(page: Page, id: string, width: Width): Promise<void> {
  await shootAs(page, `${id}${width === 'phone' ? '@mobile' : ''}`);
}

/** The shot saved as `<file>.png` (a frame named outside the id[@mobile] rule). */
async function shootAs(page: Page, file: string): Promise<void> {
  if (!shots) return;
  await page.addStyleTag({
    content:
      '*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}',
  });
  await page.mouse.move(1, 1);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}/${file}.png` });
}

const settingsOf = (page: Page) =>
  page.getByRole('region', { name: 'Configurações' });

/** The sections' titles by address (apps/web settings-index.ts). */
const TITLES: Record<string, string> = {
  conta: 'Conta',
  'sua-ia': 'Sua IA',
  preferencias: 'Preferências',
  acessos: 'Acessos à sua conta',
  pessoas: 'Pessoas e permissões',
  'ia-da-aplicacao': 'IA da aplicação',
  auditoria: 'Auditoria do Ver como',
  transcritores: 'Transcritores',
  termos: 'Termos da transcrição',
  groq: 'Groq de reserva',
  'perfis-de-voz': 'Perfis de voz',
  sobre: 'Sobre',
};

/**
 * /configuracoes/<slug>: on desktop the page scrolled to that section, on a phone its screen.
 * The section comes back (desktop draws them all on one page).
 */
async function section(page: Page, slug: string): Promise<Locator> {
  await page.goto(`/configuracoes/${slug}`);
  const settings = settingsOf(page);
  await expect(settings).toBeVisible();
  await expect(settings.getByText('Carregando…')).toHaveCount(0);
  const own = settings.getByRole('region', {
    name: TITLES[slug] ?? slug,
    exact: true,
  });
  await expect(own).toBeVisible();
  await page.waitForTimeout(400);
  return own;
}

/**
 * Scrolls the nearest scrolling box of `target` (the page's content, a modal's body, else the
 * document) until its top is at `y` in the viewport: where the frame draws it, by width.
 */
async function place(
  target: Locator,
  y: { readonly desktop: number; readonly phone: number },
): Promise<void> {
  const phone = (target.page().viewportSize()?.width ?? 0) < 1024;
  await target.evaluate(
    (el, top) => {
      let box: Element | null = el.parentElement;
      while (
        box &&
        !(
          /(auto|scroll)/.test(getComputedStyle(box).overflowY) &&
          box.scrollHeight > box.clientHeight
        )
      )
        box = box.parentElement;
      const scroller = box ?? document.scrollingElement;
      if (scroller)
        scroller.scrollTop += el.getBoundingClientRect().top - (top as number);
    },
    phone ? y.phone : y.desktop,
  );
  await target.page().waitForTimeout(300);
}

let ids: Record<string, string> = {};
test.beforeAll(async () => {
  test.setTimeout(300_000);
  ids = (await seedSettingsWorld()).ids;
});

test('Sua IA: the owner, OpenRouter, a refused key, a member with the house plan', async ({
  browser,
}) => {
  for (const width of WIDTHS) {
    const phone = width === 'phone';
    const { context, page } = await contextAt(browser, width);
    // Desktop: the page from its top (Conta, then Sua IA, marked); a phone: Sua IA's screen.
    await section(page, 'sua-ia');
    let settings = settingsOf(page);
    await expect(settings.getByText('Quem atende você agora')).toBeVisible();
    await shoot(page, 'settings-ai', width);
    if (phone) {
      // The phone's root: who is signed in and every section, each with its summary.
      await page.goto('/configuracoes');
      await expect(
        settingsOf(page).getByRole('navigation', { name: 'Seções' }),
      ).toBeVisible();
      await expect(settingsOf(page).getByText('Carregando…')).toHaveCount(0);
      await page.waitForTimeout(400);
      await shootAs(page, 'settings-ai@mobile-index');
    }
    await context.close();

    // Each provider in a page of its own: the form keeps a draft of the last one chosen.
    const router = await contextAt(browser, width);
    settings = await section(router.page, 'sua-ia');
    await settings.getByRole('radio', { name: /^OpenRouter/ }).check();
    await expect(
      settings.getByText('Só modelos gratuitos (recomendado)'),
    ).toBeVisible();
    await place(
      settings
        .getByText(
          phone
            ? 'Conecte a sua conta em um clique'
            : 'Cedida pelo administrador',
        )
        .first(),
      { desktop: 169, phone: 138 },
    );
    await shoot(router.page, 'settings-ai-openrouter', width);
    await router.context.close();

    const openai = await contextAt(browser, width);
    settings = await section(openai.page, 'sua-ia');
    await settings.getByRole('radio', { name: /^OpenAI \(API\)/ }).check();
    await settings.getByLabel(/Chave da API/).fill('sk-proj-e2e-wrong-key');
    await settings.getByRole('button', { name: 'Testar conexão' }).click();
    const refused = settings.getByText('A chave não foi aceita pelo provedor.');
    await expect(refused).toBeVisible();
    await place(
      settings
        .getByText(
          phone
            ? 'GPT pela API, com a sua chave.'
            : 'Claude pela API, com a sua chave.',
        )
        .first(),
      { desktop: 169, phone: 160 },
    );
    await shoot(openai.page, 'settings-ai-key-refused', width);
    await openai.context.close();

    const member = await contextAt(browser, width, { email: ANA_SOUZA });
    await section(member.page, 'sua-ia');
    settings = settingsOf(member.page);
    await expect(
      settings.getByText(/cedida pelo administrador/).first(),
    ).toBeVisible();
    await shoot(member.page, 'settings-ai-member', width);
    await member.context.close();
  }
});

test('Preferências, Acessos à sua conta, Sobre', async ({ browser }) => {
  for (const width of WIDTHS) {
    const phone = width === 'phone';
    const { context, page } = await contextAt(browser, width);
    let settings = await section(page, 'preferencias');
    await expect(
      settings.getByText('Ao abrir a Nova Alexandria'),
    ).toBeVisible();
    await shoot(page, 'settings-preferences', width);
    await place(settings.getByText('Aprofundar automaticamente').first(), {
      desktop: 185,
      phone: 110,
    });
    await shoot(page, 'settings-preferences-more', width);

    settings = await section(page, 'acessos');
    await expect(
      settings.getByText('Ninguém entrou na sua conta.'),
    ).toBeVisible();
    await shoot(page, 'settings-accesses-empty', width);

    settings = await section(page, 'sobre');
    await expect(
      settings.getByRole('button', { name: 'Rever o assistente de início' }),
    ).toBeVisible();
    await shoot(page, 'settings-about', width);
    await context.close();

    const ana = await contextAt(browser, width, { email: ANA_SOUZA });
    settings = await section(ana.page, 'acessos');
    await expect(
      settings.getByText(/Conferir por que os marcadores não aparecem/),
    ).toBeVisible();
    await shoot(ana.page, 'settings-accesses', width);
    await ana.context.close();

    // A member without her own AI: Preferências opens with who answers her.
    const eduardo = await contextAt(browser, width, { email: EDUARDO });
    await section(eduardo.page, phone ? 'preferencias' : 'conta');
    settings = settingsOf(eduardo.page);
    await expect(settings.getByText('Quem atende você agora')).toBeVisible();
    await shoot(eduardo.page, 'settings-preferences-member', width);
    await eduardo.context.close();
  }
});

test('Pessoas e permissões: invitation, list, requests, editors, profiles, Ver como', async ({
  browser,
}) => {
  for (const width of WIDTHS) {
    const phone = width === 'phone';
    const { context, page } = await contextAt(browser, width, {
      servedCollectionsOnly: phone,
    });
    const people = async () => {
      const settings = await section(page, 'pessoas');
      await expect(
        settings.getByRole('button', { name: /carla\.mendes@exemplo\.test/ }),
      ).toBeVisible();
      // These frames draw the section's title 62 under the panel's top (8 above the others').
      if (!phone)
        await place(
          settings.getByRole('heading', { name: 'Pessoas e permissões' }),
          {
            desktop: 134,
            phone: 0,
          },
        );
      return settings;
    };
    const toList = (settings: Locator) =>
      place(settings.getByText('IA da aplicação para várias pessoas'), {
        desktop: 146,
        phone: 110,
      });
    const toRequests = (settings: Locator) =>
      place(settings.getByText('Solicitações pendentes').first(), {
        desktop: 140,
        phone: 104,
      });
    const modal = () => page.getByRole('dialog').last();
    const closeModal = async () => {
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    };

    let settings = await people();
    await shoot(page, 'settings-people', width);
    await toList(settings);
    await shoot(page, 'settings-people-list', width);
    await toRequests(settings);
    await shoot(page, 'settings-people-requests', width);
    const bruno = settings
      .getByRole('listitem')
      .filter({ hasText: 'bruno.lima@exemplo.test' });
    await bruno.getByRole('button', { name: 'Recusar' }).click();
    await expect(
      page.getByText('Recusar a solicitação de Bruno Lima?'),
    ).toBeVisible();
    await shoot(page, 'settings-people-request-refuse', width);

    settings = await people();
    await toList(settings);
    await settings
      .getByRole('button', { name: new RegExp(ANA_SOUZA.replace('.', '\\.')) })
      .click();
    let editor = modal();
    await expect(editor.getByRole('group', { name: 'Acervos' })).toBeVisible();
    await shoot(page, 'settings-people-editor', width);
    await editor
      .getByRole('tab', { name: 'IA e limites', exact: true })
      .click();
    await expect(editor.getByLabel('Qual IA atende esta pessoa')).toBeVisible();
    await shoot(page, 'settings-people-editor-ai', width);
    await editor.getByRole('button', { name: 'Ver como', exact: true }).click();
    const actAs = page.getByRole('dialog', { name: /^Ver como / });
    await expect(actAs.getByRole('textbox', { name: 'Motivo' })).toBeVisible();
    await shoot(page, 'settings-act-as', width);
    await actAs.getByRole('textbox', { name: 'Motivo' }).fill('ok');
    // The desktop modal's footer says "Ver como esta pessoa"; a phone's sheet header "Ver como".
    await actAs
      .getByRole('button', {
        name: phone ? 'Ver como' : 'Ver como esta pessoa',
        exact: true,
      })
      .click();
    await expect(actAs.getByText(/Escreva o motivo/)).toBeVisible();
    await shoot(page, 'settings-act-as-invalid', width);

    settings = await people();
    await toList(settings);
    await settings
      .getByRole('button', { name: /owner@kb-chat\.test/ })
      .first()
      .click();
    editor = modal();
    await expect(
      editor.getByRole('group', { name: 'Funcionalidades' }),
    ).toBeVisible();
    await shoot(page, 'settings-people-editor-master', width);
    await closeModal();

    settings = await people();
    await toList(settings);
    await settings.getByRole('button', { name: 'Configurar agora' }).click();
    editor = modal();
    // The button sits over the list: the page under the modal back at the list, as drawn.
    await toList(settings);
    // The desktop modal has "Descartar configuração"; a phone's sheet has the tabs only.
    await expect(
      phone
        ? editor.getByRole('tab', { name: 'Preferências iniciais' })
        : editor.getByRole('button', { name: 'Descartar configuração' }),
    ).toBeVisible();
    await shoot(page, 'settings-people-invite-setup', width);
    await editor
      .getByRole('tab', { name: 'IA e limites', exact: true })
      .click();
    await editor
      .getByLabel('Qual IA atende a pessoa')
      .selectOption({ label: 'Claude do administrador' });
    await expect(
      editor.getByRole('button', { name: 'Ceder assim mesmo' }),
    ).toBeVisible();
    // The frame draws the sheet from its top (choosing scrolled it to the notice).
    if (phone)
      await editor
        .locator('.ui-dialog__body')
        .evaluate((body) => body.scrollTo({ top: 0 }));
    await page.waitForTimeout(200);
    await shoot(page, 'settings-people-invite-lend', width);

    settings = await people();
    const profiles = settings.getByRole('region', {
      name: /Perfis de convite/,
    });
    await profiles.getByRole('button', { name: /Perfis de convite/ }).click();
    // A phone's row keeps its actions in its ⋯ (v2 · Perfis, celular).
    const aluno = phone
      ? profiles.getByRole('button', { name: 'Mais ações de Aluno' })
      : profiles.getByRole('button', { name: 'Editar Aluno' });
    await expect(aluno).toBeVisible();
    if (phone)
      await place(profiles.getByText('Perfis de convite').first(), {
        desktop: 0,
        phone: 111,
      });
    await shoot(page, 'settings-invite-profiles', width);
    await aluno.click();
    if (phone)
      await page.getByRole('menuitem', { name: 'Editar', exact: true }).click();
    // The profile's editor opens in place, under the list (a sheet on a phone's frame).
    await expect(page.getByLabel('Nome do perfil')).toBeVisible();
    await page
      .getByRole('tab', { name: 'Preferências iniciais', exact: true })
      .last()
      .click();
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    if (phone)
      await place(profiles.getByText('Perfis de convite').first(), {
        desktop: 0,
        phone: 111,
      });
    await shoot(page, 'settings-invite-profile-edit', width);
    await context.close();
  }
});

test('Auditoria do Ver como, IA da aplicação', async ({ browser }) => {
  for (const width of WIDTHS) {
    const { context, page } = await contextAt(browser, width);
    let settings = await section(page, 'auditoria');
    await expect(
      settings.getByText('PUT /api/v1/settings').first(),
    ).toBeVisible();
    await shoot(page, 'settings-audit', width);

    settings = await section(page, 'ia-da-aplicacao');
    await expect(settings.getByText(/Pedidos gratuitos hoje/)).toBeVisible();
    await shoot(page, 'settings-house', width);
    await place(settings.getByText('Modelos gratuitos').first(), {
      desktop: 140,
      phone: 108,
    });
    await shoot(page, 'settings-house-models', width);
    await expect(settings.getByText('Logado no servidor.')).toBeVisible();
    await place(settings.getByText('Para quem', { exact: true }).first(), {
      desktop: 140,
      phone: 108,
    });
    await shoot(page, 'settings-house-codex', width);
    await context.close();

    const off = await contextAt(browser, width, {
      houseDisconnected: true,
    });
    settings = await section(off.page, 'ia-da-aplicacao');
    await expect(
      settings.getByRole('button', { name: 'Conectar OpenRouter' }),
    ).toBeVisible();
    await shoot(off.page, 'settings-house-disconnected', width);
    await off.context.close();
  }
});

test('Mídia: Transcritores, Termos, Groq, Perfis de voz', async ({
  browser,
}) => {
  for (const width of WIDTHS) {
    const { context, page } = await contextAt(browser, width);
    let settings = await section(page, 'transcritores');
    const revoke = settings.getByRole('button', { name: `Revogar ${MAC}` });
    await expect(revoke).toBeVisible();
    await expect(
      settings.getByText('As faixas que faltavam estão na fila para o Mac.'),
    ).toBeVisible();
    await shoot(page, 'settings-transcribers', width);
    await place(settings.getByText('Pareados', { exact: true }).first(), {
      desktop: 140,
      phone: 108,
    });
    await shoot(page, 'settings-transcribers-list', width);
    await revoke.click();
    await expect(
      page.getByText(`Revogar "${MAC}"?`, { exact: false }).first(),
    ).toBeVisible();
    await shoot(page, 'settings-transcribers-revoke', width);

    settings = await section(page, 'transcritores');
    await settings.getByLabel('Nome do transcritor').fill(NEW_MAC);
    await settings.getByRole('button', { name: 'Parear transcritor' }).click();
    await expect(
      settings.getByRole('button', { name: 'Pronto, já copiei' }),
    ).toBeVisible();
    await settings.getByLabel('Nome do transcritor').fill('');
    await shoot(page, 'settings-transcribers-paired', width);
    const macs = (
      (await (await page.request.get('/api/v1/media/transcribers')).json()) as {
        items: { id: string; name: string }[];
      }
    ).items;
    for (const mac of macs.filter((one) => one.name === NEW_MAC))
      expect(
        (
          await page.request.delete(`/api/v1/media/transcribers/${mac.id}`, {
            headers: CSRF,
          })
        ).ok(),
      ).toBe(true);

    settings = await section(page, 'termos');
    await expect(settings.getByText(/162 de 224 do limite/)).toBeVisible();
    await shoot(page, 'settings-terms', width);
    const lines = Array.from(
      { length: 40 },
      (_, i) => `Termo de exemplo número ${i + 33}`,
    ).join('\n');
    await settings.getByLabel('Adicionar termos').fill(lines);
    await settings
      .getByRole('button', { name: 'Adicionar', exact: true })
      .click();
    await expect(settings.getByText('Termos (72)')).toBeVisible();
    // The frames show the list from its 33rd term ("Termo de exemplo número 33") on.
    await place(settings.locator('.chip-input').nth(32), {
      desktop: 258,
      phone: 252,
    });
    await shoot(page, 'settings-terms-over-limit', width);

    settings = await section(page, 'groq');
    await expect(settings.getByRole('radio', { name: 'Nunca' })).toBeVisible();
    await shoot(page, 'settings-groq', width);
    await settings
      .getByLabel(/chave da API do Groq/i)
      .fill('gsk_e2e_wrong_key');
    await settings.getByRole('button', { name: 'Testar conexão' }).click();
    await expect(
      settings.getByText('A chave não foi aceita pelo Groq.'),
    ).toBeVisible();
    await shoot(page, 'settings-groq-key-refused', width);

    settings = await section(page, 'groq');
    await settings
      .getByRole('radio', { name: /Quando o Mac estiver parado/ })
      .check();
    await settings.getByLabel('Horas parado').fill('0');
    await settings.getByLabel('Horas parado').blur();
    await expect(
      settings.getByText('Use um número inteiro de 1 a 168.'),
    ).toBeVisible();
    await settings.getByLabel('Teto mensal (US$)').fill('2000');
    await settings.getByRole('button', { name: 'Salvar teto' }).click();
    await expect(
      settings.getByText('Use um valor de 0 a 1000 dólares.'),
    ).toBeVisible();
    await place(settings.getByText('Quando usar o Groq').first(), {
      desktop: 140,
      phone: 108,
    });
    await shoot(page, 'settings-groq-invalid', width);

    settings = await section(page, 'perfis-de-voz');
    const collection = settings.getByLabel('Acervo', { exact: true }).first();
    await collection.selectOption({ label: 'Alquimia Prática' });
    await expect(
      settings.getByText('Nenhum perfil neste acervo.'),
    ).toBeVisible();
    await shoot(page, 'settings-voice-profiles', width);
    await settings.getByRole('button', { name: 'Cadastrar perfil' }).click();
    await expect(page.getByText('Novo perfil de voz').first()).toBeVisible();
    await shoot(page, 'settings-voice-profile-add', width);
    await context.close();

    const groq = await contextAt(browser, width, {
      groqConnected: true,
    });
    settings = await section(groq.page, 'groq');
    await expect(settings.getByText(/Chave conectada\./)).toBeVisible();
    await shoot(groq.page, 'settings-groq-connected', width);
    await groq.context.close();
  }
});

/** The wizard's four steps, each saved, "Continuar" between them. */
async function walkWizard(page: Page, width: Width): Promise<void> {
  await page.goto('/');
  const wizard = page.getByRole('dialog');
  const steps = [
    ['settings-wizard-1', 'Como a IA vai responder?'],
    ['settings-wizard-2', 'Por onde começar?'],
    ['settings-wizard-3', 'Qual acervo você estuda?'],
    ['settings-wizard-4', 'Escolha o tema'],
  ] as const;
  for (const [index, [id, heading]] of steps.entries()) {
    await expect(wizard.getByText(`Passo ${index + 1} de 4`)).toBeVisible();
    await expect(wizard.getByRole('heading', { name: heading })).toBeVisible();
    await shoot(page, id, width);
    if (index < steps.length - 1)
      await wizard.getByRole('button', { name: 'Continuar' }).click();
  }
}

test('the first-run wizard, its four steps and a member with the house plan', async ({
  browser,
}) => {
  for (const width of WIDTHS) {
    const { context, page } = await contextAt(browser, width, {
      firstRun: true,
    });
    await walkWizard(page, width);
    await context.close();

    const member = await contextAt(browser, width, {
      email: ANA_SOUZA,
      firstRun: true,
    });
    await member.page.goto('/');
    const own = member.page.getByRole('dialog');
    await expect(
      own.getByRole('heading', { name: 'Como a IA vai responder?' }),
    ).toBeVisible();
    await shoot(member.page, 'settings-wizard-1-member', width);
    await member.context.close();
  }
});

test.afterAll(() => {
  if (shots) writeFileSync(`${shots}/.done`, new Date().toISOString());
  void ids;
});
