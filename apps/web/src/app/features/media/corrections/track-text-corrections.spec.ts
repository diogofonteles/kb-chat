import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import type {
  CorrectionHistory,
  MediaTranscript,
  MediaTranscriptWords,
  Occurrences,
  TranscriptCorrectionResult,
} from '@kb-chat/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '@core/auth/session-store.js';
import { SEARCH_HIGHLIGHTS } from '../transcript/search-highlights.js';
import { CARET_AT_POINT, type TextCaret } from '../transcript/text-caret.js';
import { TrackAudition } from '../tracks/track-audition.js';
import { LONG_PRESS_MS, TrackText } from '../tracks/track-text.js';
import { TrackTextSource } from '../tracks/track-text-source.js';

const MEDIA = '11111111-1111-4111-8111-111111111111';
const BASE = `/api/v1/media/${MEDIA}/transcript`;
const SPAN = { startMs: 60_000, endMs: 120_000 };
const CORRECTION_ID = '22222222-2222-4222-8222-222222222222';

/** Two lines: "Tiuako" at 1:12; "tempo" has no time of its own (AC-43). */
const WORDS: MediaTranscriptWords['words'] = [
  { position: 0, segment: 0, startMs: 70_000, endMs: 71_000, text: 'O' },
  { position: 1, segment: 0, startMs: 71_000, endMs: 72_000, text: 'mestre' },
  { position: 2, segment: 0, startMs: 72_000, endMs: 73_000, text: 'Tiuako' },
  { position: 3, segment: 0, startMs: 73_000, endMs: 74_000, text: 'disse' },
  { position: 4, segment: 1, startMs: 80_000, endMs: 80_500, text: 'sem' },
  { position: 5, segment: 1, startMs: 80_500, endMs: 80_500, text: 'tempo' },
  { position: 6, segment: 1, startMs: 81_000, endMs: 81_500, text: 'aqui' },
];

const SEGMENTS: MediaTranscript['segments'] = [
  { startMs: 70_000, endMs: 74_000, text: 'O mestre Tiuako disse' },
  { startMs: 80_000, endMs: 81_500, text: 'sem tempo aqui' },
];

const transcript = (revision = 0, segments = SEGMENTS): MediaTranscript => ({
  mediaId: MEDIA,
  version: 1,
  revision,
  confidence: 'normal',
  segments,
});

const EMPTY_HISTORY: CorrectionHistory = {
  mediaId: MEDIA,
  total: 0,
  entries: [],
  next: null,
  carry: null,
};

const occurrences = (total: number): Occurrences => ({
  mediaId: MEDIA,
  version: 1,
  revision: 0,
  total,
  inWindow: total,
  occurrences: [],
});

const saved: TranscriptCorrectionResult = {
  correction: {
    id: CORRECTION_ID,
    kind: 'correct',
    state: 'active',
    learned: false,
    version: 1,
    revision: 1,
    position: 2,
    count: 1,
    segment: 0,
    startMs: 72_000,
    endMs: 73_000,
    before: ['Tiuako'],
    after: 'Tiuaco',
    reverts: null,
    carriedTo: null,
    found: null,
    groupId: null,
    authorName: 'Dono',
    mine: true,
    canUndo: true,
    createdAt: '2026-11-09T12:00:00.000Z',
  },
  version: 1,
  revision: 1,
  segments: [{ index: 0, text: 'O mestre Tiuaco disse' }],
};

let http: HttpTestingController | null = null;
let caret: TextCaret | null = null;
/** How often the chosen words are in the recording, as the panel asks (FR-11). */
let occurrenceTotal = 1;
/** The texts the occurrences were asked for (FR-11; KBC-115 FR-5). */
let askedFor: string[] = [];

/** What the fake API answers to reads, and how many of each it answered. */
interface Server {
  revision: number;
  history: CorrectionHistory;
  /** The learning's replacements on the words (KBC-113 FR-5). */
  learned: MediaTranscriptWords['learned'];
  readonly segments: MediaTranscript['segments'];
  readonly words: MediaTranscriptWords['words'];
  readonly served: Record<'transcript' | 'words' | 'history', number>;
}

/**
 * Answers every read in flight until the page is stable, reads that come while waiting too;
 * writes stay to the test.
 */
async function serve(
  controller: HttpTestingController,
  server: Server,
  stable: () => Promise<unknown>,
) {
  let done = false;
  const waiting = stable().then(() => (done = true));
  while (!done) {
    TestBed.tick();
    for (const read of controller.match((one) => one.method === 'GET'))
      answerRead(read, server);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await waiting;
  // Pages of words are no pending task: they come after the page is stable.
  for (let round = 0; round < 3; round++) {
    TestBed.tick();
    for (const read of controller.match((one) => one.method === 'GET'))
      answerRead(read, server);
    await stable();
  }
}

function answerRead(read: TestRequest, server: Server): void {
  const { url } = read.request;
  if (url === BASE) {
    server.served.transcript++;
    read.flush(transcript(server.revision, server.segments));
  } else if (url === `${BASE}/words`) {
    server.served.words++;
    read.flush({
      mediaId: MEDIA,
      version: 1,
      revision: server.revision,
      words: server.words,
      learned: server.learned,
    });
  } else if (url === `${BASE}/corrections`) {
    server.served.history++;
    read.flush(server.history);
  } else if (url === `${BASE}/occurrences`) {
    askedFor.push(read.request.params.get('text') ?? '');
    read.flush(occurrences(occurrenceTotal));
  }
}

async function renderText(
  options: {
    canCorrect?: boolean;
    history?: CorrectionHistory;
    learned?: MediaTranscriptWords['learned'];
    segments?: MediaTranscript['segments'];
    words?: MediaTranscriptWords['words'];
  } = {},
) {
  const painted = new Map<string, number>();
  const audition = {
    positionMs: signal<number | null>(null),
    cuedMs: signal<number | null>(null),
    playing: signal(false),
    seek: vi.fn(),
    play: vi.fn(),
  };
  const view = await render(TrackText, {
    inputs: { span: SPAN, ordinal: 1, regionId: 'texto-1' },
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      TrackTextSource,
      { provide: TrackAudition, useValue: audition },
      {
        provide: SessionStore,
        useValue: {
          can: (feature: string) =>
            feature !== 'media-correct' || (options.canCorrect ?? true),
        },
      },
      { provide: CARET_AT_POINT, useValue: () => caret },
      {
        provide: SEARCH_HIGHLIGHTS,
        useValue: {
          paints: true,
          show: (name: string, ranges: readonly Range[]) =>
            painted.set(name, ranges.length),
          clear: () => undefined,
        },
      },
    ],
  });
  TestBed.inject(TrackTextSource).follow(
    signal({ mediaId: MEDIA, status: 'done' as const, key: '1' }),
  );
  const controller = TestBed.inject(HttpTestingController);
  http = controller;
  const server: Server = {
    revision: 0,
    history: options.history ?? EMPTY_HISTORY,
    learned: options.learned ?? [],
    segments: options.segments ?? SEGMENTS,
    words: options.words ?? WORDS,
    served: { transcript: 0, words: 0, history: 0 },
  };
  const settle = () =>
    serve(controller, server, () => view.fixture.whenStable());
  await settle();
  return { view, audition, http: controller, settle, server, painted };
}

type Rendered = Awaited<ReturnType<typeof renderText>>;

const lineWith = (word: string): HTMLElement => {
  const line = [
    ...screen
      .getByRole('region', { name: 'Texto da faixa 1' })
      .querySelectorAll<HTMLElement>('.line'),
  ].find((one) => one.textContent?.includes(word));
  if (!line) throw new Error(`no line says ${word}`);
  return line;
};

/** A click on a word: the browser says where in the line's text it fell. */
async function clickWord({ settle }: Rendered, word: string) {
  const line = lineWith(word);
  const node = line.firstChild;
  if (!node) throw new Error('a line has its text');
  caret = { node, offset: (line.textContent ?? '').indexOf(word) + 1 };
  fireEvent.click(line);
  await settle();
}

const panel = () => screen.queryByRole('dialog', { name: /Corrigir palavra/ });
const field = () =>
  screen.getByRole<HTMLInputElement>('textbox', { name: 'Texto certo' });

async function type({ settle }: Rendered, text: string) {
  fireEvent.input(field(), { target: { value: text } });
  await settle();
}

const posted = ({ http }: Rendered): TestRequest =>
  http.expectOne(
    (one) => one.method === 'POST' && one.url === `${BASE}/corrections`,
  );

afterEach(() => {
  http?.verify();
  http = null;
  caret = null;
  occurrenceTotal = 1;
  askedFor = [];
});

describe('TrackText: correcting a word (KBC-093)', () => {
  it('AC-16, AC-46: without media-correct, a click moves nothing and opens nothing', async () => {
    const rendered = await renderText({ canCorrect: false });
    await clickWord(rendered, 'Tiuako');
    expect(rendered.audition.seek).not.toHaveBeenCalled();
    expect(panel()).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Procurar palavra' }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: /Correções/ })).toBeNull();
  });

  it('AC-1, AC-23, AC-40, AC-42: a click seeks once to the word and opens the panel on it, its field selected', async () => {
    const rendered = await renderText();
    await clickWord(rendered, 'Tiuako');
    await clickWord(rendered, 'Tiuako');

    expect(rendered.audition.seek).toHaveBeenCalledTimes(1);
    expect(rendered.audition.seek).toHaveBeenCalledWith(72_000, 120_000);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(
      screen.getByRole('dialog', { name: 'Corrigir palavra, Tiuako' }),
    ).toBe(panel());
    expect(field().value).toBe('Tiuako');
    expect(document.activeElement).toBe(field());
    expect(screen.getByText('Áudio em 1:12')).toBeTruthy();
  });

  it('KBC-106: a correction refused below a track of the recording says why', async () => {
    const rendered = await renderText();
    await clickWord(rendered, 'Tiuako');
    await type(rendered, 'Tiuaco');
    fireEvent.keyDown(field(), { key: 'Enter' });
    await rendered.settle();
    posted(rendered).flush(
      { error: { code: 'EDIT_ABOVE_YOUR_LEVEL', message: 'x' } },
      { status: 403, statusText: 'Forbidden' },
    );
    await rendered.settle();
    expect(
      screen.getAllByText(
        'Esta gravação tem faixas acima do seu nível. Só quem tem todos os níveis dela pode editá-la.',
      ).length,
    ).toBeGreaterThan(0);
  });

  it('AC-1, FR-3: Enter saves; the text is read again and "Palavra corrigida." offers Desfazer', async () => {
    const rendered = await renderText();
    await clickWord(rendered, 'Tiuako');
    await type(rendered, 'Tiuaco');
    fireEvent.keyDown(field(), { key: 'Enter' });
    await rendered.settle();

    const request = posted(rendered);
    expect(request.request.body).toEqual({
      version: 1,
      position: 2,
      count: 1,
      expected: ['Tiuako'],
      text: 'Tiuaco',
    });
    expect(screen.getByRole('button', { name: 'Salvando…' })).toHaveProperty(
      'disabled',
      true,
    );
    rendered.server.revision = 1;
    request.flush(saved, { status: 201, statusText: 'Created' });
    await rendered.settle();

    expect(rendered.server.served.transcript).toBe(2);
    expect(rendered.server.served.history).toBe(2);
    expect(panel()).toBeNull();
    expect(screen.getAllByText('Palavra corrigida.').length).toBeGreaterThan(0);
    expect(document.activeElement).toBe(
      screen.getByRole('region', { name: 'Texto da faixa 1' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer' }));
    await rendered.settle();
    rendered.server.revision = 2;
    rendered.http
      .expectOne(`${BASE}/corrections/${CORRECTION_ID}/undo`)
      .flush({ ...saved, revision: 2 }, { status: 201, statusText: 'Created' });
    await rendered.settle();
    expect(rendered.server.served.transcript).toBe(3);
    expect(screen.getAllByText('Correção desfeita.').length).toBeGreaterThan(0);
  });

  it('AC-44: with a changed text, another word does not move the audio nor the panel', async () => {
    const rendered = await renderText();
    await clickWord(rendered, 'Tiuako');
    await type(rendered, 'Tiuaco');
    await clickWord(rendered, 'mestre');

    expect(rendered.audition.seek).toHaveBeenCalledTimes(1);
    expect(field().value).toBe('Tiuaco');
    expect(
      screen.getByText(
        'Salve ou cancele esta correção antes de escolher outra palavra.',
      ),
    ).toBeTruthy();

    await type(rendered, 'Tiuako');
    await clickWord(rendered, 'mestre');
    expect(rendered.audition.seek).toHaveBeenLastCalledWith(71_000, 120_000);
    expect(field().value).toBe('mestre');
  });

  it('AC-45, FR-2: ◀ Anterior and Próxima ▶ go to the word beside and take the audio there; Ouvir a palavra plays only it', async () => {
    const rendered = await renderText();
    await clickWord(rendered, 'Tiuako');
    fireEvent.click(screen.getByRole('button', { name: 'Próxima ▶' }));
    await rendered.settle();
    expect(field().value).toBe('disse');
    expect(rendered.audition.seek).toHaveBeenLastCalledWith(73_000, 120_000);
    expect(screen.getByRole('button', { name: 'Próxima ▶' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: '◀ Anterior' }));
    await rendered.settle();
    expect(field().value).toBe('Tiuako');
    fireEvent.click(screen.getByRole('button', { name: 'Ouvir a palavra' }));
    expect(rendered.audition.play).toHaveBeenCalledWith({
      fromMs: 71_000,
      toMs: 74_000,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apagar palavra' }));
    await rendered.settle();
    expect(posted(rendered).request.body).toMatchObject({ text: '' });
  });

  it('AC-43: a word with no time opens the panel without moving the audio', async () => {
    const rendered = await renderText();
    await clickWord(rendered, 'tempo');
    expect(rendered.audition.seek).not.toHaveBeenCalled();
    expect(field().value).toBe('tempo');
    expect(
      screen.getByRole('button', { name: 'Ouvir a palavra' }),
    ).toHaveProperty('disabled', true);
    expect(
      screen.getByText('Esta palavra não tem tempo na transcrição.'),
    ).toBeTruthy();
  });

  it('AC-4, AC-6: Incluir a próxima joins words of the segment, never past its end', async () => {
    const rendered = await renderText();
    await clickWord(rendered, 'Tiuako');
    fireEvent.click(screen.getByRole('button', { name: 'Incluir a próxima' }));
    await rendered.settle();

    expect(field().value).toBe('Tiuako disse');
    expect(
      screen.getByRole('button', { name: 'Incluir a próxima' }),
    ).toHaveProperty('disabled', true);
    expect(
      screen.getByText(/A correção fica dentro de um trecho/),
    ).toBeTruthy();
    await type(rendered, 'Tiuaco disse');
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await rendered.settle();
    const request = posted(rendered);
    expect(request.request.body).toMatchObject({
      position: 2,
      count: 2,
      expected: ['Tiuako', 'disse'],
    });
    request.flush(null, { status: 500, statusText: 'Server Error' });
    await rendered.settle();
    expect(
      screen.getByText('Não consegui salvar. Sua correção continua aqui.'),
    ).toBeTruthy();
    expect(field().value).toBe('Tiuaco disse');
  });

  it('AC-12: a word someone else changed shows who, keeps the typed text, and "Salvar a minha" saves over it', async () => {
    const rendered = await renderText();
    await clickWord(rendered, 'Tiuako');
    await type(rendered, 'Tiuacô');
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await rendered.settle();
    posted(rendered).flush(
      {
        error: {
          code: 'CORRECTION_CONFLICT',
          message: 'changed',
          details: {
            reason: 'word-changed',
            current: ['Tiuaco'],
            authorName: 'Maria',
          },
        },
      },
      { status: 409, statusText: 'Conflict' },
    );
    await rendered.settle();

    expect(
      screen.getByText(
        'Maria corrigiu esta palavra para «Tiuaco» agora há pouco.',
      ),
    ).toBeTruthy();
    expect(field().value).toBe('Tiuacô');
    expect(
      screen.getByRole('button', { name: 'Usar a de Maria' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Salvar a minha' }));
    await rendered.settle();
    const again = posted(rendered);
    expect(again.request.body).toMatchObject({
      expected: ['Tiuaco'],
      text: 'Tiuacô',
    });
    again.flush(
      { error: { code: 'TRANSCRIPT_CHANGED', message: 'again' } },
      { status: 412, statusText: 'Precondition Failed' },
    );
    await rendered.settle();
    // AC-15: the recording was transcribed again; the text is read again.
    expect(
      screen.getByText(
        'A transcrição foi refeita. Confira a palavra no texto novo.',
      ),
    ).toBeTruthy();
    expect(rendered.server.served.transcript).toBe(2);
  });

  it('AC-12: with no name, Usar a outra; Enter on a conflict is Salvar a minha', async () => {
    const rendered = await renderText();
    await clickWord(rendered, 'Tiuako');
    await type(rendered, 'Tiuacô');
    fireEvent.keyDown(field(), { key: 'Enter' });
    await rendered.settle();
    posted(rendered).flush(
      {
        error: {
          code: 'CORRECTION_CONFLICT',
          message: 'changed',
          details: { reason: 'word-changed', current: ['Tiuaco'] },
        },
      },
      { status: 409, statusText: 'Conflict' },
    );
    await rendered.settle();
    expect(screen.getByRole('button', { name: 'Usar a outra' })).toBeTruthy();

    fireEvent.keyDown(field(), { key: 'Enter' });
    await rendered.settle();
    const mine = posted(rendered);
    expect(mine.request.body).toMatchObject({
      expected: ['Tiuaco'],
      text: 'Tiuacô',
    });
    mine.flush(saved, { status: 201, statusText: 'Created' });
    await rendered.settle();
  });

  it('a refusal a retry cannot change says so, with no Tentar de novo', async () => {
    const rendered = await renderText();
    await clickWord(rendered, 'Tiuako');
    await type(rendered, 'Tiuaco');
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await rendered.settle();
    posted(rendered).flush(
      {
        error: {
          code: 'CORRECTION_CONFLICT',
          message: 'no',
          details: { reason: 'not-aligned' },
        },
      },
      { status: 409, statusText: 'Conflict' },
    );
    await rendered.settle();

    expect(
      screen.getByText(
        'Este trecho não pode ser corrigido aqui. Avise quem cuida do acervo.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Salvar' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.keyDown(field(), { key: 'Enter' });
    await rendered.settle();
  });

  it('AC-7, AC-8: the same text cannot be saved, and a long or broken one is said next to the field', async () => {
    const rendered = await renderText();
    await clickWord(rendered, 'Tiuako');
    expect(screen.getByRole('button', { name: 'Salvar' })).toHaveProperty(
      'disabled',
      true,
    );
    await type(rendered, ' Tiuako ');
    expect(screen.getByRole('button', { name: 'Salvar' })).toHaveProperty(
      'disabled',
      true,
    );
    await type(rendered, 'x'.repeat(81));
    expect(
      screen.getByText('Use até 80 caracteres, numa linha só.'),
    ).toBeTruthy();
    expect(field().getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('button', { name: 'Salvar' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('AC-23: Esc closes and gives the focus back to the text; Tab stays inside', async () => {
    const rendered = await renderText();
    await clickWord(rendered, 'Tiuako');
    const buttons = screen
      .getAllByRole('button')
      .filter((one) => panel()?.contains(one) && !one.hasAttribute('disabled'));
    buttons.at(-1)?.focus();
    fireEvent.keyDown(buttons.at(-1) as HTMLElement, { key: 'Tab' });
    expect(document.activeElement).toBe(field());
    fireEvent.keyDown(field(), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(buttons.at(-1));

    fireEvent.keyDown(field(), { key: 'Escape' });
    await rendered.settle();
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('region', { name: 'Texto da faixa 1' }),
    );
  });

  it('AC-22, AC-45, FR-4: Procurar palavra leads to the word by keyboard, and the focus comes back to it', async () => {
    occurrenceTotal = 12;
    const rendered = await renderText();
    fireEvent.click(screen.getByRole('button', { name: 'Procurar palavra' }));
    await rendered.settle();
    fireEvent.input(
      screen.getByRole('searchbox', { name: 'Procurar palavra' }),
      {
        target: { value: 'tiua' },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    await rendered.settle();
    const hit = screen.getByRole('button', { name: /1:12/ });
    expect(screen.getByText('1 ocorrência')).toBeTruthy();
    fireEvent.click(hit);
    await rendered.settle();

    expect(rendered.audition.seek).toHaveBeenCalledWith(72_000, 120_000);
    expect(
      screen.getByRole('dialog', { name: 'Corrigir palavra, Tiuako' }),
    ).toBe(panel());
    expect(
      screen.getByText('Esta palavra aparece 12 vezes na gravação'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await rendered.settle();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /1:12/ }),
    );
  });

  it('FR-8, AC-19: a new version says what was carried and what was not, with Ver', async () => {
    await renderText({
      history: {
        ...EMPTY_HISTORY,
        total: 2,
        carry: { version: 2, carried: 1, notCarried: 1 },
      },
    });
    expect(
      screen.getByText(
        /1 correção reaplicada; 1 não coube na transcrição nova/,
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Correções (2)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ver' })).toBeTruthy();
  });
});

describe('TrackText: a word the learning replaced (KBC-113)', () => {
  const LEARNED = [
    {
      position: 2,
      count: 1,
      correctionId: CORRECTION_ID,
      before: 'Tiuacô',
    },
  ];

  it('AC-17, FR-6: the word is marked, and the panel says it was learned, with Desfazer', async () => {
    const rendered = await renderText({ learned: LEARNED });
    expect(rendered.painted.get('learned-word')).toBe(1);
    // Said in words too, not only drawn (review round 1).
    expect(
      screen.getByText(
        '1 palavra corrigida pelo aprendizado (sublinhado pontilhado)',
      ),
    ).toBeTruthy();

    await clickWord(rendered, 'Tiuako');

    expect(panel()).not.toBeNull();
    expect(
      screen.getByText('Corrigida pelo aprendizado · era «Tiuacô»'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer' }));
    await rendered.settle();
    const undo = rendered.http.expectOne(
      (one) =>
        one.method === 'POST' &&
        one.url === `${BASE}/corrections/${CORRECTION_ID}/undo`,
    );
    rendered.server.revision = 2;
    rendered.server.learned = [];
    undo.flush({ ...saved, revision: 2 });
    await rendered.settle();
    expect(panel()).toBeNull();
    expect(
      screen.getAllByText('Palavra voltou a «Tiuacô».').length,
    ).toBeGreaterThan(0);
  });

  it('a word the person corrected has no learned note', async () => {
    const rendered = await renderText({ learned: LEARNED });
    expect(rendered.painted.get('learned-word')).toBe(1);
    await clickWord(rendered, 'disse');
    expect(panel()).not.toBeNull();
    expect(screen.queryByText(/Corrigida pelo aprendizado/)).toBeNull();
  });

  it('without media-correct the mark is there and nothing opens', async () => {
    const rendered = await renderText({ canCorrect: false, learned: LEARNED });
    expect(rendered.painted.get('learned-word')).toBe(1);
    await clickWord(rendered, 'Tiuako');
    expect(panel()).toBeNull();
  });
});

/** A restricted part between two lines (KBC-106), and a line of seven words. */
const SPAN_SEGMENTS: MediaTranscript['segments'] = [
  SEGMENTS[0] ?? { startMs: 70_000, endMs: 74_000, text: '' },
  { startMs: 76_000, endMs: 79_000, text: '', restricted: true },
  {
    startMs: 90_000,
    endMs: 97_000,
    text: 'um dois três quatro cinco seis sete',
  },
];
const SEVEN = ['um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete'];
const SPAN_WORDS: MediaTranscriptWords['words'] = [
  ...WORDS.filter((word) => word.segment === 0),
  ...SEVEN.map((text, index) => ({
    position: 8 + index,
    segment: 2,
    startMs: 90_000 + index * 1_000,
    endMs: 90_500 + index * 1_000,
    text,
  })),
];

const renderSpans = (options: { canCorrect?: boolean } = {}) =>
  renderText({ ...options, segments: SPAN_SEGMENTS, words: SPAN_WORDS });

const region = () => screen.getByRole('region', { name: 'Texto da faixa 1' });

/** The browser's caret on a word: where a pointer at it falls in the text. */
function caretOn(word: string): HTMLElement {
  const line = lineWith(word);
  const node = line.firstChild;
  if (!node) throw new Error('a line has its text');
  caret = { node, offset: (line.textContent ?? '').indexOf(word) + 1 };
  return line;
}

/** The restricted part's line: it has no text, so the caret falls on the element. */
function caretOnRestricted(): HTMLElement {
  const line = [...region().querySelectorAll<HTMLElement>('.line')].find(
    (one) => one.textContent === '',
  );
  if (!line) throw new Error('no restricted line');
  caret = { node: line, offset: 0 };
  return line;
}

const pointer = (type: 'mouse' | 'touch', x: number) => ({
  pointerId: 7,
  pointerType: type,
  isPrimary: true,
  button: 0,
  clientX: x,
  clientY: 0,
});

/** Mouse down on one word, moved, and up on another; the browser then clicks. */
async function drag(
  { settle }: Rendered,
  from: string,
  to: string | (() => HTMLElement),
) {
  fireEvent.pointerDown(caretOn(from), pointer('mouse', 0));
  const target = typeof to === 'string' ? caretOn(to) : to();
  fireEvent.pointerMove(target, pointer('mouse', 40));
  fireEvent.pointerUp(target, pointer('mouse', 40));
  fireEvent.click(target, { clientX: 40, clientY: 0 });
  await settle();
}

async function shiftArrow(
  { settle }: Rendered,
  key: 'ArrowRight' | 'ArrowLeft',
) {
  fireEvent.keyDown(region(), { key, shiftKey: true });
  await settle();
}

const said = () =>
  screen
    .getAllByRole('status')
    .map((one) => one.textContent ?? '')
    .join(' | ');

describe('TrackText: choosing many words at once (KBC-115)', () => {
  it('AC-1, FR-5, FR-6: a mouse drag over two words opens the panel on both, the audio at the first', async () => {
    occurrenceTotal = 2;
    const rendered = await renderSpans();
    await drag(rendered, 'mestre', 'Tiuako');

    expect(
      screen.getByRole('dialog', { name: 'Corrigir palavras, mestre Tiuako' }),
    ).toBeTruthy();
    expect(field().value).toBe('mestre Tiuako');
    expect(document.activeElement).toBe(field());
    expect(
      screen.getByRole('button', { name: 'Apagar palavras' }),
    ).toBeTruthy();
    expect(rendered.audition.seek).toHaveBeenCalledTimes(1);
    expect(rendered.audition.seek).toHaveBeenCalledWith(71_000, 120_000);
    expect(rendered.painted.get('correcting-word')).toBe(1);
    expect(said()).toContain(
      '2 palavras escolhidas: mestre Tiuako. Áudio em 1:11',
    );
    expect(
      screen.getByText('Este trecho aparece 2 vezes na gravação'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Corrigir todas' }));
    await rendered.settle();
    expect(askedFor).toContain('mestre Tiuako');
    expect(screen.getByText('Ocorrências de «mestre Tiuako»')).toBeTruthy();
  });

  it('BR-1: a drag to the left keeps its anchor, and Shift+click stretches from it', async () => {
    const rendered = await renderSpans();
    await drag(rendered, 'disse', 'mestre');
    expect(field().value).toBe('mestre Tiuako disse');
    expect(rendered.audition.seek).toHaveBeenLastCalledWith(71_000, 120_000);

    fireEvent.click(caretOn('Tiuako'), { shiftKey: true });
    await rendered.settle();
    expect(field().value).toBe('Tiuako disse');
  });

  it('AC-3, AC-5, BR-2: a drag into the restricted part stops at the edge of its own line and says why', async () => {
    const rendered = await renderSpans();
    await drag(rendered, 'Tiuako', caretOnRestricted);

    expect(field().value).toBe('Tiuako disse');
    expect(said()).toContain(
      'A correção fica dentro de um trecho, com até 5 palavras.',
    );
    fireEvent.keyDown(field(), { key: 'Enter' });
    await rendered.settle();
    expect(screen.getByRole('button', { name: 'Salvar' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('AC-3: a drag from the line below up into the restricted part stops at its own first word', async () => {
    const rendered = await renderSpans();
    await drag(rendered, 'três', caretOnRestricted);
    expect(field().value).toBe('um dois três');
  });

  it('AC-4: a drag over seven words keeps the first five', async () => {
    const rendered = await renderSpans();
    await drag(rendered, 'um', 'sete');
    expect(field().value).toBe('um dois três quatro cinco');
    expect(said()).toContain(
      'A correção fica dentro de um trecho, com até 5 palavras.',
    );
  });

  it('AC-6, BR-4: Shift+click stretches the open choice, keeps the typed text and leaves the audio', async () => {
    const rendered = await renderSpans();
    await clickWord(rendered, 'mestre');
    await type(rendered, 'Mestre');
    fireEvent.click(caretOn('disse'), { shiftKey: true });
    await rendered.settle();

    expect(
      screen.getByRole('dialog', {
        name: 'Corrigir palavras, mestre Tiuako disse',
      }),
    ).toBeTruthy();
    expect(field().value).toBe('Mestre');
    expect(rendered.audition.seek).toHaveBeenCalledTimes(1);
  });

  it('FR-3: Shift+click with no panel open is a click', async () => {
    const rendered = await renderSpans();
    fireEvent.click(caretOn('Tiuako'), { shiftKey: true });
    await rendered.settle();
    expect(field().value).toBe('Tiuako');
  });

  it('FR-3, BR-1: Shift+click on another line stops at the edge of the open one', async () => {
    const rendered = await renderSpans();
    await clickWord(rendered, 'Tiuako');
    fireEvent.click(caretOn('dois'), { shiftKey: true });
    await rendered.settle();
    expect(field().value).toBe('Tiuako disse');
  });

  it('AC-7, FR-4: Shift+→ on the text, from the word chosen last, says each step and opens on Shift release', async () => {
    const rendered = await renderSpans();
    await clickWord(rendered, 'mestre');
    fireEvent.keyDown(field(), { key: 'Escape' });
    await rendered.settle();
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(region());

    await shiftArrow(rendered, 'ArrowRight');
    expect(said()).toContain('mestre Tiuako');
    expect(panel()).toBeNull();
    expect(rendered.painted.get('correcting-word')).toBe(1);
    await shiftArrow(rendered, 'ArrowRight');
    expect(said()).toContain('mestre Tiuako disse');
    await shiftArrow(rendered, 'ArrowRight');
    expect(said()).toContain('A correção fica dentro de um trecho');

    fireEvent.keyUp(region(), { key: 'Shift' });
    await rendered.settle();
    expect(field().value).toBe('mestre Tiuako disse');
    expect(document.activeElement).toBe(field());
  });

  it('FR-4: with the panel open, Shift+← on the text shrinks the choice from its anchor', async () => {
    const rendered = await renderSpans();
    await drag(rendered, 'O', 'Tiuako');
    region().focus();
    await shiftArrow(rendered, 'ArrowLeft');
    fireEvent.keyUp(region(), { key: 'Shift' });
    await rendered.settle();
    expect(field().value).toBe('O mestre');
  });

  it('FR-4: with nothing chosen yet, Shift+→ starts at the first word of the text', async () => {
    const rendered = await renderSpans();
    region().focus();
    await shiftArrow(rendered, 'ArrowRight');
    fireEvent.keyUp(region(), { key: 'Shift' });
    await rendered.settle();
    expect(field().value).toBe('O mestre');
  });

  it('AC-8: Esc before releasing Shift gives up: nothing opens and the mark goes', async () => {
    const rendered = await renderSpans();
    region().focus();
    await shiftArrow(rendered, 'ArrowRight');
    fireEvent.keyDown(region(), { key: 'Escape' });
    fireEvent.keyUp(region(), { key: 'Shift' });
    await rendered.settle();
    expect(panel()).toBeNull();
    expect(rendered.painted.get('correcting-word')).toBe(0);
  });

  it('AC-10, BR-3: with a changed text, a drag over other words moves nothing', async () => {
    const rendered = await renderSpans();
    await clickWord(rendered, 'Tiuako');
    await type(rendered, 'Tiuaco');
    await drag(rendered, 'um', 'dois');

    expect(field().value).toBe('Tiuaco');
    expect(rendered.audition.seek).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(
        'Salve ou cancele esta correção antes de escolher outra palavra.',
      ),
    ).toBeTruthy();
  });

  it('AC-11, BR-5: without media-correct, a drag opens nothing and moves nothing', async () => {
    const rendered = await renderSpans({ canCorrect: false });
    await drag(rendered, 'mestre', 'Tiuako');
    expect(panel()).toBeNull();
    expect(rendered.audition.seek).not.toHaveBeenCalled();
  });

  it('AC-12, KBC-106: saving many words below a track of the recording says why', async () => {
    const rendered = await renderSpans();
    await drag(rendered, 'mestre', 'Tiuako');
    await type(rendered, 'Mestre Tiuaco');
    fireEvent.keyDown(field(), { key: 'Enter' });
    await rendered.settle();
    const request = posted(rendered);
    expect(request.request.body).toMatchObject({
      position: 1,
      count: 2,
      expected: ['mestre', 'Tiuako'],
      text: 'Mestre Tiuaco',
    });
    request.flush(
      { error: { code: 'EDIT_ABOVE_YOUR_LEVEL', message: 'x' } },
      { status: 403, statusText: 'Forbidden' },
    );
    await rendered.settle();
    expect(
      screen.getAllByText(
        'Esta gravação tem faixas acima do seu nível. Só quem tem todos os níveis dela pode editá-la.',
      ).length,
    ).toBeGreaterThan(0);
  });

  it('AC-9, FR-2: a finger held on a word, then moved, chooses the words', async () => {
    const rendered = await renderSpans();
    fireEvent.pointerDown(caretOn('mestre'), pointer('touch', 0));
    await new Promise((resolve) => setTimeout(resolve, LONG_PRESS_MS + 50));
    await rendered.settle();
    expect(rendered.painted.get('correcting-word')).toBe(1);
    const target = caretOn('Tiuako');
    fireEvent.pointerMove(target, pointer('touch', 40));
    fireEvent.pointerUp(target, pointer('touch', 40));
    await rendered.settle();
    expect(field().value).toBe('mestre Tiuako');
  });

  it('AC-9, FR-2: a finger that moves before the long press scrolls, and nothing is chosen', async () => {
    const rendered = await renderSpans();
    fireEvent.pointerDown(caretOn('mestre'), pointer('touch', 0));
    fireEvent.pointerMove(caretOn('mestre'), {
      ...pointer('touch', 0),
      clientY: 30,
    });
    await new Promise((resolve) => setTimeout(resolve, LONG_PRESS_MS + 50));
    await rendered.settle();
    // The swipe ended the press: the long press never comes, nothing is painted.
    expect(rendered.painted.get('correcting-word') ?? 0).toBe(0);
    fireEvent.pointerUp(caretOn('mestre'), {
      ...pointer('touch', 0),
      clientY: 30,
    });
    await rendered.settle();
    expect(panel()).toBeNull();
  });

  it('a mouse press that does not move is a click on one word', async () => {
    const rendered = await renderSpans();
    const line = caretOn('Tiuako');
    fireEvent.pointerDown(line, pointer('mouse', 0));
    fireEvent.pointerUp(line, pointer('mouse', 2));
    fireEvent.click(line, { clientX: 2, clientY: 0 });
    await rendered.settle();
    expect(field().value).toBe('Tiuako');
  });

  /** A finger held on "mestre" until the long press, then moved to "Tiuako". */
  async function holdAndMove(rendered: Rendered) {
    fireEvent.pointerDown(caretOn('mestre'), pointer('touch', 0));
    await new Promise((resolve) => setTimeout(resolve, LONG_PRESS_MS + 50));
    await rendered.settle();
    const target = caretOn('Tiuako');
    fireEvent.pointerMove(target, pointer('touch', 40));
    await rendered.settle();
    return target;
  }

  it('IMP-1: a second finger during the choice is ignored; the first one still ends it', async () => {
    const rendered = await renderSpans();
    const target = await holdAndMove(rendered);
    fireEvent.pointerDown(caretOn('dois'), {
      ...pointer('touch', 90),
      pointerId: 8,
      isPrimary: false,
    });
    fireEvent.pointerDown(caretOn('dois'), {
      ...pointer('mouse', 90),
      pointerId: 9,
    });
    await rendered.settle();
    expect(rendered.painted.get('correcting-word')).toBe(1);
    fireEvent.pointerUp(target, pointer('touch', 40));
    await rendered.settle();
    expect(field().value).toBe('mestre Tiuako');
  });

  it('IMP-1: a cancelled press or a lost capture takes the mark away', async () => {
    const rendered = await renderSpans();
    await holdAndMove(rendered);
    fireEvent.pointerCancel(region(), pointer('touch', 40));
    await rendered.settle();
    expect(rendered.painted.get('correcting-word')).toBe(0);

    await holdAndMove(rendered);
    expect(rendered.painted.get('correcting-word')).toBe(1);
    fireEvent.lostPointerCapture(region(), pointer('touch', 40));
    await rendered.settle();
    expect(rendered.painted.get('correcting-word')).toBe(0);
    expect(panel()).toBeNull();
  });

  it('QA-2: Esc during a mouse drag gives up: nothing opens and the mark goes', async () => {
    const rendered = await renderSpans();
    fireEvent.pointerDown(caretOn('mestre'), pointer('mouse', 0));
    const target = caretOn('disse');
    fireEvent.pointerMove(target, pointer('mouse', 40));
    await rendered.settle();
    expect(rendered.painted.get('correcting-word')).toBe(1);
    fireEvent.keyDown(region(), { key: 'Escape' });
    fireEvent.pointerUp(target, pointer('mouse', 40));
    fireEvent.click(target, { clientX: 40, clientY: 0 });
    await rendered.settle();
    expect(panel()).toBeNull();
    expect(rendered.painted.get('correcting-word')).toBe(0);
  });

  /** The touchmove listeners that are not passive: the browser waits for them. */
  function blockingTouchmoves(added: { mock: { calls: unknown[][] } }): number {
    return added.mock.calls.filter(
      ([name, , options]) =>
        name === 'touchmove' &&
        typeof options === 'object' &&
        options !== null &&
        (options as AddEventListenerOptions).passive === false,
    ).length;
  }

  it('IMP-2: without media-correct, every touch listener of the text is passive', async () => {
    const added = vi.spyOn(HTMLElement.prototype, 'addEventListener');
    await renderSpans({ canCorrect: false });
    expect(blockingTouchmoves(added)).toBe(0);
    added.mockRestore();
  });

  it('IMP-2: whoever corrects gets one touch listener that may stop scrolling, once the text is there', async () => {
    const added = vi.spyOn(HTMLElement.prototype, 'addEventListener');
    await renderSpans();
    expect(blockingTouchmoves(added)).toBe(1);
    added.mockRestore();
  });

  it('IMP-3: a double click keeps the browser selection for copying; a single press does not', async () => {
    await renderSpans();
    const line = caretOn('Tiuako');
    const selectStart = () => {
      const event = new Event('selectstart', {
        bubbles: true,
        cancelable: true,
      });
      line.firstChild?.dispatchEvent(event);
      return event.defaultPrevented;
    };
    fireEvent.pointerDown(line, pointer('mouse', 0));
    fireEvent.mouseDown(line, { detail: 1 });
    expect(selectStart()).toBe(true);
    fireEvent.pointerUp(line, pointer('mouse', 0));

    fireEvent.pointerDown(line, pointer('mouse', 0));
    fireEvent.mouseDown(line, { detail: 2 });
    expect(selectStart()).toBe(false);
    fireEvent.pointerMove(caretOn('disse'), pointer('mouse', 40));
    expect(panel()).toBeNull();
  });

  /** The browser's own selection over `text` in its line. */
  function selectInLine(text: string): void {
    const line = lineWith(text);
    const node = line.firstChild;
    if (!node) throw new Error('a line has its text');
    const at = (line.textContent ?? '').indexOf(text);
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + text.length);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  it('IMP-3, KBC-093 FR-2: with a stretch selected in a line, a click starts the choice from it', async () => {
    const rendered = await renderSpans();
    selectInLine('mestre Tiuako');
    fireEvent.click(caretOn('Tiuako'));
    await rendered.settle();
    expect(field().value).toBe('mestre Tiuako');
    document.getSelection()?.removeAllRanges();
  });

  it('FR-3: Shift+click with no panel and a browser selection is still one word', async () => {
    const rendered = await renderSpans();
    selectInLine('O mestre Tiuako');
    fireEvent.click(caretOn('Tiuako'), { shiftKey: true });
    await rendered.settle();
    expect(field().value).toBe('Tiuako');
  });

  it('BR-4: after Incluir a anterior and a próxima, Shift+← stretches from the far end, keeping all', async () => {
    const rendered = await renderSpans();
    await clickWord(rendered, 'Tiuako');
    fireEvent.click(screen.getByRole('button', { name: 'Incluir a anterior' }));
    await rendered.settle();
    fireEvent.click(screen.getByRole('button', { name: 'Incluir a próxima' }));
    await rendered.settle();
    expect(field().value).toBe('mestre Tiuako disse');
    region().focus();
    await shiftArrow(rendered, 'ArrowLeft');
    fireEvent.keyUp(region(), { key: 'Shift' });
    await rendered.settle();
    expect(field().value).toBe('O mestre Tiuako disse');
  });

  it('BR-3: with a changed text, a drag starting on the open word says to save or cancel first', async () => {
    const rendered = await renderSpans();
    await clickWord(rendered, 'mestre');
    await type(rendered, 'Mestre');
    await drag(rendered, 'mestre', 'disse');
    expect(field().value).toBe('Mestre');
    expect(
      screen.getByText(
        'Salve ou cancele esta correção antes de escolher outra palavra.',
      ),
    ).toBeTruthy();
  });

  it('QA-1: the cut is said once, in sentences, before the audio', async () => {
    const rendered = await renderSpans();
    await drag(rendered, 'um', 'sete');
    expect(said()).toContain(
      '5 palavras escolhidas: um dois três quatro cinco. A correção fica dentro de um trecho, com até 5 palavras. Áudio em 1:30',
    );
  });

  it('QA-6: saving many words says "Palavras corrigidas."', async () => {
    const rendered = await renderSpans();
    await drag(rendered, 'mestre', 'Tiuako');
    await type(rendered, 'Mestre Tiuaco');
    fireEvent.keyDown(field(), { key: 'Enter' });
    await rendered.settle();
    const correction = saved.correction;
    if (!correction) throw new Error('the saved fixture has its correction');
    posted(rendered).flush(
      { ...saved, correction: { ...correction, position: 1, count: 2 } },
      { status: 201, statusText: 'Created' },
    );
    await rendered.settle();
    expect(screen.getAllByText('Palavras corrigidas.').length).toBeGreaterThan(
      0,
    );
  });

  it('the hint says every way to choose several words', async () => {
    const rendered = await renderSpans();
    await clickWord(rendered, 'Tiuako');
    expect(
      screen.getByText(
        'Para escolher várias palavras, arraste sobre elas, use Shift+clique ou Shift+setas no texto.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Para escolher várias palavras, segure o dedo numa palavra e arraste.',
      ),
    ).toBeTruthy();
  });
});
