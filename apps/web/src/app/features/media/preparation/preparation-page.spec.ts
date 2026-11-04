import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { screen } from '@testing-library/angular';
import type { MediaPreparation } from '@kb-chat/contracts';
import { aMediaItem, sessionAs } from '../../../testing/media-fixtures.js';
import {
  MEDIA_ID,
  aPreparation,
  aStage,
  aTrack,
  anOffer,
} from '../../../testing/preparation-fixtures.js';
import { PreparationPage } from './preparation-page.js';
import { PREPARATION_POLL_MS } from './preparation-watch.js';

const URL = `/api/v1/media/${MEDIA_ID}/preparation`;
const ITEM = `/api/v1/media/${MEDIA_ID}`;

function configure() {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([
        { path: 'midia/:id/preparar', component: PreparationPage },
        { path: 'midia/:id/faixas', children: [] },
        { path: 'midia/:id', children: [] },
      ]),
      { provide: PREPARATION_POLL_MS, useValue: 5 },
      sessionAs({ features: ['media', 'media-edit', 'media-edit-ai'] }),
    ],
  });
}

async function openFailing() {
  configure();
  const harness = await RouterTestingHarness.create(
    `/midia/${MEDIA_ID}/preparar`,
  );
  const http = TestBed.inject(HttpTestingController);
  await pause();
  http.match(ITEM).forEach((one) => one.flush(aMediaItem({ id: MEDIA_ID })));
  await failRead(harness, http);
  return { harness, http };
}

async function open(first: MediaPreparation, offer = anOffer()) {
  configure();
  const harness = await RouterTestingHarness.create(
    `/midia/${MEDIA_ID}/preparar`,
  );
  const http = TestBed.inject(HttpTestingController);
  await pause();
  http.match(ITEM).forEach((one) => one.flush(aMediaItem({ id: MEDIA_ID })));
  answer(http, first);
  await pause();
  flushOptions(http, offer);
  await harness.fixture.whenStable();
  return { harness, http };
}

/** The first read comes after a timer: nothing is stable while it is out. */
const pause = () => new Promise((resolve) => setTimeout(resolve, 2));

const flushOptions = (http: HttpTestingController, offer = anOffer()) =>
  http
    .match((request) =>
      request.url.startsWith('/api/v1/media/preparation-options'),
    )
    .forEach((one) => one.flush(offer));

const settle = async (harness: RouterTestingHarness) => {
  await harness.fixture.whenStable();
  await pause();
};

const answer = (http: HttpTestingController, body: MediaPreparation) =>
  http.match(URL).forEach((one) => one.flush(body));

const MEDIA_GONE = {
  status: 404,
  body: { error: { code: 'MEDIA_NOT_FOUND', message: 'Gone' } },
};
const BROKEN = {
  status: 500,
  body: { error: { code: 'INTERNAL', message: 'Boom' } },
};

/** Waits for the next read of the plan and refuses it. */
async function failRead(
  harness: RouterTestingHarness,
  http: HttpTestingController,
  { status, body } = BROKEN,
) {
  for (let tick = 0; tick < 40; tick++) {
    const reads = http.match(URL);
    if (reads.length > 0) {
      reads.forEach((one) => one.flush(body, { status, statusText: 'No' }));
      await settle(harness);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('no read came');
}

/** Waits for the next read of the plan and answers it. */
async function nextRead(
  harness: RouterTestingHarness,
  http: HttpTestingController,
  body: MediaPreparation,
) {
  for (let tick = 0; tick < 40; tick++) {
    const reads = http.match(URL);
    if (reads.length > 0) {
      reads.forEach((one) => one.flush(body));
      await settle(harness);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('no read came');
}

const RUNNING = aPreparation({
  stages: [
    aStage('upload', 'done'),
    aStage('convert', 'done'),
    aStage('transcribe', 'running', {
      percent: 35,
      cuts: { done: 14, total: 40 },
    }),
    aStage('speakers', 'waiting'),
    aStage('tracks', 'waiting'),
  ],
});

describe('PreparationPage (T20, step 2)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('says the step, with what is done and what is closed and why (AC-5)', async () => {
    await open(RUNNING);
    expect(screen.getByTestId('step-text').textContent).toContain(
      'Passo 2 de 4: Processar',
    );
    expect(
      screen.getByText('1 Enviar e escolher').closest('li')?.textContent,
    ).toContain('✓');
    expect(
      screen
        .getByText('2 Processar')
        .closest('li')
        ?.getAttribute('aria-current'),
    ).toBe('step');
    expect(screen.getByText('3 Validar faixas').closest('a')).toBeNull();
    expect(
      screen.getByText(
        'O próximo passo fica disponível quando o processamento terminar.',
      ),
    ).toBeTruthy();
    expect(TestBed.inject(Title).getTitle()).toBe(
      'Passo 2 de 4: Processar — Palestra de 1998',
    );
  });

  it('shows the percent, the cuts and who waits for whom (AC-6)', async () => {
    await open(RUNNING);
    const bar = screen.getByRole('progressbar', { name: 'Transcrição' });
    expect(bar.getAttribute('aria-valuenow')).toBe('35');
    expect(bar.getAttribute('aria-valuetext')).toBe(
      'Transcrição: 35 por cento',
    );
    expect(screen.getByText(/cortes 14 de 40/)).toBeTruthy();
    expect(screen.getByText('Esperando: Transcrição')).toBeTruthy();
  });

  it('says "Transcrevendo…" with no percent from an old transcriber (FR-3)', async () => {
    await open(
      aPreparation({
        stages: [aStage('transcribe', 'running')],
      }),
    );
    expect(screen.getByText('Transcrevendo…')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('refreshes while anything runs, and tracks arrive with who and status (AC-7)', async () => {
    const { harness, http } = await open(RUNNING);
    await nextRead(
      harness,
      http,
      aPreparation({
        stages: [
          aStage('tracks', 'running', {
            percent: 25,
            windows: { done: 1, total: 4 },
            reservedUsd: 0.02,
            spentUsd: 0.01,
          }),
        ],
        tracks: [aTrack(12)],
      }),
    );
    expect(screen.getByText('Pergunta 12')).toBeTruthy();
    expect(screen.getByText('12:00–13:00 · 1 min')).toBeTruthy();
    expect(
      screen.getByText(
        'Pergunta: Pergunta da plateia · Resposta: Mestre Gabriel',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Proposta pela IA')).toBeTruthy();
    expect(
      screen.getByText(/Reservado US\$\s0,02 · gasto US\$\s0,01/),
    ).toBeTruthy();
    expect(screen.getByText('Faixas: 1 até agora')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /Ouvir a faixa 1/ }),
    ).toBeTruthy();
  });

  it('stops reading once nothing runs (FR-5)', async () => {
    const { harness, http } = await open(
      aPreparation({ stages: [aStage('tracks', 'done')], next: 'validate' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await settle(harness);
    expect(http.match(URL)).toHaveLength(0);
  });

  it('says it is offline and keeps going (T20)', async () => {
    const { harness, http } = await open(RUNNING);
    for (let tick = 0; tick < 40; tick++) {
      const reads = http.match(URL);
      if (reads.length > 0) {
        reads.forEach((one) =>
          one.flush('', { status: 503, statusText: 'Down' }),
        );
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await settle(harness);
    expect(screen.getByText(/Sem conexão: o trabalho continua/)).toBeTruthy();
    await nextRead(harness, http, RUNNING);
    expect(screen.queryByText(/Sem conexão/)).toBeNull();
  });

  it('keeps watching after a read that failed, and the screen with it (FR-5)', async () => {
    const { harness, http } = await open(RUNNING);
    await failRead(harness, http);
    expect(screen.getByText(/Sem atualizar agora/)).toBeTruthy();
    expect(screen.getByRole('progressbar')).toBeTruthy();
    await nextRead(harness, http, RUNNING);
    expect(screen.queryByText(/Sem atualizar agora/)).toBeNull();
  });

  it('comes back from a first read that failed (FR-5)', async () => {
    const { harness, http } = await openFailing();
    expect(screen.getByRole('alert')).toBeTruthy();
    await nextRead(harness, http, RUNNING);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('progressbar')).toBeTruthy();
  });

  it('stops watching a recording that is gone', async () => {
    const { harness, http } = await open(RUNNING);
    await failRead(harness, http, MEDIA_GONE);
    await new Promise((resolve) => setTimeout(resolve, 20));
    http.expectNone(URL);
    expect(screen.getByRole('alert').textContent).toContain(
      'não está mais no acervo',
    );
  });

  it('says when a track cannot be played (UP-11)', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(
      new Error('refused'),
    );
    const { harness } = await open(
      aPreparation({ stages: [], tracks: [aTrack(1)] }),
    );
    screen.getByRole('button', { name: 'Ouvir a faixa 1' }).click();
    await settle(harness);
    expect(screen.getByRole('alert').textContent).toContain(
      'Não consegui tocar este trecho',
    );
  });

  it('offers "Validar faixas" and does not move by itself; the press goes to step 3 (AC-8)', async () => {
    const { harness, http } = await open(
      aPreparation({
        stages: [aStage('tracks', 'done')],
        tracks: [aTrack(1), aTrack(2)],
        voices: [
          {
            voice: 1,
            speakingMs: 60_000,
            name: 'Mestre Gabriel',
            audience: false,
          },
          { voice: 2, speakingMs: 6_000, name: null, audience: true },
        ],
        next: 'validate',
      }),
    );
    expect(
      screen.getByText('Processamento concluído: 2 faixas propostas, 2 vozes.'),
    ).toBeTruthy();
    expect(screen.queryByText(/O próximo passo fica disponível/)).toBeNull();
    expect(TestBed.inject(Router).url).toContain('/preparar');
    screen.getByRole('button', { name: 'Validar faixas' }).click();
    http.expectOne(`${URL}/advance`).flush(aPreparation({ step: 3 }));
    await settle(harness);
    expect(TestBed.inject(Router).url).toBe(`/midia/${MEDIA_ID}/faixas`);
  });

  it('with step 3 not asked for, "Concluir" ends at the audio (AC-9)', async () => {
    const { harness, http } = await open(
      aPreparation({
        skipped: true,
        stages: [aStage('speakers', 'done')],
        next: 'conclude',
      }),
    );
    expect(screen.getByText('3 Validar faixas — não pedido')).toBeTruthy();
    expect(screen.getByText('4 Concluir')).toBeTruthy();
    screen.getByRole('button', { name: 'Concluir' }).click();
    http
      .expectOne(`${URL}/advance`)
      .flush(aPreparation({ step: 4, finished: true }));
    await settle(harness);
    expect(TestBed.inject(Router).url).toBe(`/midia/${MEDIA_ID}`);
  });

  it('keeps what was done on a failure, and offers both ways out (AC-11)', async () => {
    const { harness, http } = await open(
      aPreparation({
        stages: [
          aStage('transcribe', 'done'),
          aStage('speakers', 'done'),
          aStage('tracks', 'failed', {
            failure: 'provider',
            canRetry: true,
            estimateUsd: 0.02,
          }),
        ],
        tracks: [aTrack(1)],
        canSwitchToManual: true,
      }),
    );
    expect(
      screen.getByText('Falhou: o provedor de IA não respondeu.'),
    ).toBeTruthy();
    expect(screen.getByText('Pergunta 1')).toBeTruthy();
    expect(
      screen.getByText(/Tentar de novo custa cerca de US\$\s0,02/),
    ).toBeTruthy();
    screen.getByRole('button', { name: 'Tentar de novo' }).click();
    http.expectOne(`${URL}/steps/tracks/retry`).flush(RUNNING);
    await settle(harness);
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByText('Faixas com IA').closest('li'),
    );
  });

  it('says what a failed proposal left and that a retry pays only for the rest (AC-11)', async () => {
    await open(
      aPreparation({
        stages: [
          aStage('tracks', 'failed', {
            failure: 'provider',
            canRetry: true,
            estimateUsd: 0.02,
            windows: { done: 1, total: 3 },
            spentUsd: 0.0012,
          }),
        ],
        tracks: [aTrack(1)],
      }),
    );
    expect(
      screen.getByText(
        /1 de 3 janelas prontas, por US\$\s0,0012\. Tentar de novo refaz só as que faltam\./,
      ),
    ).toBeTruthy();
  });

  it('offers no retry in words past the cap: only what stands (BUG-9)', async () => {
    await open(
      aPreparation({
        stages: [
          aStage('tracks', 'failed', {
            failure: 'run-cap',
            canRetry: false,
            estimateUsd: 0.02,
            windows: { done: 2, total: 3 },
            spentUsd: 0.4,
          }),
        ],
        canSwitchToManual: true,
      }),
    );
    expect(
      screen.getByText(/2 de 3 janelas prontas, por US\$\s0,40\.$/),
    ).toBeTruthy();
    expect(screen.getByText(/passaria do teto por gravação/)).toBeTruthy();
    expect(screen.queryByText(/não rodaram/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
  });

  it('says what attempts that finished no window cost (BUG-8)', async () => {
    await open(
      aPreparation({
        stages: [
          aStage('tracks', 'failed', {
            failure: 'invalid-output',
            canRetry: true,
            estimateUsd: 0.02,
            windows: { done: 0, total: 3 },
            spentUsd: 0.12,
          }),
        ],
      }),
    );
    expect(
      screen.getByText(
        /Nenhuma janela ficou pronta\. Gasto até aqui: US\$\s0,12\./,
      ),
    ).toBeTruthy();
  });

  it('"Marcar as faixas eu mesmo" switches and goes to step 3 (AC-11)', async () => {
    const { harness, http } = await open(
      aPreparation({
        stages: [aStage('tracks', 'failed', { failure: 'monthly-cap' })],
        canSwitchToManual: true,
      }),
    );
    expect(
      screen.getByText(/O limite mensal da mídia foi atingido/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
    screen.getByRole('button', { name: 'Marcar as faixas eu mesmo' }).click();
    http
      .expectOne((request) => request.method === 'PATCH')
      .flush(aPreparation({ next: 'validate' }));
    await settle(harness);
    http.expectOne(`${URL}/advance`).flush(aPreparation({ step: 3 }));
    await settle(harness);
    expect(TestBed.inject(Router).url).toBe(`/midia/${MEDIA_ID}/faixas`);
  });

  it('shows what is blocked and why (BR-6)', async () => {
    await open(
      aPreparation({
        stages: [
          aStage('transcribe', 'failed', { failure: 'work', canRetry: true }),
          aStage('speakers', 'blocked', { blockedBy: 'transcribe' }),
        ],
      }),
    );
    expect(
      screen.getByText('Esperando: Transcrição não terminou'),
    ).toBeTruthy();
  });

  it('says the queue and the transcriber that is off', async () => {
    await open(
      aPreparation({
        stages: [aStage('transcribe', 'queued', { ahead: 2 })],
        transcriber: 'off',
        transcriberOffSince: '2026-11-02T22:10:00.000Z',
      }),
    );
    expect(screen.getByText('Na fila: 2 trabalhos antes deste')).toBeTruthy();
    expect(screen.getByText(/Aguardando o transcritor/)).toBeTruthy();
  });

  it('suggests the author for the voice that speaks most, naming nobody before a press', async () => {
    const { harness, http } = await open(
      aPreparation({
        stages: [aStage('speakers', 'done')],
        separation: 1,
        voices: [
          { voice: 1, speakingMs: 2_460_000, name: null, audience: false },
          { voice: 2, speakingMs: 360_000, name: null, audience: false },
        ],
      }),
    );
    expect(screen.getByText('Vozes achadas: 2')).toBeTruthy();
    expect(screen.getByText(/é o autor da gravação/)).toBeTruthy();
    screen.getByRole('button', { name: 'Aceitar' }).click();
    http.expectOne('/api/v1/topics/hermetismo/speakers').flush({
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Mestre Gabriel',
      authorSlug: null,
      main: false,
    });
    await settle(harness);
    const named = http.expectOne(`${ITEM}/voices/1`);
    expect(named.request.body).toMatchObject({
      version: 1,
      speakerId: '33333333-3333-4333-8333-333333333333',
    });
  });

  it('reads as forbidden without the permission (T20)', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([
          { path: 'midia/:id/preparar', component: PreparationPage },
        ]),
        sessionAs({ features: ['media'] }),
      ],
    });
    const harness = await RouterTestingHarness.create(
      `/midia/${MEDIA_ID}/preparar`,
    );
    await pause();
    const http = TestBed.inject(HttpTestingController);
    http.match(ITEM).forEach((one) => one.flush(aMediaItem({ id: MEDIA_ID })));
    http
      .match(URL)
      .forEach((one) =>
        one.flush(
          { error: { code: 'FORBIDDEN', message: 'no' } },
          { status: 403, statusText: 'Forbidden' },
        ),
      );
    await settle(harness);
    expect(
      screen.getByText('Você não tem permissão para editar esta gravação.'),
    ).toBeTruthy();
  });
});

describe('PreparationPage (T20, step 1 of an audio sent)', () => {
  const NO_PLAN = aPreparation({ step: 1, plan: null, stages: [] });

  it('offers what is missing and starts the plan (AC-16)', async () => {
    const { harness, http } = await open(NO_PLAN);
    expect(screen.getByTestId('step-text').textContent).toContain(
      'Passo 1 de 4',
    );
    screen.getByRole('button', { name: 'Preparar' }).click();
    const started = http.expectOne((request) => request.method === 'POST');
    expect(started.request.url).toBe(URL);
    expect(started.request.body.plan).toMatchObject({ transcribe: true });
    started.flush(RUNNING);
    await settle(harness);
    expect(screen.getByTestId('step-text').textContent).toContain(
      'Passo 2 de 4',
    );
  });

  it('says so when nothing is left', async () => {
    const options = anOffer().options;
    const done = { done: true, refusal: null, minutes: null };
    await open(
      NO_PLAN,
      anOffer({
        options: {
          ...options,
          transcribe: done,
          speakers: done,
          manual: done,
          ai: done,
        },
      }),
    );
    expect(screen.getByText(/já está transcrito/)).toBeTruthy();
  });
});
