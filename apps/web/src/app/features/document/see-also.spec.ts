import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { SubjectTrack } from '@kb-chat/contracts';
import { fireEvent, render, screen } from '@testing-library/angular';
import { SessionStore } from '@core/auth/session-store.js';
import { aDocument } from '../../testing/fixtures.js';
import { SeeAlsoSection } from './see-also.js';

const NONE = { items: [], total: 0 };
const NOTHING = {
  exampleOf: NONE,
  extends: NONE,
  related: NONE,
  examples: NONE,
  extendedBy: NONE,
  relatedFrom: NONE,
};
const URL = '/api/v1/topics/hermetismo/concepts/Cabala/media';

const aTrack = (ordinal: number): SubjectTrack => ({
  id: `6f1c2b9b-8a11-4d0a-9d55-0b6f1f0e6a${String(ordinal).padStart(2, '0')}`,
  topic: 'hermetismo',
  title: `Pergunta ${ordinal}`,
  author: null,
  durationMs: 60_000,
  summary: null,
  parentTitle: 'Palestra de 1998',
});

async function renderSection(
  options: {
    readonly allowed?: boolean;
    readonly seeAlso?: ReturnType<typeof aDocument>['seeAlso'];
  } = {},
) {
  const allowed = options.allowed ?? true;
  const view = await render(SeeAlsoSection, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: SessionStore, useValue: { can: () => allowed } },
    ],
    inputs: {
      topic: 'hermetismo',
      documentId: 'wiki/concepts/Cabala.md',
      seeAlso: options.seeAlso ?? NOTHING,
      concept: 'Cabala',
    },
  });
  return { ...view, http: TestBed.inject(HttpTestingController) };
}

describe('SeeAlsoSection, tracks of a concept (KBC-070 AC-5)', () => {
  it('lists the tracks, each opening the player at the start', async () => {
    const view = await renderSection();
    view.http
      .expectOne(URL)
      .flush({ items: [aTrack(1)], total: 1, nextOffset: null });
    await view.fixture.whenStable();
    expect(
      screen.getByRole('heading', {
        name: 'Perguntas e respostas sobre este assunto',
      }),
    ).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Pergunta 1' });
    expect(link.getAttribute('href')).toBe(`/midia/${aTrack(1).id}?t=0`);
    expect(screen.queryByRole('button', { name: /Ver todas/ })).toBeNull();
  });

  it('asks nothing for who may not see subjects', async () => {
    const view = await renderSection({ allowed: false });
    view.http.expectNone(URL);
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('shows no section with no tracks and no relations (UP-10)', async () => {
    const view = await renderSection();
    view.http.expectOne(URL).flush({ items: [], total: 0, nextOffset: null });
    await view.fixture.whenStable();
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('"Ver todas" brings the rest', async () => {
    const view = await renderSection();
    view.http
      .expectOne(URL)
      .flush({ items: [aTrack(1)], total: 2, nextOffset: 1 });
    await view.fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Ver todas (2)' }));
    view.http
      .expectOne(`${URL}?offset=1&limit=50`)
      .flush({ items: [aTrack(2)], total: 2, nextOffset: null });
    await view.fixture.whenStable();
    expect(screen.getByRole('link', { name: 'Pergunta 2' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Ver todas/ })).toBeNull();
  });

  it('says so when "Ver todas" fails, keeping what it has', async () => {
    const view = await renderSection();
    view.http
      .expectOne(URL)
      .flush({ items: [aTrack(1)], total: 2, nextOffset: 1 });
    await view.fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Ver todas (2)' }));
    view.http
      .expectOne(`${URL}?offset=1&limit=50`)
      .flush('no', { status: 500, statusText: 'Error' });
    await view.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Não consegui carregar mais referências.',
    );
  });

  it('says so when the tracks fail', async () => {
    const view = await renderSection();
    view.http.expectOne(URL).flush('no', { status: 500, statusText: 'Error' });
    await view.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Não consegui carregar as faixas.',
    );
  });
});
