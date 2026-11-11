import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { SearchHit } from '@kb-chat/contracts';
import { fireEvent, render, screen } from '@testing-library/angular';
import { SessionStore } from '@core/auth/session-store.js';
import { aHit } from '../../testing/fixtures.js';
import { aMe } from '../../testing/session-fixtures.js';
import { SearchLevelChange } from './search-level-change.js';

async function open(results: SearchHit[]) {
  const rendered = await render(SearchLevelChange, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: SessionStore, useValue: { me: signal(aMe()) } },
    ],
    inputs: { topic: 'hermetismo', results },
  });
  return { ...rendered, http: TestBed.inject(HttpTestingController) };
}

const qs = { id: 'qs', code: 'QS' };

describe('"Mudar nível" on a search (KBC-107 AC-5)', () => {
  it('is not there when the hits carry no level (members)', async () => {
    await open([aHit()]);
    expect(screen.queryByRole('button', { name: 'Mudar nível' })).toBeNull();
  });

  it("moves the documents chosen to a level up to the person's own, by id", async () => {
    const { fixture, http } = await open([
      aHit({ id: 'raw/a.md', title: 'A', level: qs }),
      aHit({ id: 'raw/b.md', title: 'B', level: null }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Mudar nível' }));
    TestBed.tick();
    http.expectOne('/api/v1/topics/hermetismo/levels/choices').flush({
      collection: 'hermetismo',
      levels: [qs, { id: 'ci', code: 'CI' }],
    });
    await fixture.whenStable();
    expect(screen.getByText('Nível: QS')).toBeTruthy();
    expect(screen.getByText('Sem nível')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Selecionar os 2 documentos' }),
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Nível' }), {
      target: { value: 'ci' },
    });
    await fixture.whenStable();
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Mudar nível' })[1] as HTMLElement,
    );
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    const sent = http.expectOne('/api/v1/topics/hermetismo/document-levels');
    expect(sent.request.body).toEqual({
      level: 'ci',
      ids: [
        { topic: 'hermetismo', id: 'raw/a.md' },
        { topic: 'hermetismo', id: 'raw/b.md' },
      ],
    });
    sent.flush({ level: { id: 'ci', code: 'CI' }, updated: 2, skipped: 0 });
    await fixture.whenStable();
    expect(screen.getAllByText('Nível: CI')).toHaveLength(2);
    expect(screen.getByText('2 documentos foram para CI.')).toBeTruthy();
    // R1-2: the focus is on what happened.
    expect(document.activeElement).toBe(screen.getByRole('status'));
  });

  it('R1-4: says how many could not be classified', async () => {
    const { fixture, http } = await open([
      aHit({ id: 'raw/a.md', title: 'A', level: qs }),
      aHit({ id: 'raw/b.md', title: 'B', level: qs }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Mudar nível' }));
    TestBed.tick();
    http
      .expectOne('/api/v1/topics/hermetismo/levels/choices')
      .flush({ collection: 'hermetismo', levels: [qs] });
    await fixture.whenStable();
    fireEvent.click(
      screen.getByRole('button', { name: 'Selecionar os 2 documentos' }),
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Nível' }), {
      target: { value: 'qs' },
    });
    await fixture.whenStable();
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Mudar nível' })[1] as HTMLElement,
    );
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    http
      .expectOne('/api/v1/topics/hermetismo/document-levels')
      .flush({ level: qs, updated: 1, skipped: 1 });
    await fixture.whenStable();
    expect(
      screen.getByText(
        '1 documento foi para QS. 1 não puderam ser classificados.',
      ),
    ).toBeTruthy();
  });
});
