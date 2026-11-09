import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render, screen } from '@testing-library/angular';
import type {
  TrackDocumentsCollection,
  TrackDocumentsOverview,
  TranscriberStatusOverview,
} from '@kb-chat/contracts';
import { PendingTranscriptions } from './pending-transcriptions.js';

const DOCS = '/api/v1/media/track-documents';
const PUBLISH = '/api/v1/media/track-documents/publish';
const STATUS = '/api/v1/media/transcribers/status';

const aCollection = (
  over: Partial<TrackDocumentsCollection> = {},
): TrackDocumentsCollection => ({
  topic: 'udv',
  title: 'UDV',
  tracks: 2,
  toPublish: 2,
  queued: 0,
  published: 0,
  failed: 0,
  ...over,
});

const docs = (
  collections: TrackDocumentsCollection[],
  over: Partial<TrackDocumentsOverview> = {},
): TrackDocumentsOverview => ({
  usdPerTrack: 0.001,
  remainingUsd: 9.5,
  collections,
  ...over,
});

const STATUS_BODY: TranscriberStatusOverview = {
  items: [],
  kbQueue: { waiting: 0 },
  start: {
    label: 'br.com.nova-alexandria.transcriber',
    installCommand: 'uv run …',
    startCommand: 'launchctl kickstart …',
    canStartHere: false,
  },
};

/** Answers the next request to `url`, once the resource has sent it. */
async function answer(
  fixture: { detectChanges(): void },
  http: HttpTestingController,
  { url, body }: { url: string; body: object },
): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    fixture.detectChanges();
    TestBed.tick();
    await Promise.resolve();
    const [request] = http.match(url);
    if (request) return request.flush(body);
  }
  throw new Error(`no request to ${url}`);
}

/** The chip appears with the counts and asks for the transcriber's status then. */
async function flushStatus(
  fixture: { detectChanges(): void; whenStable(): Promise<unknown> },
  http: HttpTestingController,
): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    fixture.detectChanges();
    TestBed.tick();
    await Promise.resolve();
    const asked = http.match(STATUS);
    for (const request of asked) request.flush(STATUS_BODY);
  }
  await fixture.whenStable();
}

async function renderIt(overview: TrackDocumentsOverview, topic = 'udv') {
  const result = await render(PendingTranscriptions, {
    inputs: { topic },
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  http.expectOne(DOCS).flush(overview);
  await flushStatus(result.fixture, http);
  return { ...result, http };
}

describe('PendingTranscriptions (KBC-114 AC-9)', () => {
  it('counts the collection and its sub-collections, with the cost and the transcriber chip', async () => {
    await renderIt(
      docs([
        aCollection(),
        aCollection({ topic: 'udv/palavra-do-mestre', toPublish: 1 }),
        aCollection({ topic: 'hermetismo', toPublish: 9 }),
      ]),
    );
    expect(
      screen.getByText('3 transcrições ainda não são documentos deste acervo'),
    ).toBeTruthy();
    expect(screen.getByText(/Custo estimado do kb ≈ US\$ 0,003/)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Nenhum transcritor pareado' }),
    ).toBeTruthy();
  });

  it('publishes them once, even on a double click, and says they are queued', async () => {
    const { http, fixture } = await renderIt(
      docs([aCollection(), aCollection({ topic: 'udv/hinos', toPublish: 1 })]),
    );
    const button = screen.getByRole('button', { name: 'Publicar no acervo' });
    button.click();
    button.click();
    const sent = http.match(PUBLISH);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.request.body).toEqual({ topics: ['udv', 'udv/hinos'] });
    sent[0]?.flush({ queued: 3, skipped: 0 });
    await answer(fixture, http, {
      url: DOCS,
      body: docs([aCollection({ toPublish: 0, queued: 3 })]),
    });
    await flushStatus(fixture, http);
    expect(screen.getByRole('status').textContent).toContain(
      'Publicação pedida',
    );
    expect(screen.getByText('3 transcrições na fila para o Mac.')).toBeTruthy();
  });

  it('says one transcription in the singular', async () => {
    await renderIt(docs([aCollection({ toPublish: 1 })]));
    expect(
      screen.getByText('1 transcrição ainda não é documento deste acervo'),
    ).toBeTruthy();
  });

  it('shows nothing when every transcription is a document', async () => {
    await renderIt(docs([aCollection({ toPublish: 0, published: 2 })]));
    expect(
      screen.queryByRole('button', { name: 'Publicar no acervo' }),
    ).toBeNull();
    expect(screen.queryByText(/transcriç/)).toBeNull();
  });

  it('keeps "Publicar" off with the media ceiling spent, and says why', async () => {
    await renderIt(docs([aCollection()], { remainingUsd: 0 }));
    const button = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Publicar no acervo',
    });
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/Teto mensal da mídia atingido/)).toBeTruthy();
  });
});
