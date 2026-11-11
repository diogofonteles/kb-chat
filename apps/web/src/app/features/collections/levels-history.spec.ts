import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { LevelAuditItem, LevelAuditPage } from '@kb-chat/contracts';
import { fireEvent, render, screen } from '@testing-library/angular';
import { LevelsHistory } from './levels-history.js';

const AUDIT = '/api/v1/levels/audit';

const line = (over: Partial<LevelAuditItem> = {}): LevelAuditItem => ({
  at: '2026-11-10T12:30:00.000Z',
  by: 'owner@example.com',
  byName: 'Diogo',
  actingAs: null,
  actingAsName: null,
  kind: 'item.level',
  collection: 'hermetismo',
  target: 'raw/aula-12.md',
  targetLabel: 'Aula 12',
  before: 'CI',
  after: 'CDC',
  moves: null,
  subject: 'document',
  ...over,
});

const page = (
  items: LevelAuditItem[],
  nextCursor: string | null = null,
): LevelAuditPage => ({ items, nextCursor });

async function history() {
  const rendered = await render(LevelsHistory, {
    inputs: { topic: 'hermetismo' },
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  return { ...rendered, http };
}

const toggle = () =>
  screen.getByRole('button', { name: /Histórico de níveis/ });

describe('LevelsHistory (T24, KBC-108 FR-4)', () => {
  it('asks nothing while collapsed, then lists who changed what, acting as whom', async () => {
    const { fixture, http } = await history();
    http.expectNone((request) => request.url.startsWith(AUDIT));
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle());
    TestBed.tick();
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    http.expectOne(`${AUDIT}?topic=hermetismo&limit=20`).flush(
      page([
        line({ actingAs: 'ana@example.com', actingAsName: 'Ana' }),
        line({
          kind: 'scale.reorder',
          target: null,
          targetLabel: null,
          subject: null,
          before: 'QS, CI, CDC',
          after: 'QS, CDC, CI',
        }),
        line({
          kind: 'bulk',
          target: null,
          targetLabel: null,
          subject: null,
          before: null,
          after: 'CI',
          count: { documents: 37 },
        }),
        line({
          kind: 'scale.delete',
          target: 'ci',
          targetLabel: 'CI',
          subject: 'level',
          before: 'CI',
          after: null,
          moves: { content: 'CDC', people: 'QS' },
        }),
      ]),
    );
    await fixture.whenStable();
    expect(screen.getByText('CI → CDC: “Aula 12”')).toBeTruthy();
    expect(screen.getByText(/Diogo agindo como Ana/)).toBeTruthy();
    expect(screen.getByText('Ordem: QS, CI, CDC → QS, CDC, CI')).toBeTruthy();
    expect(screen.getByText('Lote: 37 itens → CI')).toBeTruthy();
    expect(
      screen.getByText('Apagou CI: conteúdo → CDC, pessoas → QS'),
    ).toBeTruthy();
  });

  it('AC-5: "Só este item" filters by it, and "Limpar" takes the filter away', async () => {
    const { fixture, http } = await history();
    fireEvent.click(toggle());
    TestBed.tick();
    http.expectOne(`${AUDIT}?topic=hermetismo&limit=20`).flush(page([line()]));
    await fixture.whenStable();
    fireEvent.click(
      screen.getByRole('button', { name: 'Só este item: Aula 12' }),
    );
    TestBed.tick();
    http
      .expectOne(`${AUDIT}?topic=hermetismo&limit=20&target=raw%2Faula-12.md`)
      .flush(page([line()]));
    await fixture.whenStable();
    expect(screen.getByText('Só: Aula 12')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Limpar' }));
    TestBed.tick();
    http.expectOne(`${AUDIT}?topic=hermetismo&limit=20`).flush(page([]));
    await fixture.whenStable();
    expect(
      screen.getByText('Nenhuma mudança de nível neste período.'),
    ).toBeTruthy();
  });

  it('filters by kind, person and period, and pages with "Carregar mais"', async () => {
    const { fixture, http } = await history();
    fireEvent.click(toggle());
    TestBed.tick();
    http.expectOne(`${AUDIT}?topic=hermetismo&limit=20`).flush(page([]));
    await fixture.whenStable();
    fireEvent.change(screen.getByRole('combobox', { name: 'Tipo' }), {
      target: { value: 'person.level' },
    });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Quem' }), {
      target: { value: 'ana' },
    });
    fireEvent.change(screen.getByLabelText('De'), {
      target: { value: '2026-11-01' },
    });
    TestBed.tick();
    const filtered = http.match((request) => request.url.startsWith(AUDIT));
    const last = filtered.at(-1);
    expect(last?.request.url).toBe(
      `${AUDIT}?topic=hermetismo&limit=20&kind=person.level&actor=ana&from=2026-11-01`,
    );
    last?.flush(
      page(
        [line({ kind: 'person.level', subject: 'person', targetLabel: 'Bia' })],
        'c1',
      ),
    );
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    http
      .expectOne(
        `${AUDIT}?topic=hermetismo&limit=20&kind=person.level&actor=ana&from=2026-11-01&cursor=c1`,
      )
      .flush(
        page([
          line({
            kind: 'person.level',
            subject: 'person',
            targetLabel: 'Caio',
          }),
        ]),
      );
    await fixture.whenStable();
    expect(screen.getByText('CI → CDC: Caio')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();
  });

  it('says when the history does not load, and tries again', async () => {
    const { fixture, http } = await history();
    fireEvent.click(toggle());
    TestBed.tick();
    http
      .expectOne(`${AUDIT}?topic=hermetismo&limit=20`)
      .flush('', { status: 500, statusText: 'x' });
    await fixture.whenStable();
    expect(screen.getByText('Não consegui carregar o histórico.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    TestBed.tick();
    http.expectOne(`${AUDIT}?topic=hermetismo&limit=20`).flush(page([line()]));
    await fixture.whenStable();
    expect(screen.getByText('CI → CDC: “Aula 12”')).toBeTruthy();
  });
});
