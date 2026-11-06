import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { fireEvent, render, screen } from '@testing-library/angular';
import {
  MEDIA_ELEMENT_FACTORY,
  MediaEngine,
} from '@core/media/media-engine.js';
import { VOLUME_SUPPORT } from '@core/media/volume-support.js';
import type { AnswerSource } from '@kb-chat/contracts';
import {
  fakeMediaElement,
  type FakeMedia,
} from '../../../testing/fake-media-element.js';
import { aMediaItem, aTranscription } from '../../../testing/media-fixtures.js';
import { SEARCH_HIGHLIGHTS } from '../transcript/search-highlights.js';
import { TrackPassagePanel } from './track-passage-panel.js';

const TRACK_ID = aMediaItem().id;
const ITEM_URL = `/api/v1/media/${TRACK_ID}`;

const MEDIA = {
  mediaId: TRACK_ID,
  kind: 'track',
  recordingTitle: 'Palestra de 12/03/2017',
  ordinal: 3,
  total: 12,
  durationMs: 508_000,
  confidence: 'normal',
} as const;

const SOURCE: AnswerSource = {
  n: 1,
  id: 'raw/media/r/t.md',
  title: 'O que é o ritmo?',
  authorship: 'mestre-laercio',
  media: MEDIA,
  passages: [{ at: '0:41', startMs: 41_300, endMs: 70_000 }],
};

const painted = new Map<string, string[]>();

interface PanelInputs {
  readonly source: AnswerSource;
  readonly at: string;
  readonly topic?: string;
  readonly canGoBack?: boolean;
  readonly back?: () => void;
}

async function openPanel(
  { back, ...inputs }: PanelInputs = { source: SOURCE, at: '0:41' },
): Promise<{
  media: FakeMedia;
  http: HttpTestingController;
  closed: ReturnType<typeof vi.fn>;
}> {
  const media = fakeMediaElement('audio');
  const closed = vi.fn();
  await render(TrackPassagePanel, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: MEDIA_ELEMENT_FACTORY, useValue: () => media.element },
      { provide: VOLUME_SUPPORT, useValue: Promise.resolve(false) },
      {
        provide: SEARCH_HIGHLIGHTS,
        useValue: {
          show: (name: string, ranges: readonly Range[]) =>
            painted.set(
              name,
              ranges.map((range) => range.toString()),
            ),
          clear: (name: string) => painted.delete(name),
        },
      },
    ],
    inputs,
    on: { closed, ...(back ? { back } : {}) },
  });
  return { media, http: TestBed.inject(HttpTestingController), closed };
}

const READY = aMediaItem({
  transcription: aTranscription({
    status: 'done',
    confidence: 'normal',
    version: 2,
  }),
});

const TRANSCRIPT = {
  mediaId: TRACK_ID,
  version: 2,
  confidence: 'normal',
  segments: [
    { startMs: 0, endMs: 40_500, text: 'Pergunta sobre o ritmo.' },
    { startMs: 41_300, endMs: 70_000, text: 'O ritmo é a lei do pêndulo.' },
    { startMs: 70_000, endMs: 95_000, text: 'Tudo flui.' },
  ],
};

describe('TrackPassagePanel (KBC-099 FR-8, T22)', () => {
  afterEach(() => TestBed.inject(MediaEngine).unload());

  it('AC-9: the title, the recording and the minute; the player at 0:39, paused; the passage painted and marked', async () => {
    painted.clear();
    const { http, media } = await openPanel();
    http.expectOne(ITEM_URL).flush(READY);
    await screen.findByRole('slider', { name: 'Posição' });
    http.expectOne(`${ITEM_URL}/transcript?v=2`).flush(TRANSCRIPT);

    const dialog = screen.getByRole('dialog', {
      name: 'Trecho da faixa O que é o ritmo?, aos 41 segundos',
    });
    expect(dialog).toBeTruthy();
    const title = screen.getByRole('heading', { name: 'O que é o ritmo?' });
    expect(document.activeElement).toBe(title);
    expect(
      screen.getByText('Palestra de 12/03/2017 · faixa 3 de 12'),
    ).toBeTruthy();
    expect(screen.getByText('aos 41 segundos')).toBeTruthy();
    // Cued once the transcript says the passage is still there.
    await vi.waitFor(() =>
      expect(media.calls).toContain(`load:${ITEM_URL}/stream`),
    );
    media.setDuration(508);
    media.emit('loadedmetadata');
    media.emit('seeked');
    await vi.waitFor(() =>
      expect(TestBed.inject(MediaEngine).playback().currentMs).toBe(39_300),
    );
    expect(media.calls).not.toContain('play');
    expect(screen.getByRole('button', { name: 'Tocar' })).toBeTruthy();
    await vi.waitFor(() =>
      expect(painted.get('transcript-passage')).toEqual([
        'O ritmo é a lei do pêndulo.',
      ]),
    );
    const cited = document.querySelector('.segment.cited');
    expect(cited?.textContent).toContain('O ritmo é a lei do pêndulo.');
    expect(document.querySelectorAll('.segment.cited')).toHaveLength(1);
  });

  it('links to the track page 2 s before the passage', async () => {
    const { http } = await openPanel();
    http.expectOne(ITEM_URL).flush(READY);
    const link = await screen.findByRole('link', {
      name: 'Abrir na página da faixa',
    });
    expect(link.getAttribute('href')).toBe(`/midia/${TRACK_ID}?t=39`);
  });

  it('AC-15: an answer saved before KBC-099 opens the track at its start, with nothing marked', async () => {
    const old: AnswerSource = {
      n: SOURCE.n,
      id: SOURCE.id,
      title: SOURCE.title,
      media: MEDIA,
    };
    const { http } = await openPanel({ source: old, at: '' });
    http.expectOne(ITEM_URL).flush(READY);
    await screen.findByRole('slider', { name: 'Posição' });
    expect(
      screen.getByRole('dialog', { name: 'Trecho da faixa O que é o ritmo?' }),
    ).toBeTruthy();
    expect(TestBed.inject(MediaEngine).playback().currentMs).toBe(0);
  });

  it('says the track is gone (archived, deleted or out of reach) and closes with Fechar or Esc', async () => {
    const { http, closed, media } = await openPanel();
    http
      .expectOne(ITEM_URL)
      .flush(
        { error: { code: 'MEDIA_NOT_FOUND', message: 'Unknown media' } },
        { status: 404, statusText: 'Not Found' },
      );
    expect(
      await screen.findByText('Esta faixa não está mais disponível.'),
    ).toBeTruthy();
    expect(media.calls).toEqual([]);
    const [closeTop] = screen.getAllByRole('button', { name: /Fechar/ });
    if (closeTop) fireEvent.click(closeTop);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(closed).toHaveBeenCalledTimes(2);
  });

  it('QA BUG-1: a track archived after the answer is gone too, though the API still answers 200', async () => {
    const { http, media } = await openPanel();
    http.expectOne(ITEM_URL).flush({ ...READY, archived: true });
    expect(
      await screen.findByText('Esta faixa não está mais disponível.'),
    ).toBeTruthy();
    // The header's ✕ and the notice's own Fechar.
    expect(screen.getAllByRole('button', { name: /^Fechar/ })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Tocar' })).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
    http.expectNone(`${ITEM_URL}/transcript?v=2`);
    expect(media.calls).toEqual([]);
  });

  it('QA BUG-1: a track moved out of the conversation’s collection is gone; one in a sub-collection is not', async () => {
    const moved = await openPanel({
      source: SOURCE,
      at: '0:41',
      topic: 'hermetismo',
    });
    moved.http.expectOne(ITEM_URL).flush({ ...READY, topic: 'outro-acervo' });
    expect(
      await screen.findByText('Esta faixa não está mais disponível.'),
    ).toBeTruthy();
    expect(moved.media.calls).toEqual([]);
  });

  it('opens a track of a sub-collection of the conversation’s collection', async () => {
    const { http } = await openPanel({
      source: SOURCE,
      at: '0:41',
      topic: 'hermetismo',
    });
    http.expectOne(ITEM_URL).flush({ ...READY, topic: 'hermetismo/palestras' });
    expect(await screen.findByRole('slider', { name: 'Posição' })).toBeTruthy();
    expect(
      screen.queryByText('Esta faixa não está mais disponível.'),
    ).toBeNull();
  });

  it('T22 "Faixa editada": a stored passage that no longer falls in a segment says so and starts at 0:00', async () => {
    painted.clear();
    const { http, media } = await openPanel({
      source: {
        ...SOURCE,
        passages: [{ at: '0:41', startMs: 200_000, endMs: 210_000 }],
      },
      at: '0:41',
    });
    http.expectOne(ITEM_URL).flush(READY);
    await screen.findByRole('slider', { name: 'Posição' });
    http.expectOne(`${ITEM_URL}/transcript?v=2`).flush(TRANSCRIPT);
    const status = await screen.findByText(
      'O trecho citado mudou desde a resposta. Mostrando o começo da faixa.',
    );
    expect(status.closest('[role="status"]')).toBeTruthy();
    expect(
      screen.getByRole('dialog', { name: 'Trecho da faixa O que é o ritmo?' }),
    ).toBeTruthy();
    await vi.waitFor(() =>
      expect(media.calls).toContain(`load:${ITEM_URL}/stream`),
    );
    media.setDuration(508);
    media.emit('loadedmetadata');
    media.emit('seeked');
    await vi.waitFor(() =>
      expect(TestBed.inject(MediaEngine).playback().currentMs).toBe(0),
    );
    expect(document.querySelectorAll('.segment.cited')).toHaveLength(0);
    expect(media.calls).not.toContain('play');
  });

  it('T22 accessibility: before anything plays, the cited segment is the current one, not the one the player sits in at −2 s', async () => {
    const { http, media } = await openPanel({
      source: {
        ...SOURCE,
        passages: [{ at: '0:41', startMs: 41_300, endMs: 70_000 }],
      },
      at: '0:41',
    });
    http.expectOne(ITEM_URL).flush(READY);
    await screen.findByRole('slider', { name: 'Posição' });
    http.expectOne(`${ITEM_URL}/transcript?v=2`).flush(TRANSCRIPT);
    await vi.waitFor(() =>
      expect(media.calls).toContain(`load:${ITEM_URL}/stream`),
    );
    media.setDuration(508);
    media.emit('loadedmetadata');
    media.emit('seeked');
    await vi.waitFor(() =>
      expect(TestBed.inject(MediaEngine).playback().currentMs).toBe(39_300),
    );
    const current = await vi.waitFor(() => {
      const found = document.querySelectorAll('[aria-current="true"]');
      expect(found).toHaveLength(1);
      return found[0];
    });
    expect(current?.closest('.segment')?.textContent).toContain(
      'O ritmo é a lei do pêndulo.',
    );
    // The segment at 0:39 (the player's place) is not painted as the one being heard.
    expect(document.querySelectorAll('.segment.active')).toHaveLength(0);

    // Once it plays, the segment heard is the current one again (KBC-038).
    fireEvent.click(screen.getByRole('button', { name: 'Tocar' }));
    media.emit('playing');
    await vi.waitFor(() =>
      expect(document.querySelectorAll('.segment.active')).toHaveLength(1),
    );
    const heard = document.querySelector('[aria-current="true"]');
    expect(heard?.closest('.segment')?.textContent).toContain(
      'Pergunta sobre o ritmo.',
    );
  });

  it('T22 flow 1: "← Voltar" goes back to the document the track opened over', async () => {
    const back = vi.fn<() => void>();
    const { http } = await openPanel({
      source: SOURCE,
      at: '0:41',
      canGoBack: true,
      back,
    });
    http.expectOne(ITEM_URL).flush(READY);
    fireEvent.click(await screen.findByRole('button', { name: '← Voltar' }));
    expect(back).toHaveBeenCalledOnce();
  });

  it('shows no "← Voltar" when the track opened from the answer alone', async () => {
    const { http } = await openPanel();
    http.expectOne(ITEM_URL).flush(READY);
    await screen.findByRole('slider', { name: 'Posição' });
    expect(screen.queryByRole('button', { name: '← Voltar' })).toBeNull();
  });

  it('a network failure offers to try again', async () => {
    const { http } = await openPanel();
    http
      .expectOne(ITEM_URL)
      .flush('down', { status: 503, statusText: 'Unavailable' });
    expect(
      await screen.findByText('Não foi possível abrir a faixa.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    http.expectOne(ITEM_URL).flush(READY);
    expect(await screen.findByRole('slider', { name: 'Posição' })).toBeTruthy();
  });

  it('says a low-confidence transcript may be wrong', async () => {
    const low: AnswerSource = {
      ...SOURCE,
      media: { ...MEDIA, confidence: 'low' },
    };
    const { http } = await openPanel({ source: low, at: '0:41' });
    http.expectOne(ITEM_URL).flush(READY);
    expect(
      await screen.findByText(
        'Transcrição automática de baixa confiança: pode haver trechos errados.',
      ),
    ).toBeTruthy();
  });
});
