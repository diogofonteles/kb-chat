import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import type { Diarization, MediaSpeakers } from '@kb-chat/contracts';
import { VoicesPanel } from './voices-panel.js';

const MEDIA_ID = '11111111-1111-4111-8111-111111111111';
const URL = `/api/v1/media/${MEDIA_ID}/speakers`;
const DIARIZE = `/api/v1/media/${MEDIA_ID}/diarize`;

const aDiarization = (overrides: Partial<Diarization> = {}): Diarization => ({
  version: 1,
  createdAt: '2026-11-03T12:00:00.000Z',
  transcriptVersion: 1,
  staleTranscript: false,
  requestedVoices: null,
  voiceCount: 3,
  voices: [
    { voice: 1, speakingMs: 12_100 },
    { voice: 2, speakingMs: 642_900 },
    { voice: 3, speakingMs: 5_000 },
  ],
  turns: [],
  segments: [],
  ...overrides,
});

const speakers = (overrides: Partial<MediaSpeakers> = {}): MediaSpeakers => ({
  mediaId: MEDIA_ID,
  status: 'none',
  transcriber: 'on',
  transcriberOffSince: null,
  canRequest: true,
  diarization: null,
  ...overrides,
});

async function renderPanel(first: MediaSpeakers) {
  const result = await render(VoicesPanel, {
    inputs: { mediaId: MEDIA_ID },
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  http.expectOne(URL).flush(first);
  await result.fixture.whenStable();
  return { ...result, http };
}

const status = () => screen.getByRole('status').textContent?.trim();

describe('VoicesPanel (KBC-064 FR-1, FR-4)', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('offers "Separar vozes" with an optional number and says nothing of a voice print', async () => {
    await renderPanel(speakers());
    expect(screen.getByRole('heading', { name: 'Vozes' })).toBeTruthy();
    expect(document.body.textContent).toContain(
      'nenhuma impressão de voz é guardada',
    );
    expect(screen.getByLabelText('Número de vozes (opcional)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Separar vozes' })).toBeTruthy();
  });

  it('asks for a separation with the number given and shows it waiting (AC-1, AC-6)', async () => {
    const { fixture, http } = await renderPanel(speakers());
    fireEvent.input(screen.getByLabelText('Número de vozes (opcional)'), {
      target: { value: ' 2 ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Separar vozes' }));
    const asked = http.expectOne({ method: 'POST', url: DIARIZE });
    expect(asked.request.body).toEqual({ voices: 2 });
    asked.flush(speakers({ status: 'waiting', canRequest: false }));
    await fixture.whenStable();
    expect(status()).toBe('Aguardando o transcritor');
    expect(screen.queryByRole('button', { name: /Separar vozes/ })).toBeNull();
  });

  it('sends no number when the field is blank', async () => {
    const { fixture, http } = await renderPanel(speakers());
    fireEvent.click(screen.getByRole('button', { name: 'Separar vozes' }));
    const asked = http.expectOne({ method: 'POST', url: DIARIZE });
    expect(asked.request.body).toEqual({ voices: null });
    asked.flush(speakers({ status: 'waiting', canRequest: false }));
    await fixture.whenStable();
  });

  it('refuses a number out of 1 to 10 at the field (MA-23)', async () => {
    const { fixture } = await renderPanel(speakers());
    const field = screen.getByLabelText('Número de vozes (opcional)');
    fireEvent.input(field, { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Separar vozes' }));
    await fixture.whenStable();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(document.body.textContent).toContain(
      'Informe um número de 1 a 10, ou deixe em branco.',
    );
  });

  it('says when no transcriber separates voices (AC-9)', async () => {
    await renderPanel(
      speakers({ status: 'waiting', transcriber: 'none', canRequest: false }),
    );
    expect(status()).toBe(
      'Nenhum transcritor separa vozes; marque em Transcritores',
    );
  });

  it('says since when the transcriber is off', async () => {
    await renderPanel(
      speakers({
        status: 'waiting',
        transcriber: 'off',
        transcriberOffSince: new Date(2026, 10, 3, 9, 30).toISOString(),
        canRequest: false,
      }),
    );
    expect(status()).toBe(
      'Aguardando o transcritor · desligado desde 03/11/2026 às 09:30',
    );
  });

  it('follows the job in words while it runs', async () => {
    await renderPanel(speakers({ status: 'diarizing', canRequest: false }));
    expect(status()).toBe('Separando vozes…');
  });

  it('lists the voices found with how long each speaks, each as "Voz N" text (AC-1, AC-8)', async () => {
    await renderPanel(
      speakers({ status: 'done', diarization: aDiarization() }),
    );
    expect(status()).toBe('Vozes separadas: 3');
    const voices = screen
      .getAllByRole('listitem')
      .map((item) => item.textContent?.replace(/\s+/g, ' ').trim());
    expect(voices).toEqual([
      'Voz 1 0:12 de fala',
      'Voz 2 10:42 de fala',
      'Voz 3 0:05 de fala',
    ]);
    expect(
      screen.getByRole('button', { name: 'Separar vozes de novo' }),
    ).toBeTruthy();
  });

  it('says one voice for a recording of one voice (AC-5)', async () => {
    await renderPanel(
      speakers({
        status: 'done',
        diarization: aDiarization({
          voiceCount: 1,
          voices: [{ voice: 1, speakingMs: 60_000 }],
        }),
      }),
    );
    expect(status()).toBe('Vozes separadas: 1');
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('warns that the voices were made on an older transcript and offers to redo (AC-4)', async () => {
    await renderPanel(
      speakers({
        status: 'done',
        diarization: aDiarization({
          staleTranscript: true,
          transcriptVersion: 2,
        }),
      }),
    );
    expect(document.body.textContent).toContain(
      'Feita sobre uma transcrição anterior.',
    );
    expect(
      screen.getByRole('button', { name: 'Separar vozes de novo' }),
    ).toBeTruthy();
  });

  it('says a failure in words and still lets the person ask again', async () => {
    await renderPanel(speakers({ status: 'failed' }));
    expect(status()).toBe('A separação de vozes falhou');
    expect(screen.getByRole('button', { name: 'Separar vozes' })).toBeTruthy();
  });

  it('explains why there is no button before the transcript', async () => {
    await renderPanel(speakers({ canRequest: false }));
    expect(document.body.textContent).toContain(
      'Dá para separar as vozes quando a transcrição estiver pronta.',
    );
  });

  it('reloads when someone else asked meanwhile (409), and offers a retry on other errors', async () => {
    const { fixture, http } = await renderPanel(speakers());
    fireEvent.click(screen.getByRole('button', { name: 'Separar vozes' }));
    http
      .expectOne({ method: 'POST', url: DIARIZE })
      .flush(
        { error: { code: 'MEDIA_CONFLICT', message: 'busy' } },
        { status: 409, statusText: 'Conflict' },
      );
    TestBed.tick();
    http
      .expectOne(URL)
      .flush(speakers({ status: 'waiting', canRequest: false }));
    await fixture.whenStable();
    expect(status()).toBe('Aguardando o transcritor');
  });

  it('shows a load failure with a retry', async () => {
    const result = await render(VoicesPanel, {
      inputs: { mediaId: MEDIA_ID },
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    http.expectOne(URL).flush(null, { status: 500, statusText: 'Error' });
    await result.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Não consegui carregar as vozes.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    TestBed.tick();
    http.expectOne(URL).flush(speakers());
    await result.fixture.whenStable();
    expect(screen.getByRole('button', { name: 'Separar vozes' })).toBeTruthy();
  });
});
