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
import { TrackText } from '../tracks/track-text.js';
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

const transcript = (revision = 0): MediaTranscript => ({
  mediaId: MEDIA,
  version: 1,
  revision,
  confidence: 'normal',
  segments: [
    { startMs: 70_000, endMs: 74_000, text: 'O mestre Tiuako disse' },
    { startMs: 80_000, endMs: 81_500, text: 'sem tempo aqui' },
  ],
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

/** What the fake API answers to reads, and how many of each it answered. */
interface Server {
  revision: number;
  history: CorrectionHistory;
  /** The learning's replacements on the words (KBC-113 FR-5). */
  learned: MediaTranscriptWords['learned'];
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
    read.flush(transcript(server.revision));
  } else if (url === `${BASE}/words`) {
    server.served.words++;
    read.flush({
      mediaId: MEDIA,
      version: 1,
      revision: server.revision,
      words: WORDS,
      learned: server.learned,
    });
  } else if (url === `${BASE}/corrections`) {
    server.served.history++;
    read.flush(server.history);
  } else if (url === `${BASE}/occurrences`) {
    read.flush(occurrences(occurrenceTotal));
  }
}

async function renderText(
  options: {
    canCorrect?: boolean;
    history?: CorrectionHistory;
    learned?: MediaTranscriptWords['learned'];
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
