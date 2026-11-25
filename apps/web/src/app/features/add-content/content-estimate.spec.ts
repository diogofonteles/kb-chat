import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render, screen } from '@testing-library/angular';
import {
  ContentCostsStore,
  NO_CONTENT,
  type ContentCounts,
} from './content-costs-store.js';
import { ContentEstimate } from './content-estimate.js';

const COSTS = {
  document: { usd: 0.01, seconds: 30, samples: 12 },
  image: { usd: 0.02, seconds: 30, samples: 0 },
  page: { usd: 0.03, seconds: 30, samples: 5 },
  recording: { usd: 0, seconds: 0, samples: 0 },
};

async function renderWith(
  counts: Partial<ContentCounts>,
  costs: object = COSTS,
) {
  const view = await render(ContentEstimate, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      ContentCostsStore,
    ],
    inputs: { counts: { ...NO_CONTENT, ...counts } },
  });
  const http = TestBed.inject(HttpTestingController);
  http.expectOne('/api/v1/document-uploads/costs').flush(costs);
  await view.fixture.whenStable();
  return view;
}

const value = (label: string): string =>
  screen.getByText(label).nextElementSibling?.textContent?.trim() ?? '';

describe('ContentEstimate (KBC-186)', () => {
  it('says each kind, the credits of the pages, the total and the time on the Mac', async () => {
    const counts = { ...NO_CONTENT, document: 4, page: 2, image: 1 };
    await renderWith(counts);
    expect(value('4 documentos')).toMatch(/^até US\$ 0[.,]04$/);
    expect(value('2 páginas da web')).toMatch(
      /^até US\$ 0[.,]06 \+ 2 créditos do Firecrawl$/,
    );
    expect(value('1 imagem')).toMatch(/^até US\$ 0[.,]02$/);
    expect(value('Total estimado')).toMatch(
      /^até US\$ 0[.,]12 · cerca de 4 min no Mac$/,
    );
    expect(
      screen.getByText('Com base nas últimas 17 inclusões daqui.'),
    ).toBeTruthy();
    expect(TestBed.inject(ContentCostsStore).usd(counts)).toBeCloseTo(0.12);
  });

  it('a recording is transcribed at no cost, and says how long it takes', async () => {
    await renderWith({ recording: 1 });
    expect(value('1 áudio ou vídeo')).toBe('sem custo');
    expect(value('Total estimado')).toBe('sem custo');
    expect(
      screen.getByText(/transcrição é feita no Mac, sem custo/),
    ).toBeTruthy();
    expect(screen.getByText(/primeiras medições/)).toBeTruthy();
  });

  it('a list costs nothing to read: what is chosen comes later', async () => {
    await renderWith({ list: 2 });
    expect(value('2 canais ou playlists')).toBe(
      'ler não custa; você escolhe depois',
    );
  });

  it('says hours, and less than a cent', async () => {
    await renderWith(
      { document: 1, page: 200 },
      {
        ...COSTS,
        document: { usd: 0.0004, seconds: 1, samples: 5 },
        page: { usd: 0.001, seconds: 36, samples: 5 },
      },
    );
    expect(value('1 documento')).toBe('menos de US$ 0,01');
    expect(value('Total estimado')).toContain('cerca de 2 h 1 min no Mac');
  });

  it('without an answer it goes by the first measurements', async () => {
    const view = await render(ContentEstimate, {
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        ContentCostsStore,
      ],
      inputs: { counts: { ...NO_CONTENT, document: 10 } },
    });
    TestBed.inject(HttpTestingController)
      .expectOne('/api/v1/document-uploads/costs')
      .flush(null, { status: 500, statusText: 'x' });
    await view.fixture.whenStable();
    expect(value('10 documentos')).toMatch(/^até US\$ 0[.,]03$/);
    expect(screen.getByText(/primeiras medições/)).toBeTruthy();
  });
});
