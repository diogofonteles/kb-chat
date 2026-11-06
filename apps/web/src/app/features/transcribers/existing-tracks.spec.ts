import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import type {
  TrackDocumentsCollection,
  TrackDocumentsOverview,
} from '@kb-chat/contracts';
import { ExistingTracks } from './existing-tracks.js';

const URL = '/api/v1/media/track-documents';
const PUBLISH = '/api/v1/media/track-documents/publish';

const aCollection = (
  overrides: Partial<TrackDocumentsCollection> = {},
): TrackDocumentsCollection => ({
  topic: 'hermetismo',
  title: 'Hermetismo',
  tracks: 2,
  toPublish: 2,
  queued: 0,
  published: 0,
  failed: 0,
  ...overrides,
});

const anOverview = (
  overrides: Partial<TrackDocumentsOverview> = {},
): TrackDocumentsOverview => ({
  usdPerTrack: 0.001,
  remainingUsd: 9.5,
  collections: [
    aCollection(),
    aCollection({
      topic: 'udv',
      title: 'UDV',
      tracks: 3,
      toPublish: 3,
    }),
  ],
  ...overrides,
});

async function renderIt(overview: TrackDocumentsOverview = anOverview()) {
  const result = await render(ExistingTracks, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  http.expectOne(URL).flush(overview);
  await result.fixture.whenStable();
  return { ...result, http };
}

const open = async (fixture: { whenStable(): Promise<unknown> }) => {
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Publicar no acervo as faixas que já existem',
    }),
  );
  await fixture.whenStable();
};

describe('ExistingTracks (KBC-099 AC-16, scope of 2026-11-06)', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('shows, before confirming, each collection with its tracks to publish, the total and the estimated kb cost', async () => {
    const { fixture } = await renderIt();
    await open(fixture);
    const hermetismo = screen.getByRole('checkbox', {
      name: 'Hermetismo · 2 faixas a publicar',
    }) as HTMLInputElement;
    expect(hermetismo.checked).toBe(true);
    expect(
      (
        screen.getByRole('checkbox', {
          name: 'UDV · 3 faixas a publicar',
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(document.body.textContent).toContain(
      '5 faixas · custo estimado do kb ≈ US$ 0,005',
    );
    expect(document.body.textContent).toContain(
      'resta US$ 9,50 do teto mensal da mídia',
    );
    fireEvent.click(hermetismo);
    await fixture.whenStable();
    expect(document.body.textContent).toContain(
      '3 faixas · custo estimado do kb ≈ US$ 0,003',
    );
    expect(
      screen.getByRole('button', { name: 'Publicar 3 faixas' }),
    ).toBeTruthy();
  });

  it('queues the chosen collections, says how many, and shows the progress', async () => {
    const { fixture, http } = await renderIt();
    await open(fixture);
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'UDV · 3 faixas a publicar' }),
    );
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Publicar 2 faixas' }));
    const sent = http.expectOne(PUBLISH);
    expect(sent.request.method).toBe('POST');
    expect(sent.request.body).toEqual({ topics: ['hermetismo'] });
    sent.flush({ queued: 2, skipped: 0 });
    TestBed.tick();
    http.expectOne(URL).flush(
      anOverview({
        collections: [aCollection({ queued: 2 })],
      }),
    );
    await fixture.whenStable();
    expect(screen.getByRole('status').textContent).toContain(
      '2 faixas na fila para o Mac.',
    );
    expect(document.body.textContent).toContain(
      'Hermetismo: 2 na fila · 0 publicadas · 0 falharam',
    );
  });

  it('says when everything chosen was already in the collection (idempotent)', async () => {
    const { fixture, http } = await renderIt(
      anOverview({ collections: [aCollection()] }),
    );
    await open(fixture);
    fireEvent.click(screen.getByRole('button', { name: 'Publicar 2 faixas' }));
    http.expectOne(PUBLISH).flush({ queued: 0, skipped: 2 });
    TestBed.tick();
    http.expectOne(URL).flush(anOverview({ collections: [] }));
    await fixture.whenStable();
    expect(screen.getByRole('status').textContent).toContain(
      'Nada novo a publicar: 2 faixas já estavam no acervo.',
    );
  });

  it('cannot publish with the media monthly ceiling spent, and says so', async () => {
    const { fixture } = await renderIt(anOverview({ remainingUsd: 0 }));
    await open(fixture);
    expect(document.body.textContent).toContain(
      'Teto mensal da mídia atingido: nada é publicado até o mês que vem.',
    );
    expect(
      (
        screen.getByRole('button', {
          name: 'Publicar 5 faixas',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it('says the ceiling was reached when the API refuses (429)', async () => {
    const { fixture, http } = await renderIt();
    await open(fixture);
    fireEvent.click(screen.getByRole('button', { name: 'Publicar 5 faixas' }));
    http
      .expectOne(PUBLISH)
      .flush(
        { error: { code: 'MEDIA_SPEND_CAP', message: 'cap' } },
        { status: 429, statusText: 'Too Many Requests' },
      );
    await fixture.whenStable();
    expect(screen.getByRole('status').textContent).toContain(
      'Teto mensal da mídia atingido: nada é publicado até o mês que vem.',
    );
  });

  it('with nothing to publish, offers no action and says all are in the collection', async () => {
    await renderIt(
      anOverview({
        collections: [aCollection({ toPublish: 0, published: 2 })],
      }),
    );
    expect(
      screen.queryByRole('button', {
        name: 'Publicar no acervo as faixas que já existem',
      }),
    ).toBeNull();
    expect(document.body.textContent).toContain(
      'Todas as faixas publicadas já estão no acervo.',
    );
    expect(document.body.textContent).toContain(
      'Hermetismo: 0 na fila · 2 publicadas · 0 falharam',
    );
  });

  it('Cancelar closes the choice and gives the focus back to the action', async () => {
    const { fixture } = await renderIt();
    await open(fixture);
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await fixture.whenStable();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(document.activeElement?.textContent?.trim()).toBe(
      'Publicar no acervo as faixas que já existem',
    );
  });

  it('a load error offers to try again', async () => {
    const result = await render(ExistingTracks, {
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    http.expectOne(URL).flush('x', { status: 500, statusText: 'Server Error' });
    await result.fixture.whenStable();
    expect(document.body.textContent).toContain(
      'Não consegui carregar as faixas do acervo.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    http.expectOne(URL).flush(anOverview());
  });
});
