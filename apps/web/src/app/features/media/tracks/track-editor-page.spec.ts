import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { fireEvent, screen } from '@testing-library/angular';
import type { DraftTrack, MediaEdit } from '@kb-chat/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MEDIA_ELEMENT_FACTORY } from '@core/media/media-engine.js';
import { fakeMediaElement } from '../../../testing/fake-media-element.js';
import {
  aMediaItem,
  aTranscription,
  sessionAs,
} from '../../../testing/media-fixtures.js';
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
  mediaId: ITEM.id,
  version: 2,
  started: true,
  status: 'draft',
  step: 3,
  tracks: [aTrack(1, 0, 20_000), aTrack(2, 20_000, 40_000)],
  run: null,
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
      .match(() => pass > 0)
      .forEach((one) => one.flush({}, { status: 404, statusText: 'None' }));
  }
  await harness.fixture.whenStable();
  return { harness, http };
}

afterEach(() => {
  vi.useRealTimers();
});

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
    expect(screen.getByRole('tab', { name: '2 faixas' })).toBeTruthy();
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
    expect(screen.getByRole('tab', { name: '1 faixa' })).toBeTruthy();
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

  it('approves with the version, then shows the summary (AC-12)', async () => {
    const { harness, http } = await openPage();
    fireEvent.click(screen.getByRole('button', { name: 'Aprovar faixas' }));
    const approve = http.expectOne(`${BASE}/edit/approve`);
    expect(approve.request.headers.get('If-Match')).toBe('"2"');
    approve.flush({ version: 3, tracks: 2 });
    TestBed.tick();
    http
      .expectOne(`${BASE}/edit`)
      .flush(anEdit({ status: 'approved', step: 4, approvedTracks: 2 }));
    await harness.fixture.whenStable();
    expect(
      screen.getByRole('heading', { name: '2 faixas aplicadas.' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ver no player' })).toBeTruthy();
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
    expect(screen.getByRole('tab', { name: '1 faixa' })).toBeTruthy();
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Desfazer' })[0] as HTMLElement,
    );
    await harness.fixture.whenStable();
    expect(screen.getByRole('tab', { name: '2 faixas' })).toBeTruthy();
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
    expect(screen.getByRole('tab', { name: '1 faixa' })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    await harness.fixture.whenStable();
    expect(screen.getByRole('tab', { name: '2 faixas' })).toBeTruthy();
    fireEvent.keyDown(document.body, {
      key: 'z',
      ctrlKey: true,
      shiftKey: true,
    });
    await harness.fixture.whenStable();
    expect(screen.getByRole('tab', { name: '1 faixa' })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, SAVE_DELAY_MS + 20));
    http.expectOne(`${BASE}/edit`).flush({ version: 3 });
  });

  it('watches a running proposal without handles or approval (KBC-067 FR-3)', async () => {
    await openPage(
      anEdit({
        run: {
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
        },
      }),
    );
    expect(screen.queryByRole('slider')).toBeNull();
    expect(
      (
        screen.getByRole('button', {
          name: 'Aprovar faixas',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
