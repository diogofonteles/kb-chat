import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { fireEvent, render, screen, within } from '@testing-library/angular';
import {
  MEDIA_ELEMENT_FACTORY,
  MediaEngine,
} from '@core/media/media-engine.js';
import { VOLUME_SUPPORT } from '@core/media/volume-support.js';
import type { AnswerSource, Topic } from '@kb-chat/contracts';
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
  readonly topics?: readonly Topic[];
  readonly sources?: readonly AnswerSource[];
  readonly canGoBack?: boolean;
  readonly inSheet?: boolean;
  readonly back?: () => void;
  readonly sourceChosen?: (source: AnswerSource) => void;
}

async function openPanel(
  { back, sourceChosen, ...inputs }: PanelInputs = {
    source: SOURCE,
    at: '0:41',
  },
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
    on: {
      closed,
      ...(back ? { back } : {}),
      ...(sourceChosen ? { sourceChosen } : {}),
    },
  });
  return { media, http: TestBed.inject(HttpTestingController), closed };
}

const READY = aMediaItem({
  durationMs: 508_000,
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

const TOPICS: readonly Topic[] = [
  {
    slug: 'hermetismo',
    title: 'Hermetismo',
    documentCount: 3,
    trackCount: 1,
    parent: null,
  } as Topic,
];

const TEXT: AnswerSource = { n: 2, id: 'leis.md', title: 'As leis' };

/** The item and its transcript answered, the engine cued and its media loaded. */
async function openReady(
  inputs: PanelInputs = { source: SOURCE, at: '0:41' },
  transcript: object = TRANSCRIPT,
) {
  const opened = await openPanel(inputs);
  opened.http.expectOne(ITEM_URL).flush(READY);
  await vi.waitFor(() =>
    opened.http.expectOne(`${ITEM_URL}/transcript?v=2`).flush(transcript),
  );
  await vi.waitFor(() =>
    expect(opened.media.calls).toContain(`load:${ITEM_URL}/stream`),
  );
  opened.media.setDuration(508);
  opened.media.emit('loadedmetadata');
  opened.media.emit('seeked');
  return opened;
}

describe('TrackPassagePanel (KBC-150, v2 audio source; KBC-099 T22)', () => {
  afterEach(() => TestBed.inject(MediaEngine).unload());

  it('stopped: the head, the cited passage first, "Ouvir o trecho" on the app’s player, no player of its own', async () => {
    const chosen = vi.fn<(source: AnswerSource) => void>();
    const { media, closed } = await openReady({
      source: SOURCE,
      at: '0:41',
      topics: TOPICS,
      sources: [SOURCE, TEXT],
      sourceChosen: chosen,
    });
    await vi.waitFor(() =>
      expect(TestBed.inject(MediaEngine).playback().currentMs).toBe(39_300),
    );
    expect(
      screen.getByRole('dialog', {
        name: 'Trecho da faixa O que é o ritmo?, aos 41 segundos',
      }),
    ).toBeTruthy();
    expect(screen.getByText('Fonte 1 de 2 · Áudio')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'O que é o ritmo?' })).toBe(
      document.activeElement,
    );
    expect(
      screen.getByText(
        'Mestre Laércio · Hermetismo · 8:28 · faixa 3 de 12 · Palestra de 12/03/2017',
      ),
    ).toBeTruthy();
    // No player of its own (item 1): no slider, no volume, no speed, no CC.
    expect(screen.queryByRole('slider')).toBeNull();
    expect(document.querySelector('app-media-player')).toBeNull();
    const card = screen.getByRole('region', {
      name: 'Citado na resposta · 0:41–1:10',
    });
    expect(card.textContent).toContain('O ritmo é a lei do pêndulo.');
    expect(card.classList).not.toContain('playing');
    expect(media.calls).not.toContain('play');

    // ‹ is the first source: disabled; › goes to the text source.
    expect(
      (
        screen.getByRole('button', {
          name: 'Fonte anterior',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Próxima fonte' }));
    expect(chosen).toHaveBeenCalledWith(TEXT);
    expect(
      screen
        .getByRole('link', { name: 'Abrir a página da faixa' })
        .getAttribute('href'),
    ).toBe(`/midia/${TRACK_ID}?t=39`);
    expect(
      screen.getByRole('link', { name: 'Abrir a faixa' }).getAttribute('href'),
    ).toBe(`/midia/${TRACK_ID}?t=39`);

    fireEvent.click(screen.getByRole('button', { name: 'Ouvir o trecho' }));
    expect(media.calls).toContain('play');
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(closed).toHaveBeenCalledOnce();
  });

  it('around the passage: only the speech before, the passage and the speech after, with times that play', async () => {
    const { media } = await openReady();
    const lines = within(
      screen.getByRole('list', { name: 'Em volta do trecho' }),
    ).getAllByRole('listitem');
    expect(
      lines.map((one) => one.textContent?.replace(/\s+/g, ' ').trim()),
    ).toEqual([
      '0:00 Pergunta sobre o ritmo.',
      '0:41 Trecho citado: O ritmo é a lei do pêndulo.',
      '1:10 Tudo flui.',
    ]);
    expect(lines[1]?.classList).toContain('cited-line');
    // Not by colour alone (WCAG 1.3.1): a screen reader hears which speech is the passage.
    expect(
      within(lines[1] as HTMLElement).getByText('Trecho citado:').classList,
    ).toContain('visually-hidden');
    expect(
      within(lines[0] as HTMLElement).queryByText('Trecho citado:'),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Ouvir a partir de 1 minuto e 10 segundos',
      }),
    );
    await vi.waitFor(() =>
      expect(TestBed.inject(MediaEngine).playback().currentMs).toBe(70_000),
    );
    expect(media.calls).toContain('play');
  });

  it('review: with the bar closed or another media on the player, the panel puts its own track back and plays it', async () => {
    const { media } = await openReady();
    const engine = TestBed.inject(MediaEngine);
    const button = (name: string) =>
      screen.getByRole('button', { name }) as HTMLButtonElement;

    // The bar's ✕ released the player: the buttons stay usable and play this track.
    engine.unload();
    // A render goes by: the buttons as they show once the player let the track go.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(button('Ouvir o trecho').disabled).toBe(false);
    expect(button('Faixa toda').disabled).toBe(false);
    expect(button('Marcar este trecho').disabled).toBe(false);
    media.calls.length = 0;
    fireEvent.click(button('Ouvir o trecho'));
    expect(engine.source()?.id).toBe(TRACK_ID);
    expect(media.calls).toEqual([`load:${ITEM_URL}/stream`, 'play']);

    // Another media took the player: a time around the passage never seeks in it.
    engine.load({
      id: 'other-track',
      title: 'Outra faixa',
      src: '/api/v1/media/other-track/stream',
      durationMs: 600_000,
    });
    media.calls.length = 0;
    fireEvent.click(button('Ouvir a partir de 1 minuto e 10 segundos'));
    expect(engine.source()?.id).toBe(TRACK_ID);
    expect(media.calls).toEqual([`load:${ITEM_URL}/stream`, 'play']);
  });

  it('playing: "Pausar", the "tocando" seal, the card in the cover’s colour, the words lit as they are spoken', async () => {
    const { media, http } = await openReady();
    http.expectOne(`${ITEM_URL}/transcript/words?from=1&count=1`).flush({
      mediaId: TRACK_ID,
      version: 2,
      words: [
        { segment: 1, startMs: 41_300, endMs: 42_000, text: 'O' },
        { segment: 1, startMs: 42_000, endMs: 43_000, text: 'ritmo' },
        { segment: 1, startMs: 43_000, endMs: 44_000, text: 'é' },
        { segment: 1, startMs: 50_000, endMs: 51_000, text: 'pêndulo.' },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ouvir o trecho' }));
    media.setCurrentTime(43.5);
    media.emit('playing');
    media.emit('timeupdate');
    const pause = await screen.findByRole('button', { name: 'Pausar' });
    // Opened from a search (no answer around it): "Trecho", not "Citado na resposta".
    const card = screen.getByRole('region', { name: 'Trecho · 0:41–1:10' });
    expect(card.classList).toContain('playing');
    expect(within(card).getByText('tocando')).toBeTruthy();
    expect(
      [...card.querySelectorAll('.quote span.lit')].map((one) =>
        one.textContent?.trim(),
      ),
    ).toEqual(['O', 'ritmo', 'é']);
    // The line heard now is marked (item 5).
    expect(
      document.querySelector('.line[aria-current="true"]')?.textContent,
    ).toContain('O ritmo é a lei do pêndulo.');
    fireEvent.click(pause);
    expect(media.calls.at(-1)).toBe('pause');
  });

  it('several citations of the same track: a mark each on the timeline, "Outro trecho citado" goes to the other one', async () => {
    const twice: AnswerSource = {
      ...SOURCE,
      passages: [
        { at: '0:41', startMs: 41_300, endMs: 70_000 },
        { at: '1:10', startMs: 70_000, endMs: 95_000 },
      ],
    };
    await openReady({ source: twice, at: '0:41', sources: [twice] });
    const marks = screen.getAllByRole('button', { name: /^Trecho citado aos/ });
    expect(marks).toHaveLength(2);
    expect(marks[0]?.getAttribute('aria-current')).toBe('true');
    // One source alone: no ‹ ›.
    expect(screen.queryByRole('button', { name: 'Próxima fonte' })).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Outro trecho citado, em 1:10' }),
    );
    expect(
      await screen.findByRole('region', {
        name: 'Citado na resposta · 1:10–1:35',
      }),
    ).toBeTruthy();
    await vi.waitFor(() =>
      expect(TestBed.inject(MediaEngine).playback().currentMs).toBe(68_000),
    );
    expect(
      screen.getByRole('button', { name: 'Outro trecho citado, em 0:41' }),
    ).toBeTruthy();
    fireEvent.click(marks[0] as HTMLElement);
    expect(
      await screen.findByRole('region', {
        name: 'Citado na resposta · 0:41–1:10',
      }),
    ).toBeTruthy();
  });

  it('the full transcript opens in the panel, with its search, and goes back to the lines around', async () => {
    await openReady();
    expect(
      screen.queryByRole('list', { name: 'Trechos da transcrição' }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Transcrição completa' }),
    );
    expect(
      await screen.findByRole('list', { name: 'Trechos da transcrição' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('list', { name: 'Em volta do trecho' }),
    ).toBeNull();
    expect(screen.getByRole('searchbox')).toBeTruthy();
    // One title: the panel's "Transcrição completa", not the transcript's own "Transcrição" too.
    expect(
      screen.getByRole('heading', { name: 'Transcrição completa' }),
    ).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Transcrição' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Em volta do trecho' }));
    expect(
      await screen.findByRole('list', { name: 'Em volta do trecho' }),
    ).toBeTruthy();
    // 🔍 opens it on its search field.
    fireEvent.click(
      screen.getByRole('button', { name: 'Buscar na transcrição' }),
    );
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('searchbox')),
    );
  });

  it('says who speaks, with the colour of the voice, when the transcript names the voices', async () => {
    await openReady(
      { source: SOURCE, at: '0:41' },
      {
        ...TRANSCRIPT,
        segments: TRANSCRIPT.segments.map((one, index) => ({
          ...one,
          voice: index === 2 ? 2 : 1,
        })),
        voiceNames: [
          {
            voice: 1,
            kind: 'person',
            name: 'Irmã Helena',
            main: false,
            speakerId: '22222222-2222-4222-8222-222222222222',
          },
          {
            voice: 2,
            kind: 'audience',
            name: null,
            main: false,
            speakerId: null,
          },
        ],
      },
    );
    const card = screen.getByRole('region', { name: /Citado|Trecho/ });
    expect(within(card).getByText('Irmã Helena')).toBeTruthy();
    expect(screen.getByText('Pergunta da plateia')).toBeTruthy();
  });

  it('copies the track page at the passage, and marks it', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const { http } = await openReady();
    fireEvent.click(
      screen.getByRole('button', { name: 'Copiar o link do trecho' }),
    );
    expect(writeText).toHaveBeenCalledWith(
      `${location.origin}/midia/${TRACK_ID}?t=41`,
    );
    await vi.waitFor(() =>
      http.expectOne(`${ITEM_URL}/bookmarks`).flush({ items: [] }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Marcar este trecho' }));
    const created = await vi.waitFor(() =>
      http.expectOne(
        (request) =>
          request.method === 'POST' && request.url === `${ITEM_URL}/bookmarks`,
      ),
    );
    expect(created.request.body).toMatchObject({ positionMs: 41_300 });
  });

  it('in the phone sheet: the tab names it, the time and the voice share a line, "Abrir a faixa" leaves while it plays and the sheet’s strip says what plays', async () => {
    const { media } = await openReady({
      source: SOURCE,
      at: '0:41',
      inSheet: true,
      sources: [SOURCE, TEXT],
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('tabpanel')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Fechar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Faixa toda' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Abrir a faixa' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ouvir o trecho' }));
    media.setCurrentTime(42);
    media.emit('playing');
    media.emit('timeupdate');
    expect(
      await screen.findByText('Tocando o trecho citado · 0:42'),
    ).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Abrir a faixa' })).toBeNull();
  });

  it('AC-15: an answer saved before KBC-099 opens the track at its start, the whole transcript in view', async () => {
    const old: AnswerSource = {
      n: SOURCE.n,
      id: SOURCE.id,
      title: SOURCE.title,
      media: MEDIA,
    };
    const { http } = await openPanel({ source: old, at: '' });
    http.expectOne(ITEM_URL).flush(READY);
    await vi.waitFor(() =>
      http.expectOne(`${ITEM_URL}/transcript?v=2`).flush(TRANSCRIPT),
    );
    expect(
      screen.getByRole('dialog', { name: 'Trecho da faixa O que é o ritmo?' }),
    ).toBeTruthy();
    expect(screen.getByText('Faixa de áudio')).toBeTruthy();
    expect(
      await screen.findByRole('button', { name: 'Ouvir a faixa' }),
    ).toBeTruthy();
    expect(
      await screen.findByRole('list', { name: 'Trechos da transcrição' }),
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
    expect(screen.getAllByRole('button', { name: /^Fechar/ })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Ouvir o trecho' })).toBeNull();
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
    expect(
      await screen.findByRole('button', { name: 'Ouvir o trecho' }),
    ).toBeTruthy();
    expect(
      screen.queryByText('Esta faixa não está mais disponível.'),
    ).toBeNull();
  });

  it('T22 "Faixa editada": a stored passage that no longer falls in a segment says so and starts at 0:00', async () => {
    const { media } = await openReady({
      source: {
        ...SOURCE,
        passages: [{ at: '0:41', startMs: 200_000, endMs: 210_000 }],
      },
      at: '0:41',
    });
    const status = await screen.findByText(
      'O trecho citado mudou desde a resposta. Mostrando o começo da faixa.',
    );
    expect(status.closest('[role="status"]')).toBeTruthy();
    expect(
      screen.getByRole('dialog', { name: 'Trecho da faixa O que é o ritmo?' }),
    ).toBeTruthy();
    await vi.waitFor(() =>
      expect(TestBed.inject(MediaEngine).playback().currentMs).toBe(0),
    );
    expect(screen.queryByRole('region', { name: /Citado/ })).toBeNull();
    expect(media.calls).not.toContain('play');
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
    await screen.findByRole('button', { name: 'Ouvir o trecho' });
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
    expect(
      await screen.findByRole('button', { name: 'Ouvir o trecho' }),
    ).toBeTruthy();
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
