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
import { PlayerAnnouncer } from '@core/media/player-announcer.js';
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

  it('review 2: a mark with another media on the player waits for this track and never lands on the other', async () => {
    const { http } = await openReady();
    const engine = TestBed.inject(MediaEngine);
    await vi.waitFor(() =>
      http.expectOne(`${ITEM_URL}/bookmarks`).flush({ items: [] }),
    );
    engine.load({
      id: 'other-track',
      title: 'Outra faixa',
      src: '/api/v1/media/other-track/stream',
      durationMs: 600_000,
    });
    await vi.waitFor(() =>
      http
        .expectOne('/api/v1/media/other-track/bookmarks')
        .flush({ items: [] }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Marcar este trecho' }));
    expect(engine.source()?.id).toBe(TRACK_ID);
    http.expectNone(
      (request) =>
        request.method === 'POST' && request.url.includes('other-track'),
    );
    await vi.waitFor(() =>
      http.expectOne(`${ITEM_URL}/bookmarks`).flush({ items: [] }),
    );
    const created = await vi.waitFor(() =>
      http.expectOne(
        (request) =>
          request.method === 'POST' && request.url === `${ITEM_URL}/bookmarks`,
      ),
    );
    expect(created.request.body).toMatchObject({ positionMs: 41_300 });
  });

  it('KBC-155 AC-1/AC-2/AC-3: playing, one control only: "tocando no player", no "Pausar", no progress, the words lit as they are spoken', async () => {
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
    // Stopped: the progress of a player of its own is nowhere (no "0:39 … 8:28" timeline).
    expect(screen.queryByText(/^trecho citado /)).toBeNull();
    expect(
      screen.queryByRole('button', { name: /^Trecho citado aos/ }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Faixa toda' })).toBeTruthy();
    // Heard on past the passage below: "Parar no fim do trecho" off (KBC-160 BR-5).
    fireEvent.click(
      screen.getByRole('switch', { name: 'Parar no fim do trecho' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ouvir o trecho' }));
    media.setCurrentTime(43.5);
    media.emit('playing');
    media.emit('timeupdate');
    // Opened from a search (no answer around it): "Trecho", not "Citado na resposta".
    const card = await screen.findByRole('region', {
      name: 'Trecho · 0:41–1:10',
    });
    await vi.waitFor(() => expect(card.classList).toContain('playing'));
    expect(within(card).getByText('tocando no player')).toBeTruthy();
    // The bar is the one control: nothing in the panel pauses, restarts or seeks it.
    expect(screen.queryByRole('button', { name: 'Pausar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ouvir o trecho' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Faixa toda' })).toBeNull();
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(
      [...card.querySelectorAll('.quote span.lit')].map((one) =>
        one.textContent?.trim(),
      ),
    ).toEqual(['O', 'ritmo', 'é']);
    // The line heard now is marked (item 5).
    expect(
      document.querySelector('.line[aria-current="true"]')?.textContent,
    ).toContain('O ritmo é a lei do pêndulo.');

    // Past the passage (KBC-154), "Ouvir o trecho" comes back and leads to it again.
    media.setCurrentTime(80);
    media.emit('timeupdate');
    const listen = await screen.findByRole('button', {
      name: 'Ouvir o trecho',
    });
    expect(within(card).getByText('tocando no player')).toBeTruthy();
    fireEvent.click(listen);
    await vi.waitFor(() =>
      expect(TestBed.inject(MediaEngine).playback().currentMs).toBe(39_300),
    );
    expect(media.calls).not.toContain('pause');
  });

  it('KBC-155 review: "Ouvir o trecho" leaves once the passage plays, and the focus goes to "tocando no player", not the page', async () => {
    const { media } = await openReady();
    const listen = screen.getByRole('button', { name: 'Ouvir o trecho' });
    listen.focus();
    fireEvent.click(listen);
    media.setCurrentTime(43.5);
    media.emit('playing');
    media.emit('timeupdate');
    await vi.waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Ouvir o trecho' }),
      ).toBeNull(),
    );
    const status = screen.getByText('tocando no player').closest('.on-player');
    await vi.waitFor(() => expect(document.activeElement).toBe(status));
    expect(document.activeElement).not.toBe(document.body);
  });

  it('KBC-155 AC-4: several citations of the same track: "Outros trechos citados" go to each passage, with no timeline marks', async () => {
    const twice: AnswerSource = {
      ...SOURCE,
      passages: [
        { at: '0:41', startMs: 41_300, endMs: 70_000 },
        { at: '1:10', startMs: 70_000, endMs: 95_000 },
      ],
    };
    await openReady({ source: twice, at: '0:41', sources: [twice] });
    expect(
      screen.queryByRole('button', { name: /^Trecho citado aos/ }),
    ).toBeNull();
    const others = screen.getByRole('list', { name: 'Outros trechos citados' });
    expect(
      screen.getByRole('heading', { name: 'Outros trechos citados' }),
    ).toBeTruthy();
    expect(within(others).getAllByRole('button')).toHaveLength(1);
    // One source alone: no ‹ ›.
    expect(screen.queryByRole('button', { name: 'Próxima fonte' })).toBeNull();
    fireEvent.click(
      within(others).getByRole('button', {
        name: 'Outro trecho citado, em 1:10',
      }),
    );
    expect(
      await screen.findByRole('region', {
        name: 'Citado na resposta · 1:10–1:35',
      }),
    ).toBeTruthy();
    await vi.waitFor(() =>
      expect(TestBed.inject(MediaEngine).playback().currentMs).toBe(68_000),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Outro trecho citado, em 0:41' }),
    );
    expect(
      await screen.findByRole('region', {
        name: 'Citado na resposta · 0:41–1:10',
      }),
    ).toBeTruthy();
  });

  it('KBC-155 AC-4: one citation of the track: no "Outros trechos citados"', async () => {
    await openReady({ source: SOURCE, at: '0:41', sources: [SOURCE] });
    expect(
      screen.queryByRole('heading', { name: 'Outros trechos citados' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: /^Outro trecho citado/ }),
    ).toBeNull();
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

  it('KBC-151 AC-1: for whoever only listens, "● Irmã Helena Prado" in the voice colour and "Falante não identificado" on the next line', async () => {
    await openReady(
      { source: SOURCE, at: '0:41' },
      {
        ...TRANSCRIPT,
        segments: TRANSCRIPT.segments.map((one, index) => ({
          ...one,
          voice: index === 1 ? 1 : 2,
        })),
        // No `speakers`: the API sends a listener only who speaks, confirmed names only.
        voiceNames: [
          {
            voice: 1,
            kind: 'person',
            name: 'Irmã Helena Prado',
            main: false,
            speakerId: '22222222-2222-4222-8222-222222222222',
          },
          {
            voice: 2,
            kind: 'unnamed',
            name: null,
            main: false,
            speakerId: null,
          },
        ],
      },
    );
    const card = screen.getByRole('region', { name: /Citado|Trecho/ });
    const name = within(card).getByText('Irmã Helena Prado');
    const dot = name.parentElement?.querySelector<HTMLElement>(
      '[style*="--color-voice-"]',
    );
    expect(dot?.getAttribute('style')).toContain('--color-voice-');
    expect(screen.getAllByText('Falante não identificado').length).toBe(2);
    expect(screen.queryByText(/^Voz \d/)).toBeNull();
  });

  describe('KBC-154: follows the speech being heard', () => {
    /** Owner's case: [8] 0:00–0:01, and the track heard on to 0:23. */
    const OPENING: AnswerSource = {
      ...SOURCE,
      passages: [{ at: '0:00', startMs: 0, endMs: 1_000 }],
    };
    const EVERY_FIVE = {
      ...TRANSCRIPT,
      segments: Array.from({ length: 12 }, (_, index) => ({
        startMs: index * 5_000,
        endMs: (index + 1) * 5_000,
        text: `Fala ${index + 1}.`,
      })),
    };
    const aroundTexts = () =>
      within(screen.getByRole('list', { name: 'Em volta do trecho' }))
        .getAllByRole('listitem')
        .map((one) => one.textContent?.replace(/\s+/g, ' ').trim());

    async function heardAt(seconds: number, playing = true) {
      const opened = await openReady(
        { source: OPENING, at: '0:00' },
        EVERY_FIVE,
      );
      // The track heard on past the passage: "Parar no fim do trecho" off (KBC-160 BR-5).
      fireEvent.click(
        screen.getByRole('switch', { name: 'Parar no fim do trecho' }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Ouvir o trecho' }));
      opened.media.setCurrentTime(seconds);
      opened.media.emit(playing ? 'playing' : 'pause');
      opened.media.emit('timeupdate');
      return opened;
    }

    it('past the cited span, "Em volta do trecho" shows the line heard, with the one before and after, and marks it', async () => {
      const { media } = await heardAt(23);
      await vi.waitFor(() =>
        expect(aroundTexts()).toEqual([
          '0:15 Fala 4.',
          '0:20 Fala 5.',
          '0:25 Fala 6.',
        ]),
      );
      const now = document.querySelector('.context .line[aria-current="true"]');
      expect(now?.textContent).toContain('Fala 5.');
      expect(now?.classList).toContain('now');
      // Paused: back on the cited lines, the cited one with its border; the 1 s citation is
      // whole sentences now (KBC-156): "Fala 1." alone is under 8 s and 12 words.
      media.setPaused(true);
      media.emit('pause');
      await vi.waitFor(() =>
        expect(aroundTexts()).toEqual([
          '0:00 Trecho citado: Fala 1. Fala 2.',
          '0:10 Fala 3.',
        ]),
      );
      expect(document.querySelector('.context .cited-line')).toBeTruthy();
    });

    it('the line right after the passage is heard on the lines already shown, the cited one with its border', async () => {
      // The passage is 0:00–0:10 (KBC-156): 0:12 is the line right after it.
      await heardAt(12);
      await vi.waitFor(() =>
        expect(
          document.querySelector('.context .line[aria-current="true"]')
            ?.textContent,
        ).toContain('Fala 3.'),
      );
      // Already in view as the line after: the list does not move (KBC-154 review).
      expect(aroundTexts()).toEqual([
        '0:00 Trecho citado: Fala 1. Fala 2.',
        '0:10 Fala 3.',
      ]);
      expect(
        document.querySelector('.context .cited-line')?.textContent,
      ).toContain('Fala 1.');
    });

    it('with "Transcrição completa" open, the line heard is current and scrolled into view', async () => {
      const scrolled = vi.fn();
      const restore = [
        vi
          .spyOn(HTMLElement.prototype, 'offsetTop', 'get')
          .mockImplementation(function (this: HTMLElement) {
            return Number(this.dataset['startMs'] ?? 0) / 50;
          }),
        vi
          .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
          .mockReturnValue(40),
        vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(200),
      ];
      const original = Element.prototype.scrollTo;
      Element.prototype.scrollTo =
        scrolled as typeof Element.prototype.scrollTo;
      try {
        const { media } = await heardAt(0.5);
        fireEvent.click(
          screen.getByRole('button', { name: 'Transcrição completa' }),
        );
        await screen.findByRole('list', { name: 'Trechos da transcrição' });
        scrolled.mockClear();
        media.setCurrentTime(23);
        media.emit('timeupdate');
        await vi.waitFor(() =>
          expect(
            document.querySelector('.segment.active')?.textContent,
          ).toContain('Fala 5.'),
        );
        expect(
          document
            .querySelector('.segment.active .time')
            ?.getAttribute('aria-current'),
        ).toBe('true');
        await vi.waitFor(() =>
          expect(scrolled).toHaveBeenCalledWith(
            expect.objectContaining({ top: expect.any(Number) }),
          ),
        );
        // Scrolled by hand: the list stops following; a new play follows again.
        const list = screen.getByRole('list', {
          name: 'Trechos da transcrição',
        });
        fireEvent.wheel(list);
        fireEvent.scroll(list);
        scrolled.mockClear();
        media.setCurrentTime(41);
        media.emit('timeupdate');
        await vi.waitFor(() =>
          expect(
            document.querySelector('.segment.active')?.textContent,
          ).toContain('Fala 9.'),
        );
        expect(scrolled).not.toHaveBeenCalled();
        media.setPaused(true);
        media.emit('pause');
        await vi.waitFor(() =>
          expect(TestBed.inject(MediaEngine).playing()).toBe(false),
        );
        await new Promise((resolve) => setTimeout(resolve));
        media.setPaused(false);
        media.emit('playing');
        await vi.waitFor(() => expect(scrolled).toHaveBeenCalled());
      } finally {
        Element.prototype.scrollTo = original;
        restore.forEach((one) => one.mockRestore());
      }
    });
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

  it('KBC-155 AC-5: in the phone sheet, the mini player sits at its foot, paused and playing, and the card has no "Pausar"', async () => {
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
    // Paused, the sheet's player is there already: the app's player behind the sheet is out of reach.
    const player = await screen.findByRole('group', { name: 'Player' });
    expect(within(player).getByText('Pausado · 0:39')).toBeTruthy();
    fireEvent.click(within(player).getByRole('button', { name: 'Tocar' }));
    expect(media.calls.at(-1)).toBe('play');
    media.setCurrentTime(42);
    media.emit('playing');
    media.emit('timeupdate');
    expect(
      await within(player).findByText('Tocando o trecho citado · 0:42'),
    ).toBeTruthy();
    const card = screen.getByRole('region', { name: /0:41–1:10/ });
    expect(within(card).queryByRole('button', { name: 'Pausar' })).toBeNull();
    expect(within(card).getByText('tocando no player')).toBeTruthy();
    fireEvent.click(within(player).getByRole('button', { name: 'Pausar' }));
    expect(media.calls.at(-1)).toBe('pause');
    media.emit('pause');
    expect(
      await within(player).findByRole('button', { name: 'Tocar' }),
    ).toBeTruthy();
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

describe('TrackPassagePanel: "Ouvir o trecho" stops at the passage end (KBC-160)', () => {
  afterEach(() => TestBed.inject(MediaEngine).unload());

  const PREFERENCES_URL = '/api/v1/media/preferences';
  const stopSwitch = () =>
    screen.getByRole('switch', {
      name: 'Parar no fim do trecho',
    }) as HTMLInputElement;
  const listen = () =>
    fireEvent.click(screen.getByRole('button', { name: 'Ouvir o trecho' }));

  /** "Ouvir o trecho" pressed and the element playing at `seconds`. */
  async function listening(seconds = 39.3) {
    const opened = await openReady();
    listen();
    opened.media.setCurrentTime(seconds);
    opened.media.emit('playing');
    opened.media.emit('timeupdate');
    return opened;
  }

  it('AC-5, AC-9: the switch is on by default, with its name, on the card', async () => {
    await openReady();
    const card = screen.getByRole('region', { name: 'Trecho · 0:41–1:10' });
    expect(
      within(card).getByRole('switch', { name: 'Parar no fim do trecho' }),
    ).toBe(stopSwitch());
    expect(stopSwitch().checked).toBe(true);
  });

  it('AC-1, AC-9: plays from 2 s before and pauses at the end, saying "Fim do trecho"', async () => {
    const { media } = await listening();
    const engine = TestBed.inject(MediaEngine);
    expect(engine.stopAtMs()).toBe(70_000);
    expect(await screen.findByText('Para às 1:10')).toBeTruthy();
    expect(engine.playback().currentMs).toBe(39_300);
    media.setCurrentTime(70);
    media.emit('timeupdate');
    expect(media.calls.at(-1)).toBe('pause');
    media.emit('pause');
    await vi.waitFor(() =>
      expect(TestBed.inject(PlayerAnnouncer).message()).toBe('Fim do trecho'),
    );
    await vi.waitFor(() =>
      expect(screen.queryByText('Para às 1:10')).toBeNull(),
    );
  });

  it('AC-6: stopped at the end, "Ouvir o trecho" goes back to 2 s before and stops again', async () => {
    const { media } = await listening();
    media.setCurrentTime(69.98);
    media.emit('timeupdate');
    media.emit('pause');
    const engine = TestBed.inject(MediaEngine);
    expect(engine.stopAtMs()).toBeNull();
    listen();
    expect(media.calls.at(-1)).toBe('play');
    expect(media.calls).toContain('seek:39.3');
    expect(engine.stopAtMs()).toBe(70_000);
  });

  it('AC-4, BR-5: off, "Ouvir o trecho" plays on past the end, and the choice goes to the account', async () => {
    const { media, http } = await openReady();
    fireEvent.click(stopSwitch());
    expect(stopSwitch().checked).toBe(false);
    expect(
      http.expectOne({ method: 'PUT', url: PREFERENCES_URL }).request.body,
    ).toEqual({ stopAtPassageEnd: false });
    listen();
    media.emit('playing');
    expect(TestBed.inject(MediaEngine).stopAtMs()).toBeNull();
    media.setCurrentTime(80);
    media.emit('timeupdate');
    expect(media.calls).not.toContain('pause');
    expect(screen.queryByText(/^Para às/)).toBeNull();
  });

  it('reads the choice from the account', async () => {
    const { http } = await openReady();
    http.expectOne({ method: 'GET', url: PREFERENCES_URL }).flush({
      speed: 1,
      showRemaining: true,
      skipBackSec: 15,
      skipForwardSec: 30,
      skipSilences: false,
      wordHighlight: true,
      stopAtPassageEnd: false,
    });
    await vi.waitFor(() => expect(stopSwitch().checked).toBe(false));
  });

  it('turned off while the passage plays, the stop goes; on again, it comes back', async () => {
    await listening(50);
    const engine = TestBed.inject(MediaEngine);
    fireEvent.click(stopSwitch());
    expect(engine.stopAtMs()).toBeNull();
    fireEvent.click(stopSwitch());
    expect(engine.stopAtMs()).toBe(70_000);
  });

  it('AC-2, AC-3: a seek inside the passage keeps the stop; one out of it lets the track play on', async () => {
    const { media } = await listening(50);
    const engine = TestBed.inject(MediaEngine);
    engine.seek(60_000);
    expect(engine.stopAtMs()).toBe(70_000);
    engine.seek(120_000);
    media.emit('seeked');
    expect(engine.stopAtMs()).toBeNull();
    media.setCurrentTime(121);
    media.emit('timeupdate');
    expect(media.calls).not.toContain('pause');
  });

  it('AC-7: "Faixa toda" plays the track with no stop at the passage', async () => {
    const { media } = await listening(50);
    media.emit('pause');
    fireEvent.click(screen.getByRole('button', { name: 'Faixa toda' }));
    expect(TestBed.inject(MediaEngine).stopAtMs()).toBeNull();
    expect(media.calls).toContain('seek:0');
  });

  it('BR-1: "Outro trecho citado" while playing stops at the end of that passage', async () => {
    const twice: AnswerSource = {
      ...SOURCE,
      passages: [
        { at: '0:41', startMs: 41_300, endMs: 70_000 },
        { at: '1:10', startMs: 70_000, endMs: 95_000 },
      ],
    };
    const { media } = await openReady({
      source: twice,
      at: '0:41',
      sources: [twice],
    });
    listen();
    media.emit('playing');
    fireEvent.click(
      screen.getByRole('button', { name: 'Outro trecho citado, em 1:10' }),
    );
    expect(TestBed.inject(MediaEngine).stopAtMs()).toBe(95_000);
  });
});

describe('TrackPassagePanel: the cited passage is whole sentences (KBC-156)', () => {
  afterEach(() => TestBed.inject(MediaEngine).unload());

  /** An answer saved before KBC-156: its passage is the lone 1 s segment it cited. */
  const FRAGMENT: AnswerSource = {
    ...SOURCE,
    passages: [{ at: '0:00', startMs: 0, endMs: 1_000 }],
  };
  const SPOKEN = {
    ...TRANSCRIPT,
    segments: [
      { startMs: 0, endMs: 1_000, text: 'É, italiano, tá.' },
      {
        startMs: 1_200,
        endMs: 6_000,
        text: 'Meu pai veio da Itália com a família,',
      },
      {
        startMs: 6_100,
        endMs: 12_000,
        text: 'e eu cresci na roça ouvindo as histórias.',
      },
      { startMs: 12_500, endMs: 21_000, text: 'Depois fomos para Manaus.' },
    ],
  };

  it('AC-7: a saved 1 s passage shows the fragment and the whole sentence after it', async () => {
    await openReady(
      { source: FRAGMENT, at: '0:00', sources: [FRAGMENT] },
      SPOKEN,
    );
    const card = await screen.findByRole('region', {
      name: 'Citado na resposta · 0:00–0:12',
    });
    expect(card.textContent).toContain('É, italiano, tá.');
    expect(card.textContent).toContain('Meu pai veio da Itália com a família,');
    expect(card.textContent).toContain(
      'e eu cresci na roça ouvindo as histórias.',
    );
    expect(card.textContent).not.toContain('Depois fomos para Manaus.');
  });

  it('AC-4: a neighbour this person may not hear is never part of the passage, nor its text', async () => {
    const [first, , third, fourth] = SPOKEN.segments;
    const hidden = {
      ...SPOKEN,
      segments: [
        first,
        { startMs: 1_200, endMs: 6_000, text: '', restricted: true },
        third,
        fourth,
      ],
    };
    await openReady(
      { source: FRAGMENT, at: '0:00', sources: [FRAGMENT] },
      hidden,
    );
    const card = await screen.findByRole('region', {
      name: 'Citado na resposta · 0:00–0:01',
    });
    expect(card.textContent).toContain('É, italiano, tá.');
    expect(card.textContent).not.toContain('cresci na roça');
  });

  it('BR-4: a saved span that already runs across a part this person may not hear is cut there, around the cited time', async () => {
    const [first, , third, fourth] = SPOKEN.segments;
    const hidden = {
      ...SPOKEN,
      segments: [
        first,
        { startMs: 1_200, endMs: 6_000, text: '', restricted: true },
        third,
        fourth,
      ],
    };
    const ACROSS: AnswerSource = {
      ...SOURCE,
      passages: [{ at: '0:00', startMs: 0, endMs: 12_000 }],
    };
    await openReady({ source: ACROSS, at: '0:00', sources: [ACROSS] }, hidden);
    const card = await screen.findByRole('region', {
      name: 'Citado na resposta · 0:00–0:01',
    });
    expect(card.textContent).toContain('É, italiano, tá.');
    expect(card.textContent).not.toContain('cresci na roça');
  });

  it('BR-4: a saved span across a change of voice is cut at it, around the cited time', async () => {
    const [first, second, third] = SPOKEN.segments;
    const voiced = {
      ...SPOKEN,
      segments: [
        { ...first, voice: 1 },
        { ...second, voice: 2 },
        { ...third, voice: 2 },
      ],
    };
    const ACROSS: AnswerSource = {
      ...SOURCE,
      passages: [{ at: '0:00', startMs: 0, endMs: 12_000 }],
    };
    await openReady({ source: ACROSS, at: '0:00', sources: [ACROSS] }, voiced);
    const card = await screen.findByRole('region', {
      name: 'Citado na resposta · 0:00–0:01',
    });
    expect(card.textContent).not.toContain('Meu pai veio da Itália');
  });
});
