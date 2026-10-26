import { ApplicationRef, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ResearchApi } from '@core/api/research-api.js';
import { of, throwError } from 'rxjs';
import { SpendStore, formatSpend } from './spend-store.js';

function createStore(spendToday: () => unknown) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: ResearchApi, useValue: { spendToday: vi.fn(spendToday) } },
    ],
  });
  return TestBed.inject(SpendStore);
}

const settle = () => TestBed.inject(ApplicationRef).whenStable();

describe('SpendStore (KBC-005 FR-5)', () => {
  afterEach(() => vi.useRealTimers());

  it('shows today’s spend against the cap and reloads on refresh', async () => {
    const values = [
      { usd: 0.03, capUsd: 1, configured: true },
      { usd: 0.05, capUsd: 1, configured: true },
    ];
    const store = createStore(() => of(values.shift()));
    await settle();
    expect(store.label()).toMatch(/^US\$\s0,03 de US\$\s1,00$/);
    store.refresh();
    await settle();
    expect(store.label()).toMatch(/^US\$\s0,05 de/);
  });

  it('reports a provider that is not configured and an unavailable spend', async () => {
    const off = createStore(() => of({ usd: 0, capUsd: 1, configured: false }));
    await settle();
    expect(off.configured()).toBe(false);
    TestBed.resetTestingModule();
    const failing = createStore(() => throwError(() => new Error('offline')));
    await settle();
    expect(failing.label()).toBe('');
    expect(failing.today.error()).toBeTruthy();
  });

  it('can reload a moment later, after the server recorded a stopped answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const spendToday = vi.fn(() => of({ usd: 0, capUsd: 1, configured: true }));
    const store = createStore(spendToday);
    await settle();
    store.refresh(1000);
    await settle();
    expect(spendToday).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    await settle();
    expect(spendToday).toHaveBeenCalledTimes(2);
  });

  it('formats dollars in pt-BR with two decimals', () => {
    expect(formatSpend(0.031)).toMatch(/^US\$\s0,03$/);
  });
});
