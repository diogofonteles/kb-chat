import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { WebSearchSettings } from '@kb-chat/contracts';
import { fireEvent, render, screen } from '@testing-library/angular';
import { WebSearchSettingsPanel } from './web-search-settings.js';

const URL = '/api/v1/web-search/settings';
const OFF: WebSearchSettings = {
  connected: false,
  keyHint: null,
  credits: null,
  low: false,
  checkedAt: null,
  problem: null,
};
const ON: WebSearchSettings = {
  connected: true,
  keyHint: 'wxyz',
  credits: {
    remaining: 994,
    plan: 1_000,
    periodEnd: '2026-12-15T12:00:00.000Z',
  },
  low: false,
  checkedAt: '2026-11-25T12:00:00.000Z',
  problem: null,
};

async function open(settings: WebSearchSettings | 'fails' = OFF) {
  const { fixture } = await render(WebSearchSettingsPanel, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve));
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve));
  };
  const load = http.expectOne(URL);
  if (settings === 'fails') load.flush('', { status: 500, statusText: 'x' });
  else load.flush(settings);
  await settle();
  return { fixture, http, settle };
}

const field = (name: string) => screen.getByLabelText<HTMLInputElement>(name);
const button = (name: string) => screen.getByRole('button', { name });
const status = () => screen.getByRole('status').textContent?.trim();
const page = () => document.body.textContent?.replace(/\s+/g, ' ') ?? '';

describe('WebSearchSettingsPanel (KBC-185)', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('asks for the key when there is none, never in clear', async () => {
    await open();
    const key = field('Chave da API do Firecrawl');
    expect([key.type, key.autocomplete]).toEqual(['password', 'off']);
    expect(screen.queryByText('Remover chave')).toBeNull();
    expect(screen.queryByText('Saldo')).toBeNull();
  });

  it('shows the key’s last 4 characters and the balance', async () => {
    await open(ON);
    expect(page()).toContain('Chave conectada, terminada em wxyz.');
    expect(page()).toContain('994 de 1.000 créditos até 15/12');
    expect(page()).not.toContain('Restam menos de 100 créditos');
  });

  it.each([
    [{ remaining: 1_200, plan: 1_000, periodEnd: null }, '1.200 créditos'],
    [{ remaining: 5, plan: null, periodEnd: null }, '5 créditos'],
    [
      { remaining: 5, plan: null, periodEnd: '2026-12-15T12:00:00.000Z' },
      '5 créditos até 15/12',
    ],
  ])('says what is known of the balance %o', async (credits, text) => {
    await open({ ...ON, credits });
    expect(page()).toContain(text);
    expect(page()).not.toContain(' de 1.000');
  });

  it('warns when few credits are left', async () => {
    await open({
      ...ON,
      low: true,
      credits: { remaining: 42, plan: 1_000, periodEnd: null },
    });
    expect(screen.getByText('Restam menos de 100 créditos')).toBeTruthy();
  });

  it('says the key was refused, and that Firecrawl does not answer', async () => {
    await open({ ...ON, problem: 'key-rejected' });
    expect(page()).toContain('O Firecrawl recusou a chave guardada.');
    expect(page()).not.toContain('Chave conectada');
    TestBed.resetTestingModule();
    document.body.innerHTML = '';
    await open({ ...ON, credits: null, problem: 'unreachable' });
    expect(page()).toContain('Não consegui falar com o Firecrawl agora');
    expect(page()).toContain('Ainda não consegui ler o saldo.');
  });

  it('tests and saves a key, once, and empties the field', async () => {
    const { http, settle } = await open();
    const key = field('Chave da API do Firecrawl');
    fireEvent.input(key, { target: { value: ' fc-nova-chave ' } });
    await settle();
    button('Testar e salvar').click();
    button('Testar e salvar').click();
    await settle();
    expect(status()).toBe('Testando…');
    const request = http.expectOne(URL);
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual({ key: 'fc-nova-chave' });
    request.flush(ON);
    await settle();
    expect(status()).toBe('Chave aceita e salva.');
    expect(key.value).toBe('');
    expect(field('Trocar a chave da API do Firecrawl')).toBe(key);
    expect(page()).toContain('994 de 1.000 créditos');
  });

  it.each([
    [422, 'WEB_SEARCH_KEY_REJECTED', 'O Firecrawl não aceitou esta chave.'],
    [503, 'WEB_SEARCH_UNAVAILABLE', 'Não consegui falar com o Firecrawl.'],
    [400, 'VALIDATION_FAILED', 'Isto não parece uma chave do Firecrawl.'],
  ])('says why a key was not saved on %i', async (code, name, text) => {
    const { http, settle } = await open(ON);
    const key = field('Trocar a chave da API do Firecrawl');
    fireEvent.input(key, { target: { value: 'fc-errada' } });
    await settle();
    fireEvent.click(button('Testar e salvar'));
    await settle();
    http
      .expectOne(URL)
      .flush(
        { error: { code: name, message: 'x' } },
        { status: code, statusText: 'x' },
      );
    await settle();
    expect(status()).toContain(text);
    expect(key.getAttribute('aria-describedby')).toContain(
      'web-search-key-status',
    );
    // What was typed stays, and so does the key in use.
    expect(key.value).toBe('fc-errada');
    expect(page()).toContain('Chave conectada');
  });

  it('asks for a key before testing, sending nothing', async () => {
    const { settle } = await open();
    fireEvent.click(button('Testar e salvar'));
    await settle();
    expect(status()).toBe('Cole a chave do Firecrawl antes de testar.');
    expect(document.activeElement).toBe(field('Chave da API do Firecrawl'));
  });

  it('removes the key, the focus going to the field', async () => {
    const { http, settle } = await open(ON);
    fireEvent.click(button('Remover chave'));
    await settle();
    const request = http.expectOne(URL);
    expect(request.request.method).toBe('DELETE');
    request.flush(OFF);
    await settle();
    expect(status()).toContain('Chave removida.');
    expect(screen.queryByText('Saldo')).toBeNull();
    expect(document.activeElement).toBe(field('Chave da API do Firecrawl'));
  });

  it('offers to try again when it does not load', async () => {
    const { http, settle } = await open('fails');
    expect(screen.getByRole('alert').textContent).toContain(
      'Não consegui carregar a pesquisa na web.',
    );
    fireEvent.click(button('Tentar de novo'));
    await settle();
    http.expectOne(URL).flush(ON);
    await settle();
    expect(page()).toContain('Chave conectada');
  });
});
