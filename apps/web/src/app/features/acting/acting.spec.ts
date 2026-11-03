import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import type { ActAsAuditEntry, Me } from '@kb-chat/contracts';
import { RESTART_APP } from '@core/auth/act-as-api.js';
import { SessionStore } from '@core/auth/session-store.js';
import { aMe } from '../../testing/session-fixtures.js';
import { ActAsAudit } from './act-as-audit.js';
import { ActingBanner } from './acting-banner.js';
import { MyAccesses } from './my-accesses.js';

const ana = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Ana Souza',
  email: 'ana@example.com',
};
const dono = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Dono',
  email: 'owner@example.com',
};

const acting = (remainingMs: number): Me =>
  aMe({
    email: ana.email,
    name: ana.name,
    actingAs: {
      person: ana,
      actor: dono,
      reason: 'não vê os marcadores',
      startedAt: '2026-11-03T12:00:00.000Z',
      endsAt: '2026-11-03T12:30:00.000Z',
      remainingMs,
    },
  });

async function renderBanner(me: Me) {
  const restart = vi.fn();
  const result = await render(ActingBanner, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: RESTART_APP, useValue: restart },
      { provide: SessionStore, useValue: { me: signal(me) } },
    ],
  });
  return { ...result, restart, http: TestBed.inject(HttpTestingController) };
}

describe('ActingBanner (KBC-060 FR-5)', () => {
  afterEach(() => vi.useRealTimers());

  it('says whose view it is and the time left, and is said once to screen readers', async () => {
    vi.useFakeTimers({
      toFake: ['performance', 'setInterval', 'clearInterval'],
    });
    // The browser's own clock is irrelevant: the server said 29:41 were left.
    const { fixture } = await renderBanner(acting(29 * 60_000 + 41_000));
    vi.advanceTimersByTime(1_000);
    await fixture.whenStable();
    expect(screen.getByText('Ana Souza')).toBeTruthy();
    expect(screen.getByText(/termina em 29:40/)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain(
      'Você está vendo como Ana Souza.',
    );
  });

  it('warns a minute before the end and goes back at the end', async () => {
    vi.useFakeTimers({
      toFake: ['performance', 'setInterval', 'clearInterval'],
    });
    const { fixture, restart } = await renderBanner(acting(61_000));
    vi.advanceTimersByTime(2_000);
    await fixture.whenStable();
    expect(screen.getByRole('status').textContent).toContain(
      'Falta 1 minuto para voltar à sua conta.',
    );
    vi.advanceTimersByTime(60_000);
    expect(restart).toHaveBeenCalled();
  });

  it('"Voltar para a minha conta" ends it and reloads, even if it had already ended', async () => {
    const { fixture, http, restart } = await renderBanner(acting(20 * 60_000));
    fireEvent.click(
      screen.getByRole('button', { name: 'Voltar para a minha conta' }),
    );
    http
      .expectOne({ method: 'DELETE', url: '/api/v1/act-as' })
      .flush(null, { status: 404, statusText: 'Not Found' });
    await fixture.whenStable();
    expect(restart).toHaveBeenCalledOnce();
  });

  it('shows nothing when nobody acts, not even an empty status region', async () => {
    await renderBanner(aMe());
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('"Acessos à sua conta" and the audit (KBC-060 FR-6, FR-7)', () => {
  const providers = [
    provideZonelessChangeDetection(),
    provideHttpClient(),
    provideHttpClientTesting(),
  ];

  it('lists each access with who, when, the changes and the reason', async () => {
    const { fixture } = await render(MyAccesses, { providers });
    TestBed.inject(HttpTestingController)
      .expectOne('/api/v1/me/accesses')
      .flush({
        items: [
          {
            actorName: 'Dono',
            actorEmail: dono.email,
            reason: 'não vê os marcadores',
            startedAt: '2026-11-03T12:00:00.000Z',
            endedAt: '2026-11-03T12:10:00.000Z',
            writes: 2,
          },
        ],
      });
    await fixture.whenStable();
    const item = screen.getByRole('listitem');
    expect(item.textContent).toContain('Dono');
    expect(item.textContent).toContain('2 alterações');
    expect(item.textContent).toContain('não vê os marcadores');
  });

  it('says nobody entered when there is no access', async () => {
    const { fixture } = await render(MyAccesses, { providers });
    TestBed.inject(HttpTestingController)
      .expectOne('/api/v1/me/accesses')
      .flush({ items: [] });
    await fixture.whenStable();
    expect(screen.getByText('Ninguém entrou na sua conta.')).toBeTruthy();
  });

  it('filters the audit by a name or e-mail of either side', async () => {
    const entries: ActAsAuditEntry[] = [
      {
        at: '2026-11-03T12:05:00.000Z',
        kind: 'write',
        actor: dono,
        person: ana,
        reason: 'r1',
        method: 'PUT',
        route: '/api/v1/settings',
      },
      {
        at: '2026-11-03T12:00:00.000Z',
        kind: 'end',
        actor: dono,
        person: { ...ana, name: 'Bia', email: 'bia@example.com' },
        reason: 'r2',
        endedBy: 'timeout',
      },
    ];
    const { fixture } = await render(ActAsAudit, { providers });
    TestBed.inject(HttpTestingController)
      .expectOne('/api/v1/act-as/audit')
      .flush({ items: entries });
    await fixture.whenStable();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText(/PUT \/api\/v1\/settings/)).toBeTruthy();
    expect(screen.getByText(/30 minutos acabaram/)).toBeTruthy();
    const filter = screen.getByRole('searchbox', {
      name: 'Filtrar por pessoa ou master',
    });
    fireEvent.input(filter, { target: { value: 'bia' } });
    await fixture.whenStable();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    fireEvent.input(filter, { target: { value: 'ninguém' } });
    await fixture.whenStable();
    expect(screen.getByText('Nenhum registro.')).toBeTruthy();
  });
});
