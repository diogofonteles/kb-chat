import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { fireEvent, screen } from '@testing-library/angular';
import type { DraftTrack, MediaEdit, ProposalRun } from '@kb-chat/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEDIA_ELEMENT_FACTORY } from '@core/media/media-engine.js';
import { fakeMediaElement } from '../../../testing/fake-media-element.js';
import {
  aMediaItem,
  aTranscription,
  sessionAs,
} from '../../../testing/media-fixtures.js';
import { MEDIA_POLL_MS } from '../media-polling.js';
import { TrackEditorPage } from './track-editor-page.js';
import { SAVE_DELAY_MS } from './track-draft.js';

const ITEM = aMediaItem({
  durationMs: 60_000,
  transcription: aTranscription({
    status: 'done',
    confidence: 'normal',
    version: 1,
  }),
});
const BASE = `/api/v1/media/${ITEM.id}`;

const aTrack = (n: number, startMs: number, endMs: number): DraftTrack => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  runId: null,
  source: 'manual',
  edited: false,
  firstSegment: null,
  lastSegment: null,
  startMs,
  endMs,
  kind: 'qa',
  title: `Faixa ${n}`,
  askerVoice: null,
  answererVoice: null,
  askerSpeakerId: null,
  answererSpeakerId: null,
});

const anEdit = (overrides: Partial<MediaEdit> = {}): MediaEdit => ({
  preparation: null,
  mediaId: ITEM.id,
  version: 2,
  started: true,
  status: 'draft',
  step: 3,
  tracks: [aTrack(1, 0, 20_000), aTrack(2, 20_000, 40_000)],
  run: null,
  lastFailure: null,
  voices: [],
  approvedTracks: 0,
  transcriptChanged: false,
  ...overrides,
});

async function openPage(
  edit: MediaEdit | { error: number } = anEdit(),
  features: Parameters<typeof sessionAs>[0]['features'] = [
    'media',
    'media-edit',
  ],
) {
  const media = fakeMediaElement('audio');
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([
        { path: 'midia/:id/faixas', component: TrackEditorPage },
        { path: 'midia/:id', children: [] },
      ]),
      { provide: MEDIA_ELEMENT_FACTORY, useValue: () => media.element },
      { provide: MEDIA_POLL_MS, useValue: 5 },
      sessionAs({ features }),
    ],
  });
  const harness = await RouterTestingHarness.create(`/midia/${ITEM.id}/faixas`);
  const http = TestBed.inject(HttpTestingController);
  http.expectOne(BASE).flush(ITEM);
  const read = http.expectOne(`${BASE}/edit`);
  if ('error' in edit)
    read.flush(
      { error: { code: 'FORBIDDEN', message: 'No' } },
      { status: edit.error, statusText: 'Nope' },
    );
  else read.flush(edit);
  // The transcript, words, silences, waveform and speakers: the editor works without them.
  for (const pass of [1, 2, 3]) {
    await Promise.resolve();
    TestBed.tick();
    http
      .match((request) => pass > 0 && request.method === 'GET')
      .forEach((one) => one.flush({}, { status: 404, statusText: 'None' }));
  }
  await harness.fixture.whenStable();
  return { harness, http };
}

// A screen goes after this file's `afterEach`, and a save it sends on the way still journals.
beforeEach(() => localStorage.clear());

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

/** Lets the save delay pass, for real: the page runs on real timers here. */
const saveDelay = () =>
  new Promise((resolve) => setTimeout(resolve, SAVE_DELAY_MS + 20));

const RUN: ProposalRun = {
  id: '22222222-2222-4222-8222-222222222222',
  mediaId: ITEM.id,
  status: 'running',
  model: 'stub',
  windowsTotal: 2,
  windowsDone: 1,
  tracks: 2,
  estimateUsd: 0.01,
  spentUsd: 0,
  failure: null,
  createdAt: '2026-11-04T00:00:00.000Z',
  finishedAt: null,
};

const button = (name: string) =>
  screen.getByRole<HTMLButtonElement>('button', { name });

/** Deletes the selected track: the change every test here makes. */
async function deleteTrack(harness: RouterTestingHarness) {
  fireEvent.click(button('Mais ações da faixa'));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Apagar' }));
  await harness.fixture.whenStable();
}

/** Changes a title and leaves the field: a change that moves no time. */
async function renameSelected(harness: RouterTestingHarness) {
  const field = screen.getByRole<HTMLInputElement>('textbox', {
    name: 'Título',
  });
  field.value = `${field.value} novo`;
  fireEvent.blur(field);
  await harness.fixture.whenStable();
}

describe('TrackEditorPage (T20, KBC-066)', () => {
  it('explains a refusal instead of showing an empty editor', async () => {
    await openPage({ error: 403 });
    expect(
      await screen.findByText(
        'Você não tem permissão para editar esta gravação.',
      ),
    ).toBeTruthy();
  });

  it('opens on step 3 with the tracks and says undo started over (BR-6)', async () => {
    await openPage();
    expect(screen.getAllByText(/Passo 3 de 4/).length).toBeGreaterThan(0);
    expect(screen.getByText(/histórico de desfazer recomeçou/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '2 faixas' })).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Propor faixas com IA' }),
    ).toBeNull();
  });

  it('offers the AI only with `media-edit-ai` (KBC-067 AC-7)', async () => {
    await openPage(anEdit(), ['media', 'media-edit', 'media-edit-ai']);
    expect(
      screen.getByRole('button', { name: 'Propor faixas com IA' }),
    ).toBeTruthy();
  });

  it('shows the empty state and creates a track at the cursor', async () => {
    const { harness } = await openPage(
      anEdit({ tracks: [], started: false, version: 0 }),
    );
    expect(screen.getByText(/Nenhuma faixa ainda/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Nova faixa aqui' }));
    await harness.fixture.whenStable();
    expect(screen.getByRole('button', { name: '1 faixa' })).toBeTruthy();
    expect(screen.queryByText(/Nenhuma faixa ainda/)).toBeNull();
  });

  it('lists the problems, and approves nothing, with an untitled track (AC-11)', async () => {
    const { harness, http } = await openPage(
      anEdit({ tracks: [{ ...aTrack(1, 0, 20_000), title: null }] }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Aprovar faixas' }));
    await harness.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Faixa 1: Sem título',
    );
    http.expectNone(`${BASE}/edit/approve`);
  });

  describe('a draft that holds an overlap (KBC-094)', () => {
    const OVERLAPPING = anEdit({
      tracks: [aTrack(1, 0, 20_042), aTrack(2, 20_000, 40_000)],
    });
    const spied = () =>
      vi
        .spyOn(HTMLElement.prototype, 'scrollIntoView')
        .mockImplementation(() => undefined);

    it('answers the press where the person is: focus, scroll and the size', async () => {
      const scrolled = spied();
      const { harness, http } = await openPage(OVERLAPPING);
      fireEvent.click(button('Aprovar faixas'));
      await harness.fixture.whenStable();
      expect(screen.getByRole('alert').textContent).toContain(
        'Faixa 2: Sobreposta à anterior em 0,042 s',
      );
      expect(document.activeElement?.textContent).toContain('Faixa 2');
      expect(scrolled).toHaveBeenCalledWith({ block: 'center' });
      http.expectNone(`${BASE}/edit/approve`);
    });

    it('answers a second press too: the alert is said again', async () => {
      const scrolled = spied();
      const { harness } = await openPage(OVERLAPPING);
      fireEvent.click(button('Aprovar faixas'));
      await harness.fixture.whenStable();
      const first = screen.getByRole('alert');
      button('Aprovar faixas').focus();
      fireEvent.click(button('Aprovar faixas'));
      await harness.fixture.whenStable();
      expect(screen.getByRole('alert')).not.toBe(first);
      expect(document.activeElement?.textContent).toContain('Faixa 2');
      expect(scrolled).toHaveBeenCalledTimes(2);
    });

    it('closes it with one press, undoable, and saves', async () => {
      spied();
      const { harness, http } = await openPage(OVERLAPPING);
      fireEvent.click(button('Aprovar faixas'));
      await harness.fixture.whenStable();
      fireEvent.click(button('Encostar na faixa anterior'));
      await harness.fixture.whenStable();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByText(/Sobreposta/)).toBeNull();
      expect(document.activeElement?.textContent).toContain('Faixa 2');
      await saveDelay();
      const save = http.expectOne({ method: 'PUT', url: `${BASE}/edit` });
      expect(save.request.body.tracks[1]).toMatchObject({
        startMs: 20_042,
        endMs: 40_000,
      });
      save.flush({ version: 3 });
      await harness.fixture.whenStable();
      expect(button('Desfazer').disabled).toBe(false);
    });

    it('offers nothing a track could not take: the handles stay', async () => {
      spied();
      const { harness } = await openPage(
        anEdit({ tracks: [aTrack(1, 0, 36_000), aTrack(2, 20_000, 40_000)] }),
      );
      fireEvent.click(button('Aprovar faixas'));
      await harness.fixture.whenStable();
      expect(screen.getByRole('alert').textContent).toContain('16 s');
      expect(
        screen.queryByRole('button', { name: 'Encostar na faixa anterior' }),
      ).toBeNull();
    });

    it('names a refused save, offers no retry and sends it once', async () => {
      const { harness, http } = await openPage(OVERLAPPING);
      await renameSelected(harness);
      await saveDelay();
      http.expectOne({ method: 'PUT', url: `${BASE}/edit` }).flush(
        {
          error: {
            code: 'TRACKS_INVALID',
            message: 'no',
            details: {
              problems: [
                {
                  trackId: aTrack(2, 0, 0).id,
                  ordinal: 2,
                  problem: 'overlap',
                },
              ],
            },
          },
        },
        { status: 422, statusText: 'Unprocessable' },
      );
      await harness.fixture.whenStable();
      const alert = screen.getByRole('alert').textContent;
      expect(alert).toContain('Faixa 2: Sobreposta à anterior em 0,042 s');
      expect(alert).not.toContain('Não consegui salvar a última mudança');
      expect(
        screen.queryByRole('button', { name: 'Tentar de novo' }),
      ).toBeNull();
      expect(screen.getByText(/Não salvo: corrija a faixa 2/)).toBeTruthy();
      await renameSelected(harness);
      await saveDelay();
      http.expectNone({ method: 'PUT', url: `${BASE}/edit` });
    });
  });

  it('says on step 4 that nothing else is needed (KBC-095)', async () => {
    await openPage(anEdit({ status: 'approved', step: 4, approvedTracks: 2 }), [
      'media',
      'media-edit',
      'media-classify',
    ]);
    expect(
      screen.getByText(
        /Preparação concluída: você não precisa fazer mais nada/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/Os assuntos abaixo são salvos sozinhos/),
    ).toBeTruthy();
    expect(screen.getByTestId('step-text').textContent).toContain(
      'Passo 4 de 4: Concluído',
    );
    expect(screen.getByTestId('step-text').textContent).not.toContain(
      'Aprovar',
    );
    expect(screen.getByRole('link', { name: 'Ver no player' })).toBeTruthy();
    expect(button('Reabrir edição')).toBeTruthy();
  });

  it('speaks of no subjects on step 4 to who cannot classify (KBC-095)', async () => {
    await openPage(anEdit({ status: 'approved', step: 4, approvedTracks: 2 }));
    expect(screen.getByText(/Preparação concluída/)).toBeTruthy();
    expect(screen.queryByText(/assuntos/i)).toBeNull();
  });

  it('approves with the version, then shows the summary (AC-12)', async () => {
    const { harness, http } = await openPage();
    fireEvent.click(screen.getByRole('button', { name: 'Aprovar faixas' }));
    const approve = http.expectOne(`${BASE}/edit/approve`);
    expect(approve.request.headers.get('If-Match')).toBe('"2"');
    approve.flush({ version: 3, tracks: 2 });
    TestBed.tick();
    // The page reads again, and "Preparando faixas" reads for itself (KBC-068 FR-1).
    for (const read of http.match(`${BASE}/edit`))
      read.flush(anEdit({ status: 'approved', step: 4, approvedTracks: 2 }));
    await harness.fixture.whenStable();
    expect(
      screen.getByRole('heading', { name: '2 faixas aplicadas.' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ver no player' })).toBeTruthy();
  });

  it('approves once for two presses with a change waiting to save (BUG-5)', async () => {
    const { harness, http } = await openPage();
    await deleteTrack(harness);
    fireEvent.click(button('Aprovar faixas'));
    fireEvent.click(button('Aprovar faixas'));
    http
      .expectOne({ method: 'PUT', url: `${BASE}/edit` })
      .flush({ version: 3 });
    http.expectOne(`${BASE}/edit/approve`).flush({ version: 4, tracks: 1 });
    TestBed.tick();
    for (const read of http.match(`${BASE}/edit`))
      read.flush(anEdit({ status: 'approved', step: 4, approvedTracks: 1 }));
    await harness.fixture.whenStable();
    expect(
      screen.getByRole('heading', { name: '1 faixa aplicada.' }),
    ).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  describe('two presses that spend or apply (F-2)', () => {
    const ESTIMATE = {
      allowed: true,
      estimateUsd: 0.02,
      runCapUsd: 0.25,
      windows: 2,
      model: 'stub',
      refusal: null,
      month: { spentUsd: 1.5, capUsd: 10 },
    };
    const estimated = async () => {
      const opened = await openPage(anEdit(), [
        'media',
        'media-edit',
        'media-edit-ai',
      ]);
      fireEvent.click(button('Propor faixas com IA'));
      opened.http.expectOne(`${BASE}/edit/proposals`).flush(ESTIMATE);
      await opened.harness.fixture.whenStable();
      await deleteTrack(opened.harness);
      return opened;
    };

    it('turns off "Confirmar e propor" while an approval waits on its save', async () => {
      const { harness, http } = await estimated();
      expect(button('Confirmar e propor').disabled).toBe(false);
      fireEvent.click(button('Aprovar faixas'));
      await harness.fixture.whenStable();
      expect(button('Confirmar e propor').disabled).toBe(true);
      http
        .expectOne({ method: 'PUT', url: `${BASE}/edit` })
        .flush({}, { status: 500, statusText: 'No' });
      await harness.fixture.whenStable();
      expect(button('Confirmar e propor').disabled).toBe(false);
    });

    it('turns off "Aprovar faixas" while a run waits on its save', async () => {
      const { harness, http } = await estimated();
      expect(button('Aprovar faixas').disabled).toBe(false);
      fireEvent.click(button('Confirmar e propor'));
      await harness.fixture.whenStable();
      expect(button('Aprovar faixas').disabled).toBe(true);
      http
        .expectOne({ method: 'PUT', url: `${BASE}/edit` })
        .flush({}, { status: 500, statusText: 'No' });
      await harness.fixture.whenStable();
      expect(button('Aprovar faixas').disabled).toBe(false);
    });

    it('leaves "Confirmar e propor" ready for a press lost to an approval', async () => {
      const { harness, http } = await estimated();
      fireEvent.click(button('Aprovar faixas'));
      fireEvent.click(button('Confirmar e propor'));
      http
        .expectOne({ method: 'PUT', url: `${BASE}/edit` })
        .flush({}, { status: 500, statusText: 'No' });
      await harness.fixture.whenStable();
      http.expectNone(`${BASE}/edit/proposals`);
      expect(button('Confirmar e propor').disabled).toBe(false);
    });
  });

  it('reopens from the summary (BR-9)', async () => {
    const { harness, http } = await openPage(
      anEdit({ status: 'approved', step: 4, approvedTracks: 2 }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reabrir edição' }));
    http.expectOne(`${BASE}/edit/reopen`).flush({ version: 3 });
    TestBed.tick();
    http.expectOne(`${BASE}/edit`).flush(anEdit({ version: 3 }));
    await harness.fixture.whenStable();
    expect(screen.getAllByText(/Passo 3 de 4/).length).toBeGreaterThan(0);
  });

  it('says the transcript changed (BR-10)', async () => {
    await openPage(anEdit({ transcriptChanged: true }));
    expect(
      screen.getByText('Revise os limites: a transcrição mudou.'),
    ).toBeTruthy();
  });

  it('deletes without asking, and offers the undo (UP-07)', async () => {
    const { harness, http } = await openPage();
    fireEvent.click(
      screen.getByRole('button', { name: 'Mais ações da faixa' }),
    );
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Apagar' }));
    await harness.fixture.whenStable();
    expect(screen.getByText('Faixa 1 apagada')).toBeTruthy();
    expect(screen.getByRole('button', { name: '1 faixa' })).toBeTruthy();
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Desfazer' })[0] as HTMLElement,
    );
    await harness.fixture.whenStable();
    expect(screen.getByRole('button', { name: '2 faixas' })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, SAVE_DELAY_MS + 20));
    http.expectOne(`${BASE}/edit`).flush({ version: 3 });
  });

  it('undoes with Ctrl+Z, not while typing in a field', async () => {
    const { harness, http } = await openPage();
    fireEvent.click(
      screen.getByRole('button', { name: 'Mais ações da faixa' }),
    );
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Apagar' }));
    await harness.fixture.whenStable();
    const field = screen.getByRole('textbox', { name: 'Título' });
    fireEvent.keyDown(field, { key: 'z', ctrlKey: true });
    await harness.fixture.whenStable();
    expect(screen.getByRole('button', { name: '1 faixa' })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    await harness.fixture.whenStable();
    expect(screen.getByRole('button', { name: '2 faixas' })).toBeTruthy();
    fireEvent.keyDown(document.body, {
      key: 'z',
      ctrlKey: true,
      shiftKey: true,
    });
    await harness.fixture.whenStable();
    expect(screen.getByRole('button', { name: '1 faixa' })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, SAVE_DELAY_MS + 20));
    http.expectOne(`${BASE}/edit`).flush({ version: 3 });
  });

  it('watches a running proposal without handles or approval (KBC-067 FR-3)', async () => {
    const { http } = await openPage(anEdit({ run: RUN }));
    expect(screen.queryByRole('slider')).toBeNull();
    expect(button('Aprovar faixas').disabled).toBe(true);
    http.match(`${BASE}/edit`);
  });

  it('says why it is read-only, and comes back, without `media-edit-ai` (R-5)', async () => {
    const { harness, http } = await openPage(anEdit({ run: RUN }));
    expect(screen.getByText(/Uma análise com IA está propondo/)).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    http.match(`${BASE}/edit`).at(-1)?.error(new ProgressEvent('error'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    http
      .match(`${BASE}/edit`)
      .at(-1)
      ?.flush(anEdit({ version: 3 }));
    await harness.fixture.whenStable();
    expect(screen.queryByText(/Uma análise com IA está propondo/)).toBeNull();
    expect(screen.getAllByRole('slider').length).toBeGreaterThan(0);
  });

  it('does not repeat why to who sees the panel', async () => {
    const { http } = await openPage(anEdit({ run: RUN }), [
      'media',
      'media-edit',
      'media-edit-ai',
    ]);
    expect(screen.getByText(/Propondo… janela 1 de 2/)).toBeTruthy();
    expect(screen.queryByText(/Uma análise com IA está propondo/)).toBeNull();
    http.match(`${BASE}/edit`);
  });

  it('shows a failed run after a reload (KBC-067 FR-5)', async () => {
    await openPage(anEdit({ lastFailure: 'provider' }), [
      'media',
      'media-edit',
      'media-edit-ai',
    ]);
    expect(screen.getByText('Não foi possível propor.')).toBeTruthy();
  });

  it('takes away the undo of a delete with the next change (I-6)', async () => {
    const { harness, http } = await openPage();
    await deleteTrack(harness);
    expect(screen.getByText('Faixa 1 apagada')).toBeTruthy();
    fireEvent.click(button('Nova faixa aqui'));
    await harness.fixture.whenStable();
    expect(screen.queryByText('Faixa 1 apagada')).toBeNull();
    await saveDelay();
    http.expectOne(`${BASE}/edit`).flush({ version: 3 });
  });

  it('divides at the cursor; the second part is new and untitled', async () => {
    const { harness, http } = await openPage();
    fireEvent.click(button('Mais ações da faixa'));
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Dividir aqui' }),
    );
    await harness.fixture.whenStable();
    await saveDelay();
    const save = http.expectOne(`${BASE}/edit`);
    expect(save.request.body.tracks).toHaveLength(3);
    expect(save.request.body.tracks[2]).toMatchObject({
      source: 'manual',
      title: null,
      startMs: 5_000,
    });
    save.flush({ version: 3 });
  });

  describe('when a save does not go through', () => {
    const refuse = async (
      http: HttpTestingController,
      harness: RouterTestingHarness,
      answer: { status: number; details?: object },
    ) => {
      await saveDelay();
      const body = {
        error: {
          code: 'MEDIA_CONFLICT',
          message: 'no',
          details: answer.details,
        },
      };
      http
        .expectOne({ method: 'PUT', url: `${BASE}/edit` })
        .flush(body, { status: answer.status, statusText: 'No' });
      await harness.fixture.whenStable();
    };
    const copy = () =>
      screen.getByRole<HTMLTextAreaElement>('textbox', {
        name: 'Suas faixas, para copiar',
      });
    const conflictPage = async () => {
      const opened = await openPage();
      await deleteTrack(opened.harness);
      await refuse(opened.http, opened.harness, { status: 412 });
      opened.http
        .expectOne({ method: 'GET', url: `${BASE}/edit` })
        .flush(anEdit({ version: 5, tracks: [aTrack(3, 0, 10_000)] }));
      await opened.harness.fixture.whenStable();
      return opened;
    };

    it('keeps everything a person can change to copy (FR-10, I-8)', async () => {
      const edited: DraftTrack = {
        ...aTrack(2, 20_000, 40_000),
        kind: 'talk',
        askerVoice: 2,
        answererSpeakerId: '33333333-3333-4333-8333-333333333333',
      };
      const { harness, http } = await openPage(
        anEdit({ tracks: [aTrack(1, 0, 20_000), edited] }),
      );
      fireEvent.click(button('Mais ações da faixa'));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Apagar' }));
      await harness.fixture.whenStable();
      await refuse(http, harness, { status: 412 });
      http
        .expectOne({ method: 'GET', url: `${BASE}/edit` })
        .flush(anEdit({ version: 5, tracks: [] }));
      await harness.fixture.whenStable();
      expect(copy().value).toContain('1. 0:20,0 – 0:40,0 Faixa 2');
      expect(copy().value).toContain('Exposição');
      expect(copy().value).toContain('Quem pergunta: 2');
      expect(copy().value).toContain('Quem responde: ');
    });

    it('says a 409 of a proposal, with the copy, and no reload of the page (R-6)', async () => {
      const { harness, http } = await openPage();
      await deleteTrack(harness);
      await refuse(http, harness, {
        status: 409,
        details: { reason: 'proposal-running' },
      });
      expect(screen.getByRole('alert').textContent).toContain(
        'Uma análise com IA começou nesta gravação',
      );
      expect(copy().value).toContain('Faixa 2');
      expect(button('Recarregar')).toBeTruthy();
    });

    it('says a 409 of an approval with the copy (BUG-3)', async () => {
      const { harness, http } = await openPage();
      await deleteTrack(harness);
      await refuse(http, harness, {
        status: 409,
        details: { reason: 'approved' },
      });
      expect(screen.getByRole('alert').textContent).toContain(
        'Esta edição foi aprovada; recarregue para ver.',
      );
      expect(copy()).toBeTruthy();
    });

    it('offers to try again after a 500, not to reload (R-6)', async () => {
      const { harness, http } = await openPage();
      await deleteTrack(harness);
      await refuse(http, harness, { status: 500 });
      expect(screen.getByRole('alert').textContent).not.toMatch(/Recarregue/);
      expect(copy().value).toContain('Faixa 2');
      fireEvent.click(button('Tentar de novo'));
      http
        .expectOne({ method: 'PUT', url: `${BASE}/edit` })
        .flush({ version: 3 });
      await harness.fixture.whenStable();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getAllByText('Rascunho salvo').length).toBeGreaterThan(0);
    });

    it('approves nothing on a 500, and says so (BUG-2)', async () => {
      const { harness, http } = await openPage();
      await deleteTrack(harness);
      fireEvent.click(button('Aprovar faixas'));
      await harness.fixture.whenStable();
      http
        .expectOne({ method: 'PUT', url: `${BASE}/edit` })
        .flush({}, { status: 500, statusText: 'No' });
      await harness.fixture.whenStable();
      http.expectNone(`${BASE}/edit/approve`);
      expect(
        screen.getByText(
          'Nada foi feito: não consegui salvar a última mudança.',
        ),
      ).toBeTruthy();
      expect(button('Aprovar faixas').disabled).toBe(false);
    });

    it('answers Aprovar in a conflict, and the button comes back (BUG-1)', async () => {
      const { harness, http } = await conflictPage();
      fireEvent.click(button('Aprovar faixas'));
      await harness.fixture.whenStable();
      http.expectNone(`${BASE}/edit/approve`);
      expect(screen.getByText(/Nada foi feito: esta edição tem/)).toBeTruthy();
      expect(button('Aprovar faixas').disabled).toBe(false);
    });

    it('turns off the AI in a conflict (R-3)', async () => {
      const { harness, http } = await openPage(anEdit(), [
        'media',
        'media-edit',
        'media-edit-ai',
      ]);
      await deleteTrack(harness);
      await refuse(http, harness, { status: 409 });
      expect(button('Propor faixas com IA').disabled).toBe(true);
    });

    it('has no handles in a conflict, and Recarregar brings the other draft', async () => {
      const { harness, http } = await conflictPage();
      expect(screen.queryByRole('slider')).toBeNull();
      fireEvent.click(button('Recarregar'));
      http
        .expectOne({ method: 'GET', url: `${BASE}/edit` })
        .flush(anEdit({ version: 5, tracks: [aTrack(3, 0, 10_000)] }));
      await harness.fixture.whenStable();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getAllByRole('slider').length).toBeGreaterThan(0);
      expect(button('1 faixa')).toBeTruthy();
    });

    it('keeps the copy when Recarregar fails', async () => {
      const { harness, http } = await conflictPage();
      fireEvent.click(button('Recarregar'));
      http
        .expectOne({ method: 'GET', url: `${BASE}/edit` })
        .flush({}, { status: 500, statusText: 'No' });
      await harness.fixture.whenStable();
      expect(copy().value).toContain('Faixa 2');
    });

    it('leaves in a conflict: this browser holds the tracks (UP-04)', async () => {
      const { harness } = await conflictPage();
      fireEvent.click(button('Sair e continuar depois'));
      await harness.fixture.whenStable();
      expect(TestBed.inject(Router).url).toBe(`/midia/${ITEM.id}`);
    });

    it('says why when the way out does not open, and keeps the changes (F-1)', async () => {
      const { harness, http } = await openPage();
      await deleteTrack(harness);
      await saveDelay();
      http
        .expectOne({ method: 'PUT', url: `${BASE}/edit` })
        .error(new ProgressEvent('error'));
      await harness.fixture.whenStable();
      vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockRejectedValue(
        new Error('Failed to fetch dynamically imported module'),
      );
      fireEvent.click(button('Sair e continuar depois'));
      http
        .expectOne({ method: 'PUT', url: `${BASE}/edit` })
        .error(new ProgressEvent('error'));
      await harness.fixture.whenStable();
      expect(TestBed.inject(Router).url).toContain('/faixas');
      expect(screen.getByText(/Não consegui abrir a página/)).toBeTruthy();
    });

    it('stays and says why when this browser cannot hold them (R-1)', async () => {
      const { harness, http } = await openPage();
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      await deleteTrack(harness);
      fireEvent.click(button('Sair e continuar depois'));
      http
        .expectOne({ method: 'PUT', url: `${BASE}/edit` })
        .flush({}, { status: 500, statusText: 'No' });
      await harness.fixture.whenStable();
      expect(TestBed.inject(Router).url).toContain('/faixas');
      expect(screen.getByText(/Copie suas faixas antes de sair/)).toBeTruthy();
    });

    it('tells the truth without a network, kept or not (R-2)', async () => {
      const { harness, http } = await openPage();
      await deleteTrack(harness);
      await saveDelay();
      http
        .expectOne({ method: 'PUT', url: `${BASE}/edit` })
        .error(new ProgressEvent('error'));
      await harness.fixture.whenStable();
      expect(screen.getByText(/ficam neste aparelho/)).toBeTruthy();
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      fireEvent.click(button('Mais ações da faixa'));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Apagar' }));
      window.dispatchEvent(new Event('online'));
      http
        .expectOne({ method: 'PUT', url: `${BASE}/edit` })
        .error(new ProgressEvent('error'));
      await harness.fixture.whenStable();
      expect(screen.getByText(/não feche esta página/)).toBeTruthy();
    });

    it('brings back what was not saved when opened again (BR-6)', async () => {
      localStorage.setItem(
        `kb-chat.track-draft..${ITEM.id}`,
        JSON.stringify({ version: 2, tracks: [aTrack(1, 0, 20_000)] }),
      );
      const { http } = await openPage();
      expect(screen.getByText(/Recuperei mudanças/)).toBeTruthy();
      expect(button('1 faixa')).toBeTruthy();
      http
        .expectOne({ method: 'PUT', url: `${BASE}/edit` })
        .flush({ version: 3 });
    });
  });
});
