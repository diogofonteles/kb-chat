import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen, within } from '@testing-library/angular';
import { DEFAULT_PERSON_AI, type Person } from '@kb-chat/contracts';
import { authInterceptor } from '@core/auth/auth-interceptor.js';
import { RELOAD_PAGE, SessionStore } from '@core/auth/session-store.js';
import { anOwner } from '../../testing/session-fixtures.js';
import { TOPICS } from '../../testing/fixtures.js';
import { PeoplePanel } from './people-panel.js';

const aPerson = (overrides: Partial<Person> = {}): Person => ({
  id: '11111111-1111-4111-8111-111111111111',
  email: 'guest@example.com',
  name: 'Guest',
  picture: null,
  role: 'member',
  topics: [],
  features: ['search'],
  isOwner: false,
  phone: null,
  invitation: null,
  invitedBy: 'owner@example.com',
  createdAt: '2026-10-24T10:00:00.000Z',
  lastLoginAt: null,
  ai: DEFAULT_PERSON_AI,
  ...overrides,
});

const owner = aPerson({
  id: '22222222-2222-4222-8222-222222222222',
  email: 'owner@example.com',
  name: 'Owner',
  role: 'master',
  isOwner: true,
  lastLoginAt: '2026-10-24T12:30:00.000Z',
});

async function renderPanel(people: Person[] = [owner, aPerson()]) {
  const result = await render(PeoplePanel, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(withInterceptors([authInterceptor])),
      provideHttpClientTesting(),
      { provide: RELOAD_PAGE, useValue: () => undefined },
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  http.expectOne('/api/v1/people').flush({ items: people });
  http.expectOne('/api/v1/topics').flush(TOPICS);
  http.expectOne('/api/v1/house-ai/default').flush({ defaultAppAi: 'house' });
  await result.fixture.whenStable();
  return { ...result, http };
}

const row = (name: RegExp) => screen.getByRole('button', { name });

describe('PeoplePanel (KBC-010 FR-3)', () => {
  it('lists people with role, collections and last sign-in', async () => {
    await renderPanel();

    const list = screen.getByRole('list', { name: 'Pessoas' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(row(/Owner/).textContent).toContain('Master');
    expect(row(/Owner/).textContent).toContain('Dono');
    expect(row(/Owner/).textContent).toContain('Todos os acervos');
    expect(row(/Owner/).textContent).toContain('Último acesso 24/10/2026');
    expect(row(/Guest/).textContent).toContain('Nenhum acervo');
    expect(row(/Guest/).textContent).toContain('Ainda não entrou');
  });

  it('invites by e-mail and opens the new person', async () => {
    const { http, fixture } = await renderPanel([owner]);
    const field = screen.getByLabelText('Convidar por e-mail');
    fireEvent.input(field, { target: { value: 'new@example.com' } });
    await fixture.whenStable();

    fireEvent.click(screen.getByRole('button', { name: 'Convidar' }));
    const request = http.expectOne('/api/v1/people');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      email: 'new@example.com',
      sendEmail: true,
    });
    request.flush(
      aPerson({
        id: '33333333-3333-4333-8333-333333333333',
        email: 'new@example.com',
        name: '',
        invitation: { sentAt: '2026-10-26T12:00:00.000Z', failedAt: null },
      }),
    );
    await fixture.whenStable();

    expect(screen.getByRole('status').textContent).toContain(
      'Convite enviado para new@example.com.',
    );
    expect(row(/new@example.com/).textContent).toContain(
      'Convite enviado em 26/10/2026',
    );
    expect(screen.getByRole('group', { name: 'Acervos' })).toBeTruthy();
  });

  it('AC-2: "Não enviar e-mail de convite" invites without e-mail and says so', async () => {
    const { http, fixture } = await renderPanel([owner]);
    const box = screen.getByRole('checkbox', {
      name: 'Não enviar e-mail de convite',
    }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.input(screen.getByLabelText('Convidar por e-mail'), {
      target: { value: 'quiet@example.com' },
    });
    fireEvent.click(box);
    await fixture.whenStable();
    expect(screen.getByText(/Nenhum e-mail será enviado\./)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Convidar' }));
    const request = http.expectOne('/api/v1/people');
    expect(request.request.body).toEqual({
      email: 'quiet@example.com',
      sendEmail: false,
    });
    request.flush(aPerson({ email: 'quiet@example.com', name: '' }));
    await fixture.whenStable();

    expect(screen.getByRole('status').textContent).toContain(
      'Convite criado sem e-mail. quiet@example.com já pode entrar',
    );
    expect(box.checked).toBe(false);
  });

  it('says the e-mail was held back when the address got an invitation moments ago', async () => {
    const { http, fixture } = await renderPanel([owner]);
    fireEvent.input(screen.getByLabelText('Convidar por e-mail'), {
      target: { value: 'again@example.com' },
    });
    await fixture.whenStable();

    fireEvent.click(screen.getByRole('button', { name: 'Convidar' }));
    const request = http.expectOne('/api/v1/people');
    expect(request.request.body).toEqual({
      email: 'again@example.com',
      sendEmail: true,
    });
    request.flush(aPerson({ email: 'again@example.com', name: '' }));
    await fixture.whenStable();

    expect(screen.getByRole('status').textContent).toContain(
      'Convite criado sem e-mail: again@example.com já recebeu um convite há pouco.',
    );
  });

  it('puts "Não enviar e-mail de convite" before "Convidar" in the tab order', async () => {
    await renderPanel([owner]);
    const box = screen.getByRole('checkbox', {
      name: 'Não enviar e-mail de convite',
    });
    const button = screen.getByRole('button', { name: 'Convidar' });

    expect(
      box.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('AC-5: a failed invitation e-mail is an error, and the person stays', async () => {
    const { http, fixture } = await renderPanel([owner]);
    fireEvent.input(screen.getByLabelText('Convidar por e-mail'), {
      target: { value: 'unlucky@example.com' },
    });
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Convidar' }));
    http.expectOne('/api/v1/people').flush(
      aPerson({
        email: 'unlucky@example.com',
        name: '',
        invitation: { sentAt: null, failedAt: '2026-10-26T12:00:00.000Z' },
      }),
    );
    await fixture.whenStable();

    const status = screen.getByRole('status');
    expect(status.classList).toContain('error');
    expect(status.textContent).toContain(
      'Convite criado, mas o e-mail não foi enviado.',
    );
    expect(row(/unlucky@example.com/).textContent).toContain(
      'Falha ao enviar o convite',
    );
  });

  it('AC-3: shows "Ativo" after the first sign-in and the invitation before it', async () => {
    await renderPanel([
      owner,
      aPerson({
        invitation: { sentAt: '2026-10-25T15:30:00.000Z', failedAt: null },
      }),
    ]);

    expect(row(/Owner/).textContent).toContain('Ativo');
    expect(row(/Guest/).textContent).toContain('Convite enviado em 25/10/2026');
    expect(row(/Guest/).textContent).not.toContain('Ativo');
  });

  it('AC-4: resends the invitation and announces it', async () => {
    const { http, fixture } = await renderPanel([
      owner,
      aPerson({
        invitation: { sentAt: '2026-10-25T15:30:00.000Z', failedAt: null },
      }),
    ]);
    fireEvent.click(row(/Guest/));
    await fixture.whenStable();

    fireEvent.click(screen.getByRole('button', { name: 'Reenviar convite' }));
    const request = http.expectOne(
      '/api/v1/people/11111111-1111-4111-8111-111111111111/invitation',
    );
    expect(request.request.method).toBe('POST');
    request.flush(
      aPerson({
        invitation: { sentAt: '2026-10-26T12:00:00.000Z', failedAt: null },
      }),
    );
    await fixture.whenStable();

    expect(screen.getByRole('status').textContent).toContain(
      'Convite reenviado para guest@example.com.',
    );
    expect(document.activeElement?.textContent?.trim()).toBe(
      'Reenviar convite',
    );
    expect(row(/Guest/).textContent).toContain('Convite enviado em 26/10/2026');
  });

  it('AC-4: says from when a limited invitation can be resent', async () => {
    const { http, fixture } = await renderPanel();
    fireEvent.click(row(/Guest/));
    await fixture.whenStable();

    fireEvent.click(screen.getByRole('button', { name: 'Enviar convite' }));
    http
      .expectOne(
        '/api/v1/people/11111111-1111-4111-8111-111111111111/invitation',
      )
      .flush(
        {
          error: {
            code: 'RATE_LIMITED',
            message: 'x',
            details: { retryAt: '2026-10-26T15:10:00.000Z' },
          },
        },
        { status: 429, statusText: 'Too Many Requests' },
      );
    await fixture.whenStable();

    const status = screen.getByRole('status');
    expect(status.classList).toContain('error');
    expect(status.textContent).toContain('Erro:');
    expect(document.activeElement?.textContent?.trim()).toBe('Enviar convite');
    expect(status.textContent).toMatch(
      /Este convite foi enviado há pouco\. Você pode reenviar a partir de 26\/10 \d{2}:10\./,
    );
  });

  it('AC-5: a failed resend shows the error and keeps the invitation', async () => {
    const { http, fixture } = await renderPanel();
    fireEvent.click(row(/Guest/));
    await fixture.whenStable();

    fireEvent.click(screen.getByRole('button', { name: 'Enviar convite' }));
    http
      .expectOne(
        '/api/v1/people/11111111-1111-4111-8111-111111111111/invitation',
      )
      .flush(
        aPerson({
          invitation: { sentAt: null, failedAt: '2026-10-26T12:00:00.000Z' },
        }),
      );
    await fixture.whenStable();

    expect(screen.getByRole('status').textContent).toContain(
      'Não consegui enviar o e-mail. O convite continua valendo',
    );
    expect(row(/Guest/).textContent).toContain('Falha ao enviar o convite');
  });

  it('AC-7: offers no resend to someone who already signed in', async () => {
    const { fixture } = await renderPanel([
      owner,
      aPerson({ lastLoginAt: '2026-10-26T12:00:00.000Z' }),
    ]);
    fireEvent.click(row(/Guest/));
    await fixture.whenStable();

    expect(
      screen.queryByRole('button', { name: /enviar convite/i }),
    ).toBeNull();
  });

  it('saves a collection and a feature as soon as they change', async () => {
    const { http, fixture } = await renderPanel();
    fireEvent.click(row(/Guest/));
    await fixture.whenStable();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Hermetismo' }));
    const topics = http.expectOne(
      '/api/v1/people/11111111-1111-4111-8111-111111111111',
    );
    expect(topics.request.body).toEqual({ topics: ['hermetismo'] });
    topics.flush(aPerson({ topics: ['hermetismo'] }));
    await fixture.whenStable();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Pesquisa com IA' }));
    const features = http.expectOne(
      '/api/v1/people/11111111-1111-4111-8111-111111111111',
    );
    expect(features.request.method).toBe('PATCH');
    expect(features.request.body).toEqual({ features: ['search', 'research'] });
    features.flush(
      aPerson({ topics: ['hermetismo'], features: ['search', 'research'] }),
    );
    await fixture.whenStable();

    expect(screen.getByRole('status').textContent).toContain('Salvo.');
    expect(
      (
        screen.getByRole('checkbox', {
          name: 'Pesquisa com IA',
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  it('AC-7: shows the last-master rule when the only master tries to step down', async () => {
    const { http, fixture } = await renderPanel();
    fireEvent.click(row(/Owner/));
    await fixture.whenStable();

    expect(
      screen.getByRole('checkbox', { name: 'Hermetismo' }).matches(':disabled'),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Remover master' }));
    http
      .expectOne(`/api/v1/people/${owner.id}`)
      .flush(
        { error: { code: 'LAST_MASTER', message: 'x' } },
        { status: 409, statusText: 'Conflict' },
      );
    await fixture.whenStable();

    expect(screen.getByRole('status').textContent).toContain(
      'Deve restar ao menos um master',
    );
    expect(screen.queryByRole('button', { name: 'Revogar acesso' })).toBeNull();
  });

  it('revokes after a confirmation and removes the person from the list', async () => {
    const { http, fixture } = await renderPanel();
    fireEvent.click(row(/Guest/));
    await fixture.whenStable();

    fireEvent.click(screen.getByRole('button', { name: 'Revogar acesso' }));
    await fixture.whenStable();
    expect(
      screen.getByText(/Revogar o acesso de guest@example.com/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Revogar' }));
    const request = http.expectOne(
      '/api/v1/people/11111111-1111-4111-8111-111111111111',
    );
    expect(request.request.method).toBe('DELETE');
    request.flush(null, { status: 204, statusText: 'No Content' });
    await fixture.whenStable();

    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toContain('revogado');
  });

  it('can cancel a revocation and promote a person', async () => {
    const { http, fixture } = await renderPanel();
    fireEvent.click(row(/Guest/));
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Revogar acesso' }));
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await fixture.whenStable();

    fireEvent.click(screen.getByRole('button', { name: 'Tornar master' }));
    const request = http.expectOne(
      '/api/v1/people/11111111-1111-4111-8111-111111111111',
    );
    expect(request.request.body).toEqual({ role: 'master' });
    request.flush(aPerson({ role: 'master' }));
    await fixture.whenStable();

    expect(
      screen.getByText(
        'Masters veem todos os acervos e usam todas as funcionalidades.',
      ),
    ).toBeTruthy();
    fireEvent.click(row(/Guest/));
    await fixture.whenStable();
    expect(screen.queryByRole('group', { name: 'Acervos' })).toBeNull();
  });

  it('shows a failed invite under the e-mail field and keeps what was typed (MA-23)', async () => {
    const { http, fixture } = await renderPanel([owner, aPerson()]);
    const field = screen.getByLabelText('Convidar por e-mail');
    fireEvent.input(field, { target: { value: 'guest@example.com' } });
    await fixture.whenStable();

    fireEvent.click(screen.getByRole('button', { name: 'Convidar' }));
    http
      .expectOne('/api/v1/people')
      .flush(
        { error: { code: 'ALREADY_INVITED', message: 'x' } },
        { status: 409, statusText: 'Conflict' },
      );
    await fixture.whenStable();

    expect(screen.getByRole('alert').textContent).toContain(
      'Este e-mail já foi convidado.',
    );
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect((field as HTMLInputElement).value).toBe('guest@example.com');
    fireEvent.input(field, { target: { value: 'other@example.com' } });
    await fixture.whenStable();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('moves focus to the confirmation and back when revoking', async () => {
    const { fixture } = await renderPanel();
    fireEvent.click(row(/Guest/));
    await fixture.whenStable();

    fireEvent.click(screen.getByRole('button', { name: 'Revogar acesso' }));
    await fixture.whenStable();
    expect(document.activeElement?.textContent?.trim()).toBe('Revogar');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await fixture.whenStable();
    expect(document.activeElement?.textContent?.trim()).toBe('Revogar acesso');
  });

  it('offers to try again when the list does not load', async () => {
    const result = await render(PeoplePanel, {
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    http
      .expectOne('/api/v1/people')
      .flush({}, { status: 500, statusText: 'x' });
    http.expectOne('/api/v1/topics').flush(TOPICS);
    http.expectOne('/api/v1/house-ai/default').flush({ defaultAppAi: 'house' });
    await result.fixture.whenStable();

    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    http.expectOne('/api/v1/people').flush({ items: [owner] });
    await result.fixture.whenStable();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });
});

describe('PeoplePanel for the owner (BR-6)', () => {
  it("shows each person's AI spend today", async () => {
    const result = await render(PeoplePanel, {
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: SessionStore,
          useValue: { me: signal(anOwner()), isMaster: signal(true) },
        },
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/v1/people').flush({ items: [owner, aPerson()] });
    http.expectOne('/api/v1/topics').flush(TOPICS);
    http.expectOne('/api/v1/access-requests').flush({ items: [] });
    http.expectOne('/api/v1/house-ai/default').flush({ defaultAppAi: 'house' });
    http.expectOne('/api/v1/spend/people').flush({
      items: [
        { email: 'owner@example.com', usd: 0 },
        { email: 'guest@example.com', usd: 0.5 },
      ],
    });
    await result.fixture.whenStable();

    expect(row(/Guest/).textContent).toContain('Gasto de IA hoje: US$');
    expect(row(/Guest/).textContent).toContain('0,50');
  });
});
