import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import type { FreeModelList, HouseAiView } from '@kb-chat/contracts';
import { aHouseView } from '../../testing/settings-fixtures.js';
import { GO_TO_URL } from '@core/routing/go-to-url.js';
import { HouseAiPanel } from './house-ai-panel.js';

const MODELS: FreeModelList = {
  items: [
    { id: 'fake/large:free', name: 'Fake Large', contextLength: 131072 },
    { id: 'fake/small:free', name: 'Fake Small', contextLength: 32768 },
  ],
  paid: [{ id: 'fake/paid', name: 'Fake Paid', contextLength: 200000 }],
  updatedAt: '2026-10-26T12:00:00.000Z',
  stale: false,
};

const CONNECTED = aHouseView({
  connection: {
    key: { set: true, last4: 'wxyz' },
    via: 'oauth',
    connectedAt: '2026-10-26T12:00:00.000Z',
    connectedBy: 'owner@example.com',
  },
  chain: ['fake/large:free', 'fake/small:free', 'openrouter/free'],
  freeUsage: { used: 12, limit: 50, remaining: 38 },
});

async function renderPanel(
  view: HouseAiView = CONNECTED,
  outcome: 'connected' | 'error' | null = null,
) {
  const assign = vi.fn();
  const result = await render(HouseAiPanel, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: GO_TO_URL, useValue: assign },
    ],
    inputs: { outcome },
  });
  const http = TestBed.inject(HttpTestingController);
  http.expectOne('/api/v1/house-ai').flush(view);
  http.expectOne('/api/v1/ai/free-models').flush(MODELS);
  await result.fixture.whenStable();
  return { ...result, http, assign };
}

describe('HouseAiPanel (KBC-022, T12)', () => {
  it('shows the connected account masked, today’s free requests and the 50/day hint', async () => {
    await renderPanel(CONNECTED, 'connected');
    expect(screen.getByRole('status').textContent).toContain(
      'Conta conectada.',
    );
    expect(document.body.textContent).toContain('••••wxyz');
    expect(document.body.textContent).toContain(
      'Pedidos gratuitos hoje: 12 de 50',
    );
    expect(document.body.textContent).toContain('o limite sobe para 1000');
    expect(document.body.textContent).toContain(
      'fake/large:free → fake/small:free → openrouter/free',
    );
  });

  it('sends the browser to OpenRouter on "Conectar OpenRouter"', async () => {
    const { http, assign, fixture } = await renderPanel(aHouseView());
    expect(document.body.textContent).toContain('Não conectada');
    fireEvent.click(
      screen.getByRole('button', { name: 'Conectar OpenRouter' }),
    );
    const start = http.expectOne('/api/v1/openrouter/connect');
    expect(start.request.body).toEqual({ purpose: 'house' });
    start.flush({ authorizeUrl: 'https://openrouter.ai/auth?state=s' });
    await fixture.whenStable();
    expect(assign).toHaveBeenCalledWith('https://openrouter.ai/auth?state=s');
  });

  it('saves a pasted key, never showing it back', async () => {
    const { http, fixture } = await renderPanel(aHouseView());
    fireEvent.click(screen.getByRole('button', { name: 'Colar uma chave' }));
    await fixture.whenStable();
    fireEvent.input(screen.getByLabelText('Chave da API do OpenRouter'), {
      target: { value: 'sk-or-v1-pasted-1234' },
    });
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Salvar chave' }));
    const put = http.expectOne({ method: 'PUT', url: '/api/v1/house-ai' });
    expect(put.request.body).toEqual({ key: 'sk-or-v1-pasted-1234' });
    put.flush(CONNECTED);
    await fixture.whenStable();
    expect(screen.getByRole('status').textContent).toContain('Salvo.');
    expect(screen.queryByLabelText('Chave da API do OpenRouter')).toBeNull();
  });

  it('chooses the free models by hand, the default AI and the default quota', async () => {
    const { http, fixture } = await renderPanel();
    fireEvent.click(
      screen.getByRole('checkbox', { name: /Escolher automaticamente/ }),
    );
    const manual = http.expectOne({ method: 'PUT', url: '/api/v1/house-ai' });
    expect(manual.request.body).toEqual({
      freeModels: ['fake/large:free', 'fake/small:free'],
    });
    manual.flush({
      ...CONNECTED,
      freeModels: ['fake/large:free', 'fake/small:free'],
    });
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('checkbox', { name: /Fake Small/ }));
    const unchecked = http.expectOne({
      method: 'PUT',
      url: '/api/v1/house-ai',
    });
    expect(unchecked.request.body).toEqual({ freeModels: ['fake/large:free'] });
    unchecked.flush(CONNECTED);
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('radio', { name: /Nenhuma/ }));
    expect(
      http.expectOne({ method: 'PUT', url: '/api/v1/house-ai' }).request.body,
    ).toEqual({ defaultAppAi: 'none' });
  });

  it('tests the connection and disconnects after a confirmation', async () => {
    const { http, fixture } = await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Testar conexão' }));
    http.expectOne('/api/v1/house-ai/test').flush({
      ok: false,
      code: 'LLM_KEY_REJECTED',
      model: 'openrouter',
      latencyMs: 3,
    });
    await fixture.whenStable();
    expect(screen.getByRole('status').textContent).toContain('não foi aceita');
    fireEvent.click(screen.getByRole('button', { name: 'Desconectar' }));
    await fixture.whenStable();
    expect(document.body.textContent).toContain('Desconectar a conta?');
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Desconectar' })[0] as HTMLElement,
    );
    http
      .expectOne({ method: 'DELETE', url: '/api/v1/house-ai/key' })
      .flush(null);
    TestBed.tick();
    http.expectOne('/api/v1/house-ai').flush(aHouseView());
    await fixture.whenStable();
    expect(screen.getByRole('status').textContent).toContain(
      'Conta desconectada.',
    );
  });

  it('reports a failed save and a list that could not load', async () => {
    const { http, fixture } = await renderPanel();
    fireEvent.click(screen.getByRole('checkbox', { name: /openrouter\/free/ }));
    http
      .expectOne({ method: 'PUT', url: '/api/v1/house-ai' })
      .flush({}, { status: 500, statusText: 'x' });
    await fixture.whenStable();
    expect(screen.getByRole('status').textContent).toContain(
      'Não consegui salvar',
    );
  });

  it('KBC-027 AC-4: turns Codex on and off, and says why it cannot be used', async () => {
    const { http, fixture } = await renderPanel(
      aHouseView({
        codex: { configured: true, enabled: false, loggedIn: true },
      }),
    );
    const block = screen.getByRole('region', {
      name: 'Assinatura do ChatGPT (Codex)',
    });
    expect(block.textContent).toContain('Logado no servidor.');
    expect(block.textContent).toContain('contêiner separado');
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Ligar a assinatura do ChatGPT (Codex)',
      }),
    );
    const put = http.expectOne({ method: 'PUT', url: '/api/v1/house-ai' });
    expect(put.request.body).toEqual({ codexEnabled: true });
    put.flush(
      aHouseView({
        codex: { configured: true, enabled: true, loggedIn: false },
      }),
    );
    await fixture.whenStable();
    expect(block.textContent).toContain('codex login --device-auth');
  });

  it('KBC-027: Codex cannot be turned on where it is not configured', async () => {
    await renderPanel(aHouseView());
    expect(
      (
        screen.getByRole('checkbox', {
          name: 'Ligar a assinatura do ChatGPT (Codex)',
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.getByText(/não está configurado neste servidor/),
    ).toBeTruthy();
  });
});
