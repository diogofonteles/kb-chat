import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen, within } from '@testing-library/angular';
import { DEFAULT_PERSON_AI, type Person } from '@kb-chat/contracts';
import { RESTART_APP } from '@core/auth/act-as-api.js';
import { SessionStore } from '@core/auth/session-store.js';
import { aMe, anOwner } from '../../testing/session-fixtures.js';
import { TOPICS } from '../../testing/fixtures.js';
import { LEND_NONE } from '../../testing/lending-fixtures.js';
import { PeoplePanel } from './people-panel.js';

const aPerson = (overrides: Partial<Person> = {}): Person => ({
  id: '11111111-1111-4111-8111-111111111111',
  email: 'ana@example.com',
  name: 'Ana Souza',
  picture: null,
  role: 'member',
  topics: [],
  features: ['search'],
  isOwner: false,
  canActAs: false,
  phone: null,
  invitation: null,
  invitedBy: 'owner@example.com',
  createdAt: '2026-10-24T10:00:00.000Z',
  lastLoginAt: '2026-11-01T10:00:00.000Z',
  ai: DEFAULT_PERSON_AI,
  ...overrides,
});
const owner = aPerson({
  id: '22222222-2222-4222-8222-222222222222',
  email: 'owner@example.com',
  name: 'Dono',
  role: 'master',
  isOwner: true,
  canActAs: true,
});
const bruno = aPerson({
  id: '33333333-3333-4333-8333-333333333333',
  email: 'bruno@example.com',
  name: 'Bruno',
  role: 'master',
});

async function renderPanel(
  me = anOwner(),
  people: Person[] = [owner, aPerson(), bruno],
) {
  const restart = vi.fn();
  const result = await render(PeoplePanel, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: RESTART_APP, useValue: restart },
      {
        provide: SessionStore,
        useValue: { me: signal(me), isMaster: signal(me.role === 'master') },
      },
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  http.expectOne('/api/v1/people').flush({ items: people });
  http.expectOne('/api/v1/topics').flush(TOPICS);
  http.match('/api/v1/access-requests').forEach((r) => r.flush({ items: [] }));
  http
    .expectOne('/api/v1/house-ai/default')
    .flush({ defaultAppAi: 'house', lendable: LEND_NONE });
  http.expectOne('/api/v1/invite-profiles').flush({ items: [] });
  http.match('/api/v1/spend/people').forEach((r) => r.flush({ items: [] }));
  await result.fixture.whenStable();
  return { ...result, http, restart };
}

async function open(name: RegExp, fixture: { whenStable(): Promise<unknown> }) {
  fireEvent.click(screen.getByRole('button', { name }));
  await fixture.whenStable();
}

describe('Ver como outra pessoa (KBC-060)', () => {
  it('offers "Ver como" on a member only, never on the owner or a master (BR-2)', async () => {
    const { fixture } = await renderPanel();
    await open(/Ana Souza/, fixture);
    expect(screen.getByRole('button', { name: /^Ver como$/ })).toBeTruthy();
    await open(/Bruno/, fixture);
    expect(screen.queryByRole('button', { name: /^Ver como$/ })).toBeNull();
  });

  it('asks for a reason, then starts and reloads the app as the person (FR-1, AC-9)', async () => {
    const { fixture, http, restart } = await renderPanel();
    await open(/Ana Souza/, fixture);
    fireEvent.click(screen.getByRole('button', { name: /^Ver como$/ }));
    await fixture.whenStable();
    const dialog = screen.getByRole('dialog', { name: 'Ver como Ana Souza' });
    const start = within(dialog).getByRole('button', {
      name: 'Ver como esta pessoa',
    });
    fireEvent.click(start);
    await fixture.whenStable();
    expect(within(dialog).getByText(/Escreva o motivo/)).toBeTruthy();
    const reason = within(dialog).getByRole('textbox', { name: 'Motivo' });
    expect(reason.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(reason);
    http.expectNone({ method: 'POST' });
    (reason as HTMLTextAreaElement).value = 'não vê os marcadores';
    fireEvent.click(start);
    const post = http.expectOne({
      method: 'POST',
      url: '/api/v1/people/11111111-1111-4111-8111-111111111111/act-as',
    });
    expect(post.request.body).toEqual({ reason: 'não vê os marcadores' });
    post.flush({
      person: { id: aPerson().id, name: 'Ana Souza', email: 'ana@example.com' },
      actor: { id: owner.id, name: 'Dono', email: 'owner@example.com' },
      reason: 'não vê os marcadores',
      startedAt: '2026-11-03T12:00:00.000Z',
      endsAt: '2026-11-03T12:30:00.000Z',
    });
    expect(restart).toHaveBeenCalledOnce();
  });

  it('says why it could not start, and stays', async () => {
    const { fixture, http, restart } = await renderPanel();
    await open(/Ana Souza/, fixture);
    fireEvent.click(screen.getByRole('button', { name: /^Ver como$/ }));
    await fixture.whenStable();
    const dialog = screen.getByRole('dialog', { name: 'Ver como Ana Souza' });
    const reason = within(dialog).getByRole('textbox', { name: 'Motivo' });
    (reason as HTMLTextAreaElement).value = 'bug';
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Ver como esta pessoa' }),
    );
    http
      .expectOne({ method: 'POST' })
      .flush(
        { error: { code: 'FORBIDDEN', message: 'x' } },
        { status: 403, statusText: 'Forbidden' },
      );
    await fixture.whenStable();
    expect(within(dialog).getByRole('alert')).toBeTruthy();
    expect(restart).not.toHaveBeenCalled();
  });

  it('lets only the owner grant it to a master (BR-1)', async () => {
    const { fixture, http } = await renderPanel();
    await open(/Bruno/, fixture);
    const grant = screen.getByRole('checkbox', {
      name: 'Pode ver como outra pessoa',
    });
    fireEvent.click(grant);
    expect(
      http.expectOne({ method: 'PATCH', url: `/api/v1/people/${bruno.id}` })
        .request.body,
    ).toEqual({ canActAs: true });
  });

  it('shows neither "Ver como" nor the grant to a master without it', async () => {
    const { fixture } = await renderPanel(
      aMe({ role: 'master', email: 'bruno@example.com', canActAs: false }),
    );
    await open(/Ana Souza/, fixture);
    expect(screen.queryByRole('button', { name: /^Ver como$/ })).toBeNull();
    await open(/Bruno/, fixture);
    expect(
      screen.queryByRole('checkbox', { name: 'Pode ver como outra pessoa' }),
    ).toBeNull();
  });

  it('offers no "Ver como" on someone who has not signed in yet', async () => {
    const { fixture } = await renderPanel(anOwner(), [
      owner,
      aPerson({ lastLoginAt: null }),
      bruno,
    ]);
    await open(/Ana Souza/, fixture);
    expect(screen.queryByRole('button', { name: /^Ver como$/ })).toBeNull();
  });
});
