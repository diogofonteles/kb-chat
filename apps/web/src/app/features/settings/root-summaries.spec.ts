import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import {
  ApplicationRef,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { AccessRequest } from '@kb-chat/contracts';
import { rootSummaries } from './root-summaries.js';
import type { SettingsSection } from './settings-store.js';

const REQUESTS = '/api/v1/access-requests';

const aRequest = (n: number): AccessRequest => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  email: `pessoa${n}@exemplo.test`,
  firstName: 'Pessoa',
  lastName: String(n),
  phone: null,
  source: 'form',
  createdAt: '2026-11-09T12:00:00.000Z',
});

function setUp(shownNow: readonly SettingsSection[]) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  const shown = signal<readonly SettingsSection[]>(shownNow);
  const lines = TestBed.runInInjectionContext(() =>
    rootSummaries((id) => shown().includes(id)),
  );
  const http = TestBed.inject(HttpTestingController);
  const settle = () => TestBed.inject(ApplicationRef).whenStable();
  return { lines, http, settle };
}

describe('the phone root’s lines (v2 · Índice, celular)', () => {
  it('reads nothing while the root does not show the section', () => {
    const { lines, http } = setUp([]);
    TestBed.tick();
    http.expectNone(REQUESTS);
    expect(lines()).toEqual({});
  });

  it('counts the pending requests in words', async () => {
    const { lines, http, settle } = setUp(['people']);
    TestBed.tick();
    http.expectOne(REQUESTS).flush({ items: [1, 2, 3].map(aRequest) });
    await settle();
    expect(lines().people).toBe('3 solicitações pendentes');
  });

  it('says when there is none, and keeps only the name when the read fails', async () => {
    const none = setUp(['people']);
    TestBed.tick();
    none.http.expectOne(REQUESTS).flush({ items: [] });
    await none.settle();
    expect(none.lines().people).toBe('Nenhuma solicitação pendente');
    TestBed.resetTestingModule();
    const failed = setUp(['people']);
    TestBed.tick();
    failed.http
      .expectOne(REQUESTS)
      .flush('no', { status: 500, statusText: 'Server Error' });
    await failed.settle();
    expect(failed.lines().people).toBeUndefined();
  });
});
