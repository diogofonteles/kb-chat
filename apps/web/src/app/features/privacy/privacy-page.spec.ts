import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { render, screen } from '@testing-library/angular';
import { PrivacyPage } from './privacy-page.js';

async function renderPolicy(
  privacyContactEmail: string | null,
  failConfig = false,
) {
  const result = await render(PrivacyPage, {
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  const config = http.expectOne('/api/v1/auth/config');
  if (failConfig)
    config.flush('down', { status: 500, statusText: 'Server Error' });
  else
    config.flush({
      googleClientId: 'client-1',
      codeChannels: ['email'],
      privacyContactEmail,
    });
  await result.fixture.whenStable();
  return { ...result, http };
}

describe('PrivacyPage (KBC-016)', () => {
  it('states what is kept, who takes part, retention and rights, with the update date', async () => {
    await renderPolicy('dono@example.com');

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Política de privacidade',
      }),
    ).toBeTruthy();
    for (const section of [
      'Quais dados guardamos',
      'Para que usamos',
      'Quem participa',
      'Por quanto tempo',
      'Seus direitos',
    ]) {
      expect(
        screen.getByRole('heading', { level: 2, name: section }),
      ).toBeTruthy();
    }
    expect(screen.getByText(/só como resumo criptográfico/)).toBeTruthy();
    expect(screen.getByText(/Não vendemos nem compartilhamos/)).toBeTruthy();
    expect(screen.getByText(/região de São Paulo/)).toBeTruthy();
    expect(screen.getByText(/guardadas por 30 dias/)).toBeTruthy();
    expect(
      screen.getByText(/mesmo depois que um acesso é retirado/),
    ).toBeTruthy();
    expect(
      screen.getByText(/Registros de uso: os que passam de 90 dias/),
    ).toBeTruthy();
    expect(
      screen.getByText(/Última atualização: 25 de outubro de 2026/),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Voltar à Nova Alexandria' })
        .getAttribute('href'),
    ).toBe('/');
  });

  it('names the configured contact for data requests as a mail link', async () => {
    await renderPolicy('dono@example.com');

    expect(
      screen
        .getByRole('link', { name: 'dono@example.com' })
        .getAttribute('href'),
    ).toBe('mailto:dono@example.com');
  });

  it('points to the administrator when no contact is configured', async () => {
    await renderPolicy(null);

    expect(screen.queryByRole('link', { name: /@/ })).toBeNull();
    expect(
      screen.getByText(/fale com o administrador que aprovou o seu acesso/),
    ).toBeTruthy();
  });

  it('still shows the policy and the fallback contact when the config fails', async () => {
    await renderPolicy('dono@example.com', true);

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Política de privacidade',
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(/fale com o administrador que aprovou o seu acesso/),
    ).toBeTruthy();
  });
});
