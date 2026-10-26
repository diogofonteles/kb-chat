import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen, within } from '@testing-library/angular';
import type { AccessRequest, Person } from '@kb-chat/contracts';
import { DEFAULT_PERSON_AI } from '@kb-chat/contracts';
import { AccessRequestsStore } from '@core/auth/access-requests-store.js';
import { SessionStore } from '@core/auth/session-store.js';
import { TOPICS } from '../../testing/fixtures.js';
import { anOwner } from '../../testing/session-fixtures.js';
import { PeoplePanel } from './people-panel.js';
import { LEND_ALL, LEND_NONE } from '../../testing/lending-fixtures.js';

const ana: AccessRequest = {
  id: '33333333-3333-4333-8333-333333333333',
  email: 'ana@example.com',
  firstName: 'Ana',
  lastName: 'Lima',
  phone: '+5581999990000',
  source: 'form',
  createdAt: '2026-10-25T10:00:00.000Z',
};
const bia: AccessRequest = {
  ...ana,
  id: '44444444-4444-4444-8444-444444444444',
  email: 'bia@gmail.com',
  firstName: 'Bia',
  lastName: 'Souza',
  phone: null,
  source: 'google',
};

const approvedAna: Person = {
  id: '55555555-5555-4555-8555-555555555555',
  email: 'ana@example.com',
  name: 'Ana Lima',
  picture: null,
  role: 'member',
  topics: [],
  features: ['search'],
  isOwner: false,
  phone: '+5581999990000',
  invitation: null,
  invitedBy: 'owner@example.com',
  createdAt: '2026-10-25T10:05:00.000Z',
  lastLoginAt: null,
  ai: DEFAULT_PERSON_AI,
};

async function renderAsMaster(requests: AccessRequest[]) {
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
  http.expectOne('/api/v1/people').flush({ items: [] });
  http.expectOne('/api/v1/topics').flush(TOPICS);
  http
    .expectOne('/api/v1/house-ai/default')
    .flush({ defaultAppAi: 'house', lendable: LEND_NONE });
  http.expectOne('/api/v1/spend/people').flush({ items: [] });
  http.expectOne('/api/v1/access-requests').flush({ items: requests });
  await result.fixture.whenStable();
  return { ...result, http };
}

const requestRow = (name: string) =>
  screen.getByText(name).closest('li') as HTMLElement;

describe('Solicitações pendentes (KBC-014 FR-4, T9)', () => {
  it('lists each request with phone, origin and date', async () => {
    await renderAsMaster([ana, bia]);

    expect(
      screen.getByRole('heading', { name: 'Solicitações pendentes (2)' }),
    ).toBeTruthy();
    expect(requestRow('Ana Lima').textContent).toContain('+55 81 99999-0000');
    expect(requestRow('Ana Lima').textContent).toContain('Cadastro');
    expect(requestRow('Bia Souza').textContent).toContain('sem celular');
    expect(requestRow('Bia Souza').textContent).toContain('Google');
    expect(TestBed.inject(AccessRequestsStore).count()).toBe(2);
  });

  it('AC-4: approving adds the person and opens their editor', async () => {
    const { http, fixture } = await renderAsMaster([ana]);

    fireEvent.click(
      within(requestRow('Ana Lima')).getByRole('button', { name: 'Aprovar' }),
    );
    const approve = http.expectOne(`/api/v1/access-requests/${ana.id}/approve`);
    expect(approve.request.method).toBe('POST');
    approve.flush(approvedAna, { status: 201, statusText: 'Created' });
    await fixture.whenStable();

    expect(
      screen.queryByRole('heading', { name: /Solicitações pendentes/ }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: /Ana Lima/, expanded: true }),
    ).toBeTruthy();
    expect(
      screen.getByText('Acesso aprovado. Escolha os acervos de Ana Lima.'),
    ).toBeTruthy();
    expect(TestBed.inject(AccessRequestsStore).count()).toBe(0);
  });

  it('refuses after a confirmation that names the 24 hours, with focus on it', async () => {
    const { http, fixture } = await renderAsMaster([ana]);

    fireEvent.click(
      within(requestRow('Ana Lima')).getByRole('button', { name: 'Recusar' }),
    );
    await fixture.whenStable();
    expect(
      screen.getByText(/só poderá pedir de novo em 24 horas/),
    ).toBeTruthy();
    const confirm = screen.getByRole('button', { name: 'Recusar' });
    expect(document.activeElement).toBe(confirm);

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await fixture.whenStable();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Recusar' }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Recusar' }));
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Recusar' }));
    http
      .expectOne(`/api/v1/access-requests/${ana.id}/refuse`)
      .flush(null, { status: 204, statusText: 'No Content' });
    await fixture.whenStable();
    expect(screen.queryByText('Ana Lima')).toBeNull();
  });

  it('shows a failed approval on the request itself', async () => {
    const { http, fixture } = await renderAsMaster([ana]);

    fireEvent.click(screen.getByRole('button', { name: 'Aprovar' }));
    http
      .expectOne(`/api/v1/access-requests/${ana.id}/approve`)
      .flush(
        { error: { code: 'ALREADY_INVITED', message: 'x' } },
        { status: 409, statusText: 'Conflict' },
      );
    await fixture.whenStable();

    expect(
      within(requestRow('Ana Lima')).getByRole('alert').textContent,
    ).toContain('Este e-mail já foi convidado.');
  });
});
