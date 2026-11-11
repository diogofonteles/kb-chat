import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import { SessionStore } from '@core/auth/session-store.js';
import { ChatStore } from '@features/chat/chat-store.js';
import { anOwner } from '../../testing/session-fixtures.js';
import { unassignedPage } from './unassigned-fixtures.js';
import { UnassignedSection } from './unassigned-section.js';

const QUEUE = '/api/v1/topics/hermetismo/levels/unassigned';
const BULK = '/api/v1/topics/hermetismo/document-levels';
const COUNTS = '/api/v1/levels/unassigned';

async function open() {
  const rendered = await render(UnassignedSection, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      {
        provide: SessionStore,
        useValue: {
          me: signal({ ...anOwner(), features: ['content-levels'] }),
        },
      },
      {
        provide: ChatStore,
        useValue: {
          topicList: signal([{ slug: 'hermetismo', title: 'Hermetismo' }]),
          topic: signal(null),
        },
      },
    ],
    inputs: { topic: 'hermetismo' },
  });
  const http = TestBed.inject(HttpTestingController);
  TestBed.tick();
  return { ...rendered, http };
}

const chooseLevel = (code: string) =>
  fireEvent.change(screen.getByRole('combobox', { name: 'Nível' }), {
    target: { value: code.toLowerCase() },
  });

describe('"Sem nível" on T24 (KBC-107 FR-6)', () => {
  it('AC-2: filters by origin, selects the N filtered and gives them CI after a confirmation, by filter as of the list', async () => {
    const { fixture, http } = await open();
    const forty = unassignedPage({ count: 40 });
    const origins = [
      { value: 'text' as const, count: 28 },
      { value: 'audio' as const, count: 12 },
    ];
    http
      .expectOne(`${QUEUE}?limit=10`)
      .flush({ ...forty, facets: { ...forty.facets, origins } });
    await fixture.whenStable();
    expect(
      screen.getByRole('heading', { name: 'Sem nível (40)' }),
    ).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox', { name: 'Origem' }), {
      target: { value: 'audio' },
    });
    TestBed.tick();
    http.expectOne(`${QUEUE}?origin=audio&limit=10`).flush({
      ...unassignedPage({ count: 40, origin: 'audio' }, { matched: 12 }),
      facets: { ...forty.facets, origins },
    });
    await fixture.whenStable();
    fireEvent.click(
      screen.getByRole('button', { name: 'Selecionar os 12 filtrados' }),
    );
    await fixture.whenStable();
    expect(screen.getByText('12 selecionados')).toBeTruthy();
    chooseLevel('CI');
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Dar nível' }));
    await fixture.whenStable();
    expect(screen.getByText('Dar o nível CI a 12 documentos?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    const sent = http.expectOne(BULK);
    expect(sent.request.body).toEqual({
      level: 'ci',
      filter: { origin: 'audio', asOf: '2026-11-11T12:00:00.000Z' },
    });
    sent.flush({ level: { id: 'ci', code: 'CI' }, updated: 12, skipped: 0 });
    TestBed.tick();
    http
      .expectOne(`${QUEUE}?origin=audio&limit=10`)
      .flush(unassignedPage({ count: 28 }, { matched: 0, items: [] }));
    http.expectOne(COUNTS).flush({ items: [] });
    await fixture.whenStable();
    expect(screen.getByText('12 documentos foram para CI.')).toBeTruthy();
  });

  it('gives a level to the rows ticked, by id, and keeps them when it fails (MA-26)', async () => {
    const { fixture, http } = await open();
    http.expectOne(`${QUEUE}?limit=10`).flush(unassignedPage({ count: 3 }));
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Novo 1' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Novo 2' }));
    await fixture.whenStable();
    chooseLevel('QS');
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Dar nível' }));
    await fixture.whenStable();
    expect(screen.getByText('Dar o nível QS a 2 documentos?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    const sent = http.expectOne(BULK);
    expect(sent.request.body).toEqual({
      level: 'qs',
      ids: [
        { topic: 'hermetismo', id: 'raw/novo-1.md' },
        { topic: 'hermetismo', id: 'raw/novo-2.md' },
      ],
    });
    sent.flush(
      { error: { code: 'FORBIDDEN', message: 'x' } },
      { status: 403, statusText: 'Forbidden' },
    );
    await fixture.whenStable();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('2 selecionados')).toBeTruthy();
    http.expectNone(COUNTS);
  });

  it('loads more a page at a time and says when a filter keeps nothing', async () => {
    const { fixture, http } = await open();
    http.expectOne(`${QUEUE}?limit=10`).flush(unassignedPage({ count: 15 }));
    await fixture.whenStable();
    expect(screen.getAllByRole('checkbox')).toHaveLength(10);
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    http
      .expectOne(`${QUEUE}?cursor=next&limit=10`)
      .flush(unassignedPage({ count: 15, items: 0 }, { nextCursor: null }));
    await fixture.whenStable();
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();

    fireEvent.change(screen.getByLabelText('Chegou desde'), {
      target: { value: '2026-11-10' },
    });
    TestBed.tick();
    http
      .expectOne(`${QUEUE}?since=2026-11-10&limit=10`)
      .flush(unassignedPage({ count: 15, items: 0 }, { matched: 0 }));
    await fixture.whenStable();
    expect(
      screen.getByText('Nenhum documento sem nível com estes filtros.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    TestBed.tick();
    http.expectOne(`${QUEUE}?limit=10`);
  });

  it('AC-9: with no document without a level it says so', async () => {
    const { fixture, http } = await open();
    http.expectOne(`${QUEUE}?limit=10`).flush(unassignedPage({ count: 0 }));
    await fixture.whenStable();
    expect(screen.getByText('Todos os documentos têm nível.')).toBeTruthy();
  });

  it('offers to try again when the queue does not load', async () => {
    const { fixture, http } = await open();
    http
      .expectOne(`${QUEUE}?limit=10`)
      .flush('', { status: 500, statusText: 'x' });
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    TestBed.tick();
    http.expectOne(`${QUEUE}?limit=10`).flush(unassignedPage({ count: 1 }));
    await fixture.whenStable();
    expect(screen.getByRole('checkbox', { name: 'Novo 0' })).toBeTruthy();
  });
});
