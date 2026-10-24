import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import { ThemeStore } from '@core/theme/theme-store.js';
import { TOPICS } from '../../testing/fixtures.js';
import {
  aProviderList,
  aSettingsView,
} from '../../testing/settings-fixtures.js';
import { aiDraftFrom, aiUpdateFrom, suggestedProvider } from './ai-draft.js';
import { SettingsButton } from './settings-button.js';
import { SettingsHost } from './settings-host.js';
import { SettingsStore } from './settings-store.js';

const providers = [
  provideZonelessChangeDetection(),
  provideHttpClient(),
  provideHttpClientTesting(),
];

async function renderHost(view = aSettingsView(), list = aProviderList()) {
  localStorage.clear();
  const result = await render(SettingsHost, { providers });
  const http = TestBed.inject(HttpTestingController);
  http.expectOne('/api/v1/settings').flush(view);
  http.expectOne('/api/v1/ai/providers').flush(list);
  await result.fixture.whenStable();
  return { ...result, http };
}

const dialog = () => document.querySelector('dialog');

describe('ai draft', () => {
  it('suggests the Claude subscription when installed, then the active provider', () => {
    const view = aSettingsView();
    const withClaude = aProviderList({
      'claude-subscription': { available: true, reason: null },
    });
    expect(suggestedProvider(view, withClaude)).toBe('claude-subscription');
    expect(
      suggestedProvider(view, { ...aProviderList(), active: 'openrouter' }),
    ).toBe('openrouter');
    expect(
      suggestedProvider(view, { ...aProviderList(), active: 'stub' }),
    ).toBe('none');
    expect(
      suggestedProvider(
        aSettingsView({
          ai: { provider: 'openai', models: {}, keys: {}, dailyCapUsd: 1 },
        }),
        withClaude,
      ),
    ).toBe('openai');
  });

  it('sends a typed key only for its own per-token provider', () => {
    const draft = {
      ...aiDraftFrom(aSettingsView(), null),
      provider: 'anthropic' as const,
      key: ' sk-ant-1 ',
    };
    expect(aiUpdateFrom(draft)).toEqual({
      provider: 'anthropic',
      models: { anthropic: { fast: null, deep: null } },
      dailyCapUsd: 1,
      keys: { anthropic: 'sk-ant-1' },
    });
    expect(
      aiUpdateFrom({
        ...draft,
        provider: 'claude-subscription',
        fastModel: 'haiku',
        deepModel: 'opus',
      }),
    ).toEqual({
      provider: 'claude-subscription',
      models: { 'claude-subscription': { fast: 'haiku', deep: 'opus' } },
      dailyCapUsd: 1,
    });
    expect(aiUpdateFrom({ ...draft, provider: 'none' })).toEqual({
      provider: 'none',
      dailyCapUsd: 1,
    });
  });
});

describe('SettingsStore', () => {
  it('fetches nothing until the shell starts it', () => {
    TestBed.configureTestingModule({ providers });
    const store = TestBed.inject(SettingsStore);
    TestBed.tick();
    TestBed.inject(HttpTestingController).verify();
    expect(store.panel()).toBeNull();
  });
});

describe('first-run wizard (AC-1)', () => {
  it('opens by itself while no settings exist, and "Pular" saves the defaults', async () => {
    const { http, fixture } = await renderHost(
      aSettingsView({ exists: false }),
    );
    expect(dialog()?.open).toBe(true);
    expect(screen.getByText('Como a IA vai responder?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pular' }));
    const put = http.expectOne({ method: 'PUT', url: '/api/v1/settings' });
    expect(put.request.body).toEqual({});
    put.flush(aSettingsView());
    TestBed.tick();
    http.expectOne('/api/v1/ai/providers').flush(aProviderList());
    await fixture.whenStable();
    expect(dialog()?.open).toBe(false);
  });

  it('walks the four steps and saves the choices on "Concluir"', async () => {
    const list = aProviderList({
      'claude-subscription': { available: true, reason: null },
    });
    const { http, fixture } = await renderHost(
      aSettingsView({ exists: false }),
      list,
    );
    expect(
      (
        screen.getByRole('radio', {
          name: /Assinatura do Claude/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('radio', { name: /Buscar documentos/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    TestBed.tick();
    http.expectOne('/api/v1/topics').flush(TOPICS);
    await fixture.whenStable();
    fireEvent.change(screen.getByLabelText('Acervo padrão'), {
      target: { value: 'hermetismo' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await fixture.whenStable();
    expect(screen.getByText('Passo 4 de 4')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Tema'), {
      target: { value: 'dark' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Concluir' }));
    const put = http.expectOne({ method: 'PUT', url: '/api/v1/settings' });
    expect(put.request.body).toEqual({
      ai: {
        provider: 'claude-subscription',
        models: { 'claude-subscription': { fast: null, deep: null } },
        dailyCapUsd: 1,
      },
      preferences: {
        searchMode: 'all',
        theme: 'dark',
        defaultView: 'search',
        researchProfile: 'fast',
        autoDeepen: true,
        defaultTopic: 'hermetismo',
      },
    });
    put.flush(
      aSettingsView({
        preferences: {
          searchMode: 'all',
          theme: 'dark',
          defaultView: 'search',
          researchProfile: 'fast',
          autoDeepen: true,
        },
      }),
    );
    TestBed.tick();
    http.expectOne('/api/v1/ai/providers').flush(list);
    await fixture.whenStable();
    expect(dialog()?.open).toBe(false);
    expect(TestBed.inject(ThemeStore).theme()).toBe('dark');
  });

  it('stays closed once settings exist', async () => {
    await renderHost();
    expect(dialog()?.open).toBe(false);
  });
});

describe('Configurações', () => {
  async function openSettings(view = aSettingsView(), list = aProviderList()) {
    const result = await renderHost(view, list);
    TestBed.inject(SettingsStore).openSettings();
    await result.fixture.whenStable();
    return result;
  }

  it('opens from the ⚙ button', async () => {
    await render(SettingsButton, { providers });
    fireEvent.click(screen.getByRole('button', { name: /Configurações/ }));
    expect(TestBed.inject(SettingsStore).panel()).toBe('settings');
  });

  it('shows a missing Claude Code disabled, with how to install it (AC-3)', async () => {
    await openSettings();
    const claude = screen.getByRole('radio', {
      name: /Assinatura do Claude/,
    }) as HTMLInputElement;
    expect(claude.disabled).toBe(true);
    expect(screen.getByText(/Instale o Claude Code/)).toBeTruthy();
  });

  it('shows the ChatGPT subscription off on this server, with how to enable it', async () => {
    await openSettings(
      aSettingsView(),
      aProviderList({
        'chatgpt-subscription': { available: false, reason: 'not-enabled' },
      }),
    );
    const codex = screen.getByRole('radio', {
      name: /Assinatura do ChatGPT/,
    }) as HTMLInputElement;
    expect(codex.disabled).toBe(true);
    expect(screen.getByText('Desativado.')).toBeTruthy();
    expect(screen.getByText(/KB_CHAT_CODEX=on/)).toBeTruthy();
  });

  it('offers a fast and a deep model per provider: a list for the Claude subscription (KBC-011)', async () => {
    const view = aSettingsView({
      ai: {
        provider: 'claude-subscription',
        models: { 'claude-subscription': { deep: 'haiku' } },
        keys: {},
        dailyCapUsd: 1,
      },
    });
    const list = aProviderList({
      'claude-subscription': { available: true, reason: null },
    });
    const { http, fixture } = await openSettings(view, list);
    const fast = screen.getByLabelText('Modelo rápido') as HTMLSelectElement;
    const deep = screen.getByLabelText('Modelo profundo') as HTMLSelectElement;
    expect(fast.tagName).toBe('SELECT');
    expect(fast.value).toBe('');
    expect(fast.selectedOptions[0]?.textContent?.trim()).toBe('Padrão: sonnet');
    // The default is offered once, as "Padrão: sonnet", not again as "sonnet".
    expect([...fast.options].map((o) => o.value)).toEqual([
      '',
      'opus',
      'haiku',
    ]);
    expect(deep.value).toBe('haiku');
    fireEvent.change(fast, { target: { value: 'opus' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    const put = http.expectOne({ method: 'PUT', url: '/api/v1/settings' });
    expect(put.request.body.ai.models).toEqual({
      'claude-subscription': { fast: 'opus', deep: 'haiku' },
    });
    put.flush(view);
    TestBed.tick();
    http.expectOne('/api/v1/ai/providers').flush(list);
    await fixture.whenStable();
    // A per-token provider takes any id, with suggestions.
    fireEvent.click(screen.getByRole('radio', { name: /OpenRouter/ }));
    await fixture.whenStable();
    const free = screen.getByLabelText('Modelo rápido') as HTMLInputElement;
    expect(free.tagName).toBe('INPUT');
    expect(free.placeholder).toBe('Padrão: deepseek/deepseek-v4-flash');
    // A model the API would refuse is said on its field, and nothing is sent.
    fireEvent.input(free, { target: { value: '-rf bad' } });
    await fixture.whenStable();
    expect(free.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(/Use só letras, números/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await fixture.whenStable();
    http.expectNone({ method: 'PUT', url: '/api/v1/settings' });
    expect(screen.getByText('Corrija o modelo indicado acima.')).toBeTruthy();
    // Fixing the field clears both messages before the next "Salvar".
    fireEvent.input(free, { target: { value: 'qwen/qwen3-max' } });
    await fixture.whenStable();
    expect(screen.queryByText('Corrija o modelo indicado acima.')).toBeNull();
    expect(screen.queryByText(/Use só letras, números/)).toBeNull();
  });

  it('shows only the masked key and removes it (AC-2)', async () => {
    const view = aSettingsView({
      ai: {
        provider: 'openrouter',
        models: {},
        keys: { openrouter: { set: true, last4: 'abcd' } },
        dailyCapUsd: 1,
      },
    });
    const { http, fixture } = await openSettings(view);
    expect(screen.getByText('••••abcd')).toBeTruthy();
    expect(
      (screen.getByLabelText(/Chave da API/) as HTMLInputElement).value,
    ).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Remover' }));
    const put = http.expectOne({ method: 'PUT', url: '/api/v1/settings' });
    expect(put.request.body).toEqual({ ai: { keys: { openrouter: null } } });
    put.flush(
      aSettingsView({
        ai: { provider: 'openrouter', models: {}, keys: {}, dailyCapUsd: 1 },
      }),
    );
    TestBed.tick();
    http.expectOne('/api/v1/ai/providers').flush(aProviderList());
    await fixture.whenStable();
    expect(screen.queryByText('••••abcd')).toBeNull();
  });

  it('tests a typed key and explains a refusal (AC-5)', async () => {
    const { http, fixture } = await openSettings();
    fireEvent.click(screen.getByRole('radio', { name: /OpenAI API/ }));
    await fixture.whenStable();
    fireEvent.input(screen.getByLabelText(/Chave da API/), {
      target: { value: 'sk-wrong-1234' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Testar conexão' }));
    await fixture.whenStable();
    expect(screen.getByText(/Testando/)).toBeTruthy();
    const test = http.expectOne({
      method: 'POST',
      url: '/api/v1/settings/ai/test',
    });
    expect(test.request.body).toEqual({
      provider: 'openai',
      key: 'sk-wrong-1234',
    });
    test.flush({
      ok: false,
      code: 'LLM_KEY_REJECTED',
      model: 'gpt-5.4-mini',
      latencyMs: 300,
    });
    await fixture.whenStable();
    expect(
      screen.getByText('A chave não foi aceita pelo provedor.'),
    ).toBeTruthy();
  });

  it('saves the provider with "Salvar" and preferences as they change', async () => {
    const { http, fixture } = await openSettings();
    fireEvent.click(screen.getByRole('radio', { name: /Anthropic API/ }));
    await fixture.whenStable();
    fireEvent.input(screen.getByLabelText(/Chave da API/), {
      target: { value: 'sk-ant-key-9999' },
    });
    fireEvent.change(screen.getByLabelText(/Limite de gasto/), {
      target: { value: '2.5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    const put = http.expectOne({ method: 'PUT', url: '/api/v1/settings' });
    expect(put.request.body).toEqual({
      ai: {
        provider: 'anthropic',
        models: { anthropic: { fast: null, deep: null } },
        dailyCapUsd: 2.5,
        keys: { anthropic: 'sk-ant-key-9999' },
      },
    });
    put.flush(aSettingsView());
    TestBed.tick();
    http.expectOne('/api/v1/ai/providers').flush(aProviderList());
    await fixture.whenStable();
    expect(screen.getByText('Salvo.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Preferências' }));
    TestBed.tick();
    http.expectOne('/api/v1/topics').flush(TOPICS);
    fireEvent.change(screen.getByLabelText(/Como buscar/), {
      target: { value: 'exact' },
    });
    const prefs = http.expectOne({ method: 'PUT', url: '/api/v1/settings' });
    expect(prefs.request.body.preferences).toMatchObject({
      searchMode: 'exact',
      defaultTopic: null,
    });
    prefs.flush(
      aSettingsView({
        preferences: {
          searchMode: 'exact',
          theme: 'auto',
          defaultView: 'search',
          researchProfile: 'fast',
          autoDeepen: true,
        },
      }),
    );
    TestBed.tick();
    http.expectOne('/api/v1/ai/providers').flush(aProviderList());
    await fixture.whenStable();
    expect(localStorage.getItem('kb-chat.search-mode')).toBe('exact');
    // The saved default view applies to the next page in this browser.
    expect(localStorage.getItem('kb-chat.view')).toBe('search');
    // "Aprofundar automaticamente" is on by default and saves when turned off (ADR 0009).
    const deepen = screen.getByRole('checkbox', {
      name: 'Aprofundar automaticamente',
    }) as HTMLInputElement;
    expect(deepen.checked).toBe(true);
    fireEvent.click(deepen);
    const off = http.expectOne({ method: 'PUT', url: '/api/v1/settings' });
    expect(off.request.body.preferences).toMatchObject({ autoDeepen: false });
  });

  it('tells where the data lives and reopens the wizard', async () => {
    const { fixture } = await openSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Sobre' }));
    await fixture.whenStable();
    expect(screen.getByText(/Seus dados ficam neste computador/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Rever o assistente de início' }),
    );
    await fixture.whenStable();
    expect(screen.getByText('Passo 1 de 4')).toBeTruthy();
  });

  it('closes with × and with Esc', async () => {
    const { fixture } = await openSettings();
    fireEvent.click(
      screen.getByRole('button', { name: 'Fechar configurações' }),
    );
    await fixture.whenStable();
    expect(dialog()?.open).toBe(false);
    TestBed.inject(SettingsStore).openSettings();
    await fixture.whenStable();
    dialog()?.close();
    await fixture.whenStable();
    expect(TestBed.inject(SettingsStore).panel()).toBeNull();
  });
});
