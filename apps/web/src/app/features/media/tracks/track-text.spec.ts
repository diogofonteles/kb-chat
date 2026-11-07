import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import {
  provideZonelessChangeDetection,
  signal,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen, within } from '@testing-library/angular';
import type { MediaTranscript, MediaTranscriptWords } from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { SEARCH_HIGHLIGHTS } from '../transcript/search-highlights.js';
import { TrackAudition } from './track-audition.js';
import { TrackText } from './track-text.js';
import { TrackTextSource, type TextTarget } from './track-text-source.js';

const MEDIA = '11111111-1111-4111-8111-111111111111';
const BASE = `/api/v1/media/${MEDIA}/transcript`;

/** A line of speech at `at` seconds, its words 0.3 s apart (as the E2E transcripts). */
const LINES: readonly (readonly [number, string])[] = [
  [10, 'antes de tudo'],
  [29.4, 'ainda antes agora dentro'],
  [40, 'o que está em cima'],
  [50, 'sem tempos por palavra'],
  [69.4, 'quase fim fora daqui'],
  [80, 'depois'],
];
const NO_TIMES = 3;

function transcriptOf(
  version = 1,
  lines: readonly (readonly [number, string])[] = LINES,
): { transcript: MediaTranscript; words: MediaTranscriptWords } {
  const words = lines.flatMap(([at, text], segment) =>
    segment === NO_TIMES
      ? []
      : text.split(' ').map((word, index) => ({
          segment,
          startMs: Math.round((at + index * 0.3) * 1000),
          endMs: Math.round((at + index * 0.3 + 0.24) * 1000),
          text: word,
        })),
  );
  return {
    transcript: {
      mediaId: MEDIA,
      version,
      confidence: 'normal',
      segments: lines.map(([at, text]) => ({
        startMs: at * 1000,
        endMs: Math.round((at + text.split(' ').length * 0.3) * 1000),
        text,
      })),
    },
    words: { mediaId: MEDIA, version, words },
  };
}

const SPAN = { startMs: 30_000, endMs: 70_000 };
let http: HttpTestingController | null = null;
const painted = new Map<string, string[]>();
const wordPaints: string[][] = [];

interface Setup {
  readonly target?: TextTarget;
  readonly paints?: boolean;
}

async function renderText({ target, paints = true }: Setup = {}) {
  painted.clear();
  wordPaints.length = 0;
  const position = signal<number | null>(null);
  const view = await render(TrackText, {
    inputs: { span: SPAN, ordinal: 2, regionId: 'texto-2' },
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      TrackTextSource,
      { provide: TrackAudition, useValue: { positionMs: position } },
      {
        provide: SEARCH_HIGHLIGHTS,
        useValue: {
          paints,
          show: (name: string, ranges: readonly Range[]) => {
            const texts = ranges.map((range) => range.toString());
            painted.set(name, texts);
            if (name === 'track-word') wordPaints.push(texts);
          },
          clear: (name: string) => painted.delete(name),
        },
      },
    ],
  });
  const aimed: WritableSignal<TextTarget | null> = signal(
    target ?? { mediaId: MEDIA, status: 'done', key: '1' },
  );
  TestBed.inject(TrackTextSource).follow(aimed);
  // A request in flight keeps the page unstable: a tick sends it, `answer` ends it.
  TestBed.tick();
  http = TestBed.inject(HttpTestingController);
  return { view, position, aimed, http };
}

type Rendered = Awaited<ReturnType<typeof renderText>>;

/** Answers the transcript and then the pages of words it asks for. */
async function answer(
  { view, http }: Rendered,
  read = transcriptOf(),
  key = '1',
) {
  http.expectOne(`${BASE}?v=${key}`).flush(read.transcript);
  await view.fixture.whenStable();
  for (const asked of http.match((one) => one.url === `${BASE}/words`))
    asked.flush(read.words);
  await view.fixture.whenStable();
}

async function playAt({ view, position }: Rendered, ms: number | null) {
  position.set(ms);
  await view.fixture.whenStable();
}

const region = () => screen.getByRole('region', { name: 'Texto da faixa 2' });
const retryButton = () =>
  screen.getByRole('button', { name: 'Tentar de novo: carregar o texto' });
const shownLines = () =>
  Array.from(region().querySelectorAll('.line')).map((one) => one.textContent);

afterEach(() => {
  http?.verify();
  http = null;
});

describe('TrackText (KBC-092)', () => {
  it('shows only the speech of the track; the word at its end is out (AC-1)', async () => {
    const rendered = await renderText();
    expect(region().getAttribute('aria-busy')).toBe('true');
    await answer(rendered);
    expect(shownLines()).toEqual([
      'agora dentro',
      'o que está em cima',
      'sem tempos por palavra',
      'quase fim',
    ]);
    expect(region().id).toBe('texto-2');
    // One text node per line: no element per word (NFR-2), and no Tab stop in it (AC-15).
    expect(region().querySelectorAll('.line *')).toHaveLength(0);
    expect(region().tabIndex).toBe(0);
  });

  it('asks only the pages of words the track needs (FR-3)', async () => {
    const rendered = await renderText();
    rendered.http.expectOne(`${BASE}?v=1`).flush(transcriptOf().transcript);
    await rendered.view.fixture.whenStable();
    const asked = rendered.http.match((one) => one.url === `${BASE}/words`);
    expect(asked.map((one) => one.request.urlWithParams)).toEqual([
      `${BASE}/words?from=0&count=100`,
    ]);
    asked.forEach((one) => one.flush(transcriptOf().words));
  });

  it('paints "está" between its start and that of "em" (AC-2, AC-4)', async () => {
    const rendered = await renderText();
    await answer(rendered);
    await playAt(rendered, 40_600);
    expect(painted.get('track-word')).toEqual(['está']);
    await playAt(rendered, 40_899);
    expect(painted.get('track-word')).toEqual(['está']);
    await playAt(rendered, 40_900);
    expect(painted.get('track-word')).toEqual(['em']);
  });

  it('writes once per word, not per frame (AC-17, NFR-2)', async () => {
    const rendered = await renderText();
    await answer(rendered);
    await playAt(rendered, 40_600);
    const before = wordPaints.length;
    for (const ms of [40_620, 40_700, 40_800, 40_890])
      await playAt(rendered, ms);
    expect(wordPaints.length).toBe(before);
    await playAt(rendered, 40_900);
    expect(wordPaints.length).toBe(before + 1);
  });

  it('paints nothing before the start, and the first word when it starts (AC-5)', async () => {
    const rendered = await renderText();
    await answer(rendered);
    await playAt(rendered, 28_000);
    expect(painted.get('track-word')).toEqual([]);
    await playAt(rendered, 29_999);
    expect(painted.get('track-word')).toEqual([]);
    await playAt(rendered, 30_000);
    expect(painted.get('track-word')).toEqual(['agora']);
    await playAt(rendered, null);
    expect(painted.get('track-word')).toEqual([]);
  });

  it('marks a segment without word times whole while it plays (AC-8)', async () => {
    const rendered = await renderText();
    await answer(rendered);
    await playAt(rendered, 50_500);
    expect(painted.get('track-word')).toEqual([]);
    const marked = region().querySelectorAll('.line.speaking');
    expect(Array.from(marked, (one) => one.textContent)).toEqual([
      'sem tempos por palavra',
    ]);
    await playAt(rendered, 40_600);
    expect(region().querySelectorAll('.line.speaking')).toHaveLength(0);
  });

  it('marks the line playing where the browser cannot paint a word', async () => {
    const rendered = await renderText({ paints: false });
    await answer(rendered);
    await playAt(rendered, 40_600);
    expect(region().querySelector('.line.speaking')?.textContent).toBe(
      'o que está em cima',
    );
  });

  it('follows a moved start without reading again (AC-6)', async () => {
    const rendered = await renderText();
    await answer(rendered);
    expect(shownLines()[0]).toBe('agora dentro');
    rendered.view.fixture.componentRef.setInput('span', {
      ...SPAN,
      startMs: 30_200,
    });
    await rendered.view.fixture.whenStable();
    expect(shownLines()[0]).toBe('dentro');
  });

  it('says there is no speech in a stretch without any (AC-10)', async () => {
    const rendered = await renderText();
    rendered.view.fixture.componentRef.setInput('span', {
      startMs: 100_000,
      endMs: 110_000,
    });
    await answer(rendered);
    expect(
      within(region()).getByText('Nenhuma fala transcrita neste trecho.'),
    ).toBeTruthy();
  });

  it.each([
    ['waiting', 'O texto aparece quando a transcrição terminar.'],
    ['failed', 'A transcrição falhou: não há texto para mostrar.'],
    ['none', 'Este áudio não foi transcrito.'],
  ] as const)(
    'says so in words when the transcript is %s, and reads nothing (AC-9)',
    async (status, text) => {
      await renderText({ target: { mediaId: MEDIA, status, key: '' } });
      expect(within(region()).getByText(text)).toBeTruthy();
      expect(region().tabIndex).toBe(-1);
    },
  );

  it('offers "Tentar de novo" when the transcript cannot be read (AC-11)', async () => {
    const rendered = await renderText();
    rendered.http
      .expectOne(`${BASE}?v=1`)
      .flush(null, { status: 500, statusText: 'Erro' });
    await rendered.view.fixture.whenStable();
    expect(region().textContent).toContain('Não consegui carregar o texto.');
    expect(screen.getByRole('status').textContent?.trim()).toBe(
      'Não consegui carregar o texto.',
    );
    fireEvent.click(retryButton());
    TestBed.tick();
    await answer(rendered);
    expect(shownLines()).toContain('o que está em cima');
  });

  it('says it is trying again, and keeps the focus in the block when it loads (AC-11, PD-01)', async () => {
    const rendered = await renderText();
    rendered.http
      .expectOne(`${BASE}?v=1`)
      .flush(null, { status: 500, statusText: 'Erro' });
    await rendered.view.fixture.whenStable();
    retryButton().focus();
    fireEvent.click(retryButton());
    TestBed.tick();
    expect(region().getAttribute('aria-busy')).toBe('true');
    const status = screen.getByRole('status');
    expect(status.textContent?.trim()).toBe('Carregando o texto…');
    // A busy region may keep its changes quiet: the status lives outside it.
    expect(region().contains(status)).toBe(false);
    expect(status.closest('[aria-busy="true"]')).toBe(null);
    expect(retryButton().getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(retryButton());
    await answer(rendered);
    expect(shownLines()).toContain('o que está em cima');
    expect(document.activeElement).toBe(region());
  });

  it('says so when trying again fails too, with the focus on "Tentar de novo"', async () => {
    const rendered = await renderText();
    const refuse = () =>
      rendered.http
        .expectOne(`${BASE}?v=1`)
        .flush(null, { status: 500, statusText: 'Erro' });
    refuse();
    await rendered.view.fixture.whenStable();
    retryButton().focus();
    fireEvent.click(retryButton());
    TestBed.tick();
    refuse();
    await rendered.view.fixture.whenStable();
    expect(screen.getByRole('status').textContent?.trim()).toBe(
      'Não consegui carregar o texto.',
    );
    expect(retryButton().getAttribute('aria-disabled')).toBeNull();
    expect(document.activeElement).toBe(retryButton());
    // A later text that loads (a newer transcript) does not pull the focus anymore.
    retryButton().blur();
    rendered.aimed.set({ mediaId: MEDIA, status: 'done', key: '2' });
    TestBed.tick();
    await answer(rendered, transcriptOf(2), '2');
    expect(shownLines()).toContain('o que está em cima');
    expect(document.activeElement).not.toBe(region());
  });

  it('drops the words of an older version when a new transcript comes (AC-12)', async () => {
    const rendered = await renderText();
    await answer(rendered);
    await playAt(rendered, 40_600);
    expect(painted.get('track-word')).toEqual(['está']);
    const newer = transcriptOf(2, [
      [30, 'outra versão'],
      [40, 'tudo diferente agora aqui'],
    ]);
    rendered.aimed.set({ mediaId: MEDIA, status: 'done', key: '2' });
    TestBed.tick();
    expect(painted.get('track-word')).toEqual([]);
    rendered.http.expectOne(`${BASE}?v=2`).flush(newer.transcript);
    await rendered.view.fixture.whenStable();
    expect(shownLines()).toEqual(['outra versão', 'tudo diferente agora aqui']);
    // Its words have not come: the line plays whole, no word of the old one is painted.
    expect(painted.get('track-word')).toEqual([]);
    for (const asked of rendered.http.match(
      (one) => one.url === `${BASE}/words`,
    ))
      asked.flush(newer.words);
    await rendered.view.fixture.whenStable();
    // At 40.6 s the newer text says "agora" (its third word).
    expect(painted.get('track-word')).toEqual(['agora']);
  });

  it('switches to the whole transcript with the track marked, and back (AC-18)', async () => {
    const rendered = await renderText();
    await answer(rendered);
    await playAt(rendered, 40_600);
    fireEvent.click(
      screen.getByRole('button', { name: 'Ver transcrição completa' }),
    );
    await rendered.view.fixture.whenStable();
    expect(shownLines()).toEqual(LINES.map(([, text]) => text));
    const inside = Array.from(
      region().querySelectorAll('.line.inside'),
      (one) => one.textContent,
    );
    expect(inside).toEqual([
      'ainda antes agora dentro',
      'o que está em cima',
      'sem tempos por palavra',
      'quase fim fora daqui',
    ]);
    expect(painted.get('track-word')).toEqual(['está']);
    // The screen reader hears where the track starts and ends, right by its lines.
    const start = within(region()).getByText('Início da faixa 2');
    const end = within(region()).getByText('Fim da faixa 2');
    expect(start.nextElementSibling?.textContent).toBe(
      'ainda antes agora dentro',
    );
    expect(end.previousElementSibling?.textContent).toBe(
      'quase fim fora daqui',
    );
    expect(start.classList).toContain('visually-hidden');
    fireEvent.click(screen.getByRole('button', { name: 'Ver só a faixa' }));
    await rendered.view.fixture.whenStable();
    expect(shownLines()[0]).toBe('agora dentro');
    expect(within(region()).queryByText(/Início da faixa|Fim da faixa/)).toBe(
      null,
    );
    expect(painted.get('track-word')).toEqual(['está']);
  });

  it('clears its word when it closes', async () => {
    const rendered = await renderText();
    await answer(rendered);
    await playAt(rendered, 40_600);
    rendered.view.fixture.destroy();
    expect(painted.has('track-word')).toBe(false);
  });
});
