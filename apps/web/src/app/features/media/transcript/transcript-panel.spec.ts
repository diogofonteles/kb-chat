import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { MediaTranscript } from '@kb-chat/contracts';
import { fireEvent, render, screen } from '@testing-library/angular';
import {
  MEDIA_ELEMENT_FACTORY,
  MediaEngine,
} from '@core/media/media-engine.js';
import { ANIMATION_FRAMES } from '@core/media/playback-clock.js';
import { PlayerAnnouncer } from '@core/media/player-announcer.js';
import { EMPTY } from 'rxjs';
import {
  fakeMediaElement,
  type FakeMedia,
} from '../../../testing/fake-media-element.js';
import type { PassageFocus } from '../search-hit/passage-focus.js';
import { SEARCH_HIGHLIGHTS } from './search-highlights.js';
import { CARET_AT_POINT } from './text-caret.js';
import {
  TRANSCRIPT_SEARCH_DEBOUNCE_MS,
  TranscriptPanel,
} from './transcript-panel.js';

const MEDIA = '11111111-1111-4111-8111-111111111111';

const transcriptOf = (
  overrides: Partial<MediaTranscript> = {},
): MediaTranscript => ({
  mediaId: MEDIA,
  version: 1,
  confidence: 'normal',
  segments: [
    { startMs: 0, endMs: 4_000, text: 'Existia um rei chamado Salomão.' },
    { startMs: 5_000, endMs: 9_000, text: 'Ele tinha uma conselheira.' },
    { startMs: 10_000, endMs: 14_000, text: 'Salomao era sábio.' },
    {
      startMs: 1_200_000,
      endMs: 1_204_000,
      text: 'No minuto vinte, o vegetal.',
    },
    { startMs: 1_205_000, endMs: 1_209_000, text: 'E SALOMÃO voltou.' },
  ],
  ...overrides,
});

/** What the search painted last, per highlight, as the texts of its ranges. */
const painted = new Map<string, string[]>();
/** Every paint of the spoken word, to count the writes. */
const wordPaints: string[][] = [];
/** Where a click lands, as the browser's caret would say (there is no layout here). */
let wordByWordOption = false;
let caretText = '';
let caretOffset = 0;

function clickWord(text: string, offset: number): void {
  caretText = text;
  caretOffset = offset;
  fireEvent.click(screen.getByText(text), { detail: 1 });
}

async function renderPanel(
  transcript = transcriptOf(),
  debounceMs = 0,
  passage: PassageFocus | null = null,
) {
  localStorage.clear();
  painted.clear();
  wordPaints.length = 0;
  const media: FakeMedia = fakeMediaElement();
  const view = await render(TranscriptPanel, {
    inputs: {
      transcript,
      title: 'Palestra de 1998',
      passage,
      wordByWord: wordByWordOption,
    },
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      {
        provide: CARET_AT_POINT,
        useValue: () => {
          const node = screen.queryByText(caretText)?.firstChild;
          return node ? { node, offset: caretOffset } : null;
        },
      },
      { provide: MEDIA_ELEMENT_FACTORY, useValue: () => media.element },
      { provide: ANIMATION_FRAMES, useValue: EMPTY },
      { provide: TRANSCRIPT_SEARCH_DEBOUNCE_MS, useValue: debounceMs },
      {
        provide: SEARCH_HIGHLIGHTS,
        useValue: {
          show: (name: string, ranges: readonly Range[]) => {
            const texts = ranges.map((range) => range.toString());
            painted.set(name, texts);
            if (name === 'transcript-word') wordPaints.push(texts);
          },
          clear: (name: string) => painted.delete(name),
        },
      },
    ],
  });
  const engine = TestBed.inject(MediaEngine);
  engine.load({
    id: MEDIA,
    title: 'Palestra',
    src: '/s',
    durationMs: 1_300_000,
  });
  media.setDuration(1_300);
  media.emit('loadedmetadata');
  media.emit('canplay');
  await view.fixture.whenStable();
  return { view, media, engine };
}

/** The media reports it is at `seconds` (a `timeupdate`). */
async function at(
  media: FakeMedia,
  seconds: number,
  view: Awaited<ReturnType<typeof renderPanel>>['view'],
) {
  media.setCurrentTime(seconds);
  media.emit('timeupdate');
  await view.fixture.whenStable();
}

const timeButtons = () =>
  screen.getAllByRole('button', { name: /^\d+:\d{2}, tocar de / });

/** Types into the search field and lets the (test-short) pause pass. */
async function typeQuery(
  field: HTMLElement,
  value: string,
  view: Awaited<ReturnType<typeof renderPanel>>['view'],
) {
  fireEvent.input(field, { target: { value } });
  await new Promise((resolve) => setTimeout(resolve));
  await view.fixture.whenStable();
}

const focused = () => document.activeElement as HTMLElement;

const current = () =>
  document.querySelector('[aria-current="true"]')?.closest('li');

describe('TranscriptPanel (KBC-038, T15)', () => {
  it('marks the segment being heard, and nothing before the first starts', async () => {
    const { media, view } = await renderPanel(
      transcriptOf({
        segments: [{ startMs: 2_000, endMs: 3_000, text: 'Mais tarde.' }],
      }),
    );
    expect(current()).toBeUndefined();
    await at(media, 2.5, view);
    expect(current()?.textContent).toContain('Mais tarde.');
    expect(current()?.classList).toContain('active');
  });

  it('plays from a phrase of minute 20 when it is clicked, and marks it (AC-2)', async () => {
    const { media, view } = await renderPanel();
    fireEvent.click(screen.getByText('No minuto vinte, o vegetal.'));
    expect(media.calls).toContain('seek:1200');
    expect(media.calls.at(-1)).toBe('play');
    await at(media, 1_200.2, view);
    expect(current()?.textContent).toContain('20:00');
    expect(current()?.textContent).toContain('No minuto vinte');
  });

  it('is one Tab stop: ↓ twice and Enter plays the third segment (AC-8, FR-7)', async () => {
    const { media, view } = await renderPanel();
    const tabbable = timeButtons().filter((button) => button.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]?.textContent?.trim()).toBe('0:00');
    tabbable[0]?.focus();
    fireEvent.keyDown(focused(), { key: 'ArrowDown' });
    await view.fixture.whenStable();
    fireEvent.keyDown(focused(), { key: 'ArrowDown' });
    await view.fixture.whenStable();
    const third = timeButtons()[2];
    expect(document.activeElement).toBe(third);
    expect(third?.tabIndex).toBe(0);
    expect(timeButtons().filter((b) => b.tabIndex === 0)).toHaveLength(1);
    // Enter on a button is a click with detail 0 (no mouse).
    fireEvent.click(third as HTMLElement, { detail: 0 });
    expect(media.calls).toContain('seek:10');
    expect(media.calls.at(-1)).toBe('play');
  });

  it('goes to the ends with Home/End and ignores other keys', async () => {
    const { view } = await renderPanel();
    timeButtons()[0]?.focus();
    fireEvent.keyDown(focused(), { key: 'End' });
    await view.fixture.whenStable();
    expect(document.activeElement).toBe(timeButtons()[4]);
    fireEvent.keyDown(focused(), { key: 'PageUp' });
    await view.fixture.whenStable();
    expect(document.activeElement).toBe(timeButtons()[0]);
    fireEvent.keyDown(focused(), { key: 'End' });
    fireEvent.keyDown(focused(), { key: 'Home' });
    await view.fixture.whenStable();
    expect(document.activeElement).toBe(timeButtons()[0]);
    expect(fireEvent.keyDown(focused(), { key: 'x' })).toBe(true);
    // Keys outside the list (the search field) do not move the segments.
    expect(
      fireEvent.keyDown(screen.getByLabelText('Buscar na transcrição'), {
        key: 'End',
      }),
    ).toBe(true);
  });

  it('moves from the focused segment, not from the one playing (FR-7)', async () => {
    const { media, view } = await renderPanel();
    timeButtons()[1]?.focus();
    // The audio moves on to the third segment while the focus stays on the second.
    await at(media, 11, view);
    fireEvent.keyDown(focused(), { key: 'ArrowDown' });
    await view.fixture.whenStable();
    expect(document.activeElement).toBe(timeButtons()[2]);
    fireEvent.keyDown(focused(), { key: 'ArrowUp' });
    await view.fixture.whenStable();
    expect(document.activeElement).toBe(timeButtons()[1]);
  });

  it('names each time button by the spoken time, the text as its description', async () => {
    await renderPanel();
    // The name starts with the visible "20:00" (WCAG 2.5.3, voice control).
    const button = screen.getByRole('button', {
      name: '20:00, tocar de 20 minutos',
    });
    expect(button.textContent?.trim()).toBe('20:00');
    expect(button.getAttribute('aria-describedby')).toBe('transcript-text-3');
    expect(document.getElementById('transcript-text-3')?.textContent).toContain(
      'o vegetal',
    );
  });

  it('stops following when the person scrolls, and "Voltar ao trecho atual" resumes (AC-3)', async () => {
    const { media, view } = await renderPanel();
    await at(media, 6, view);
    expect(
      screen.queryByRole('button', { name: 'Voltar ao trecho atual' }),
    ).toBeNull();
    const list = screen.getByRole('list', { name: 'Trechos da transcrição' });
    fireEvent.wheel(list);
    await view.fixture.whenStable();
    const back = screen.getByRole('button', { name: 'Voltar ao trecho atual' });
    // Still stopped later on, whatever plays (no automatic return).
    await at(media, 11, view);
    expect(screen.getByRole('button', { name: 'Voltar ao trecho atual' })).toBe(
      back,
    );
    fireEvent.click(back);
    await view.fixture.whenStable();
    expect(
      screen.queryByRole('button', { name: 'Voltar ao trecho atual' }),
    ).toBeNull();
    expect(document.activeElement).toBe(timeButtons()[2]);
  });

  it('stops following on touch and on the scroll bar, and a skip in the player resumes', async () => {
    const { media, view, engine } = await renderPanel();
    await at(media, 1, view);
    const list = screen.getByRole('list', { name: 'Trechos da transcrição' });
    fireEvent.pointerDown(screen.getByText('Ele tinha uma conselheira.'));
    await view.fixture.whenStable();
    expect(
      screen.queryByRole('button', { name: 'Voltar ao trecho atual' }),
    ).toBeNull();
    fireEvent.pointerDown(list);
    await view.fixture.whenStable();
    expect(
      screen.getByRole('button', { name: 'Voltar ao trecho atual' }),
    ).toBeTruthy();
    engine.seek(5_000);
    media.emit('seeked');
    await view.fixture.whenStable();
    expect(
      screen.queryByRole('button', { name: 'Voltar ao trecho atual' }),
    ).toBeNull();
    fireEvent.touchMove(list);
    await view.fixture.whenStable();
    expect(
      screen.getByRole('button', { name: 'Voltar ao trecho atual' }),
    ).toBeTruthy();
  });

  it('searches without accents or case, walks the occurrences and plays from one (AC-9)', async () => {
    const { media, view } = await renderPanel();
    const field = screen.getByLabelText('Buscar na transcrição');
    await typeQuery(field, 'salomao', view);
    expect(screen.getByRole('status').textContent).toBe('1 de 3');
    // Painted, not marked up: the DOM text stays as it is.
    expect(document.querySelectorAll('mark')).toHaveLength(0);
    expect(painted.get('transcript-match')).toEqual(['Salomao', 'SALOMÃO']);
    expect(painted.get('transcript-current')).toEqual(['Salomão']);
    expect(document.querySelector('li.current-hit')?.textContent).toContain(
      'Existia um rei chamado Salomão.',
    );
    fireEvent.keyDown(field, { key: 'Enter' });
    await view.fixture.whenStable();
    expect(screen.getByRole('status').textContent).toBe('2 de 3');
    expect(painted.get('transcript-current')).toEqual(['Salomao']);
    expect(document.querySelector('li.current-hit')?.textContent).toContain(
      'Salomao era sábio.',
    );
    // With the search open, the list does not follow.
    expect(
      screen.getByRole('button', { name: 'Voltar ao trecho atual' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tocar daqui' }));
    expect(media.calls).toContain('seek:10');
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(field, { key: 'ArrowUp' });
    await view.fixture.whenStable();
    expect(screen.getByRole('status').textContent).toBe('3 de 3');
    fireEvent.click(screen.getByRole('button', { name: 'Próxima' }));
    fireEvent.click(screen.getByRole('button', { name: 'Anterior' }));
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    await view.fixture.whenStable();
    expect(screen.getByRole('status').textContent).toBe('1 de 3');
  });

  it('searches only once typing pauses, and Enter searches at once (NFR-2)', async () => {
    const { view } = await renderPanel(transcriptOf(), 10_000);
    const field = screen.getByLabelText('Buscar na transcrição');
    fireEvent.input(field, { target: { value: 'salomao' } });
    await view.fixture.whenStable();
    // Nothing searched yet, but the list already stops following.
    expect(screen.getByRole('status').textContent).toBe('');
    expect(
      screen.getByRole('button', { name: 'Voltar ao trecho atual' }),
    ).toBeTruthy();
    fireEvent.keyDown(field, { key: 'Enter' });
    await view.fixture.whenStable();
    expect(screen.getByRole('status').textContent).toBe('1 de 3');
    fireEvent.keyDown(field, { key: 'Enter' });
    await view.fixture.whenStable();
    expect(screen.getByRole('status').textContent).toBe('2 de 3');
  });

  it('says when nothing matches, and Esc clears the search', async () => {
    const { view } = await renderPanel();
    const field = screen.getByLabelText('Buscar na transcrição');
    await typeQuery(field, 'xyz', view);
    expect(screen.getByRole('status').textContent).toBe(
      "Nenhum trecho com 'xyz'.",
    );
    expect(screen.queryByRole('button', { name: 'Tocar daqui' })).toBeNull();
    const tab = fireEvent.keyDown(field, { key: 'Tab' });
    expect(tab).toBe(true);
    fireEvent.keyDown(field, { key: 'Escape' });
    await view.fixture.whenStable();
    // The live region stays, empty, so the next result is announced too.
    expect(screen.getByRole('status').textContent).toBe('');
    expect((field as HTMLInputElement).value).toBe('');
    expect(painted.get('transcript-match')).toEqual([]);
    expect(painted.get('transcript-current')).toEqual([]);
  });

  it('shows the low-confidence notice above the text (AC-6, BR-2)', async () => {
    await renderPanel(transcriptOf({ confidence: 'low' }));
    const notice = screen.getByText(
      'Transcrição automática de baixa confiança: pode haver trechos errados.',
    );
    const list = screen.getByRole('list', { name: 'Trechos da transcrição' });
    expect(
      notice.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('says which term list it was made with, when the API tells (KBC-040 AC-5)', async () => {
    await renderPanel(
      transcriptOf({
        termList: { version: 3, createdAt: '2026-10-28T12:00:00.000Z' },
      }),
    );
    expect(
      screen.getByText('Feita com a lista de termos v3 (28/10/2026)'),
    ).toBeTruthy();
  });

  it('shows no notice for a normal transcript', async () => {
    await renderPanel();
    expect(screen.queryByText(/baixa confiança/)).toBeNull();
  });

  it('says an empty transcript is empty', async () => {
    await renderPanel(transcriptOf({ segments: [] }));
    expect(screen.getByText('A transcrição está vazia.')).toBeTruthy();
    expect(screen.queryByLabelText('Buscar na transcrição')).toBeNull();
  });

  it('copies a selected passage in quotes with the title and the minute link (AC-10)', async () => {
    const { media, view } = await renderPanel();
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          writes.push(text);
          return Promise.resolve();
        },
      },
    });
    const text = screen.getByText('No minuto vinte, o vegetal.');
    const node = text.firstChild as Text;
    const range = document.createRange();
    range.setStart(node, 17);
    range.setEnd(node, 26);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await view.fixture.whenStable();
    // A click that ends a selection does not play.
    fireEvent.click(text, { detail: 1 });
    expect(media.calls).not.toContain('seek:1200');
    fireEvent.click(
      screen.getByRole('button', { name: 'Copiar com o link do minuto' }),
    );
    await Promise.resolve();
    expect(writes).toEqual([
      `“o vegetal”\nPalestra de 1998\n${location.origin}/midia/${MEDIA}?t=1200`,
    ]);
    expect(TestBed.inject(PlayerAnnouncer).message()).toBe(
      'Trecho copiado com o link do minuto.',
    );
    document.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    await view.fixture.whenStable();
    expect(
      screen.queryByRole('button', { name: 'Copiar com o link do minuto' }),
    ).toBeNull();
  });

  it('takes the minute of the first segment a selection covers when it starts between segments', async () => {
    const { view } = await renderPanel();
    const list = screen.getByRole('list', { name: 'Trechos da transcrição' });
    const fourth = screen
      .getByText('No minuto vinte, o vegetal.')
      .closest('li') as HTMLElement;
    const range = document.createRange();
    range.setStart(list, Array.from(list.childNodes).indexOf(fourth));
    range.setEnd(fourth.querySelector('.text')?.firstChild as Text, 8);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await view.fixture.whenStable();
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          writes.push(text);
          return Promise.resolve();
        },
      },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Copiar com o link do minuto' }),
    );
    expect(writes[0]).toMatch(/\?t=1200$/);
    document.getSelection()?.removeAllRanges();
  });

  it('says when the clipboard refuses or is missing', async () => {
    const { view } = await renderPanel();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('denied')) },
    });
    const node = screen.getByText('Ele tinha uma conselheira.')
      .firstChild as Text;
    const range = document.createRange();
    range.selectNodeContents(node);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await view.fixture.whenStable();
    const copy = screen.getByRole('button', {
      name: 'Copiar com o link do minuto',
    });
    fireEvent.click(copy);
    await new Promise((resolve) => setTimeout(resolve));
    const announcer = TestBed.inject(PlayerAnnouncer);
    expect(announcer.message()).toBe(
      'Não consegui copiar. Copie o trecho à mão.',
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    fireEvent.click(copy);
    expect(announcer.message().trim()).toBe(
      'Não consegui copiar. Copie o trecho à mão.',
    );
    document.getSelection()?.removeAllRanges();
  });

  it('paints the passage opened from a search hit, and nothing for another media (KBC-039 AC-10)', async () => {
    const passage = { mediaId: MEDIA, startMs: 5_000, endMs: 9_000 };
    const { view } = await renderPanel(transcriptOf(), 0, passage);
    expect(painted.get('transcript-passage')).toEqual([
      'Ele tinha uma conselheira.',
    ]);

    await view.rerender({
      inputs: { passage: { ...passage, mediaId: 'other' } },
      partialUpdate: true,
    });
    await view.fixture.whenStable();
    expect(painted.get('transcript-passage')).toEqual([]);
  });

  it('paints no passage when opened without one, and clears it when it goes', async () => {
    const { view } = await renderPanel();
    expect(painted.get('transcript-passage')).toEqual([]);
    view.fixture.destroy();
    expect(painted.has('transcript-passage')).toBe(false);
  });
});

describe('TranscriptPanel: "Voz N" at each change of voice (KBC-064 FR-5, AC-1)', () => {
  const voiced = (voices: readonly (number | null)[]) => {
    const base = transcriptOf();
    return transcriptOf({
      segments: base.segments.map((segment, index) => ({
        ...segment,
        voice: voices[index] ?? null,
      })),
      // Whoever receives the separation edits recordings: unnamed reads "Voz N" (BR-6).
      speakers: {
        version: 1,
        createdAt: '2026-11-03T12:00:00.000Z',
        transcriptVersion: 1,
        staleTranscript: false,
        requestedVoices: null,
        voiceCount: 0,
        voices: [],
        turns: [],
        labels: [],
        merged: [],
        namesPending: false,
      },
    });
  };
  const labels = () =>
    screen.queryAllByText(/^Voz \d+$/).map((label) => ({
      voice: label.textContent,
      segment: label.closest('li')?.getAttribute('data-index'),
    }));

  it('labels the first segment of each voice, not one that goes on after a silence', async () => {
    await renderPanel(voiced([1, 1, 2, null, 2]));
    expect(labels()).toEqual([
      { voice: 'Voz 1', segment: '0' },
      { voice: 'Voz 2', segment: '2' },
    ]);
  });

  it('labels voice 1 again when it speaks after voice 2', async () => {
    await renderPanel(voiced([1, 2, 1, 1, 3]));
    expect(labels().map((label) => label.segment)).toEqual([
      '0',
      '1',
      '2',
      '4',
    ]);
  });

  it('shows no voice to whoever gets the transcript without voices', async () => {
    await renderPanel();
    expect(labels()).toEqual([]);
  });

  it('keeps the search on the text, not on the voice label', async () => {
    const { view } = await renderPanel(voiced([1, 2, 2, 2, 2]));
    await typeQuery(
      screen.getByLabelText('Buscar na transcrição'),
      'conselheira',
      view,
    );
    expect(painted.get('transcript-current')).toEqual(['conselheira']);
  });

  it('names who speaks, with ✦ for the main author, to a listener (KBC-065 AC-1)', async () => {
    const base = transcriptOf();
    await renderPanel({
      ...transcriptOf(),
      segments: base.segments.map((segment, index) => ({
        ...segment,
        voice: index === 0 ? 1 : 2,
      })),
      voiceNames: [
        {
          voice: 1,
          kind: 'person',
          speakerId: '11111111-1111-4111-8111-111111111111',
          name: 'Mestre Gabriel',
          main: true,
        },
        {
          voice: 2,
          kind: 'audience',
          speakerId: null,
          name: null,
          main: false,
        },
      ],
    });
    expect(screen.getByText('✦').getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText('Mestre Gabriel')).toBeTruthy();
    expect(screen.getByText('Pergunta da plateia')).toBeTruthy();
    expect(labels()).toEqual([]);
  });

  it('says "Falante não identificado" to a listener for a voice with no name (AC-5)', async () => {
    const base = transcriptOf();
    await renderPanel({
      ...base,
      segments: base.segments.map((segment) => ({ ...segment, voice: 1 })),
      voiceNames: [
        { voice: 1, kind: 'unnamed', speakerId: null, name: null, main: false },
      ],
    });
    expect(screen.getByText('Falante não identificado')).toBeTruthy();
  });
});

describe('TranscriptPanel: word by word (KBC-045)', () => {
  beforeEach(() => (wordByWordOption = true));
  afterEach(() => (wordByWordOption = false));

  const LINE = 'o que está em cima';
  const spoken = (at: number, text = LINE, segment = 0) =>
    text.split(' ').map((word, index) => ({
      segment,
      startMs: at + index * 300,
      endMs: at + index * 300 + 200,
      text: word,
    }));
  const lecture = (): MediaTranscript =>
    transcriptOf({
      segments: [
        { startMs: 1_000, endMs: 2_500, text: LINE },
        { startMs: 3_000, endMs: 4_000, text: 'sem tempos aqui' },
        { startMs: 1_000_000, endMs: 1_002_000, text: 'muito mais adiante' },
      ],
    });
  /** Answers the panel's request for one page, with the transcript's version. */
  function answerWords(
    view: Awaited<ReturnType<typeof renderPanel>>['view'],
    from: number,
    words: readonly object[],
  ) {
    TestBed.inject(HttpTestingController)
      .expectOne(
        `/api/v1/media/${MEDIA}/transcript/words?from=${from}&count=100`,
      )
      .flush({ mediaId: MEDIA, version: answeringVersion, words });
    return view.fixture.whenStable();
  }
  /** The transcript version the API answers with. */
  let answeringVersion = 1;
  beforeEach(() => (answeringVersion = 1));
  const spokenWord = () => painted.get('transcript-word') ?? [];
  const http = () => TestBed.inject(HttpTestingController);

  it('marks "está" between its start and that of "em" (AC-1, BR-1)', async () => {
    const { media, view } = await renderPanel(lecture());
    await answerWords(view, 0, spoken(1_000));
    await at(media, 1.7, view);
    expect(spokenWord()).toEqual(['está']);
    await at(media, 1.899, view);
    expect(spokenWord()).toEqual(['está']);
    await at(media, 1.9, view);
    expect(spokenWord()).toEqual(['em']);
  });

  it('keeps the previous word through a silence, and none before the first (BR-1)', async () => {
    const { media, view } = await renderPanel(lecture());
    await answerWords(view, 0, [
      { segment: 0, startMs: 1_200, endMs: 1_300, text: 'o' },
      { segment: 0, startMs: 2_000, endMs: 2_100, text: 'que' },
    ]);
    await at(media, 1.1, view);
    expect(spokenWord()).toEqual([]);
    await at(media, 1.9, view);
    expect(spokenWord()).toEqual(['o']);
  });

  it('writes once per change of word, not per time reported (FR-2)', async () => {
    const { media, view } = await renderPanel(lecture());
    await answerWords(view, 0, spoken(1_000));
    await at(media, 1.0, view);
    wordPaints.length = 0;
    for (const second of [1.05, 1.1, 1.15, 1.2, 1.25]) {
      await at(media, second, view);
    }
    expect(wordPaints).toEqual([]);
    await at(media, 1.3, view);
    expect(wordPaints).toEqual([['que']]);
  });

  it('leaves only the segment highlighted with the option off (AC-3)', async () => {
    wordByWordOption = false;
    const { media, view } = await renderPanel(lecture());
    http().expectNone((request) => request.url.endsWith('/transcript/words'));
    await at(media, 1.7, view);
    expect(spokenWord()).toEqual([]);
    expect(current()?.textContent).toContain(LINE);
  });

  it('stops painting the word when the option is turned off (AC-3)', async () => {
    const { media, view } = await renderPanel(lecture());
    await answerWords(view, 0, spoken(1_000));
    await at(media, 1.7, view);
    view.fixture.componentRef.setInput('wordByWord', false);
    await view.fixture.whenStable();
    expect(spokenWord()).toEqual([]);
  });

  it('highlights the whole segment when it has no word times, with no error (AC-4)', async () => {
    const { media, view } = await renderPanel(lecture());
    await answerWords(view, 0, spoken(1_000));
    await at(media, 3.5, view);
    expect(spokenWord()).toEqual([]);
    expect(current()?.textContent).toContain('sem tempos aqui');
  });

  it('falls back to the segment when the words fail to load', async () => {
    const { media, view } = await renderPanel(lecture());
    http()
      .expectOne((request) => request.url.endsWith('/transcript/words'))
      .flush(null, { status: 503, statusText: 'Down' });
    await at(media, 1.7, view);
    expect(spokenWord()).toEqual([]);
    expect(current()?.textContent).toContain(LINE);
  });

  it('ignores words of another version of the transcript', async () => {
    const { media, view } = await renderPanel(lecture());
    answeringVersion = 2;
    await answerWords(view, 0, spoken(1_000));
    await at(media, 1.7, view);
    expect(spokenWord()).toEqual([]);
  });

  it('plays from the clicked word when its words are loaded (AC-2)', async () => {
    const { media, view } = await renderPanel(lecture());
    await answerWords(view, 0, spoken(1_000));
    clickWord(LINE, 16);
    expect(media.calls).toContain('seek:2.2');
    expect(media.calls).not.toContain('seek:1');
    expect(media.calls.at(-1)).toBe('play');
  });

  it('plays at once from the segment, then lands on the word, while its page loads (AC-2)', async () => {
    const { media, view } = await renderPanel(lecture());
    clickWord('muito mais adiante', 6);
    // Inside the gesture: Safari refuses a play() that comes after a request.
    expect(media.calls).toContain('seek:1000');
    expect(media.calls.at(-1)).toBe('play');
    await answerWords(view, 0, spoken(1_000_000, 'muito mais adiante', 2));
    expect(media.calls.at(-1)).toBe('seek:1000.3');
  });

  it('drops a pending word when the person plays something else', async () => {
    const { media, view } = await renderPanel(lecture());
    clickWord('muito mais adiante', 6);
    const [time] = timeButtons();
    if (time) fireEvent.click(time, { detail: 0 });
    await answerWords(view, 0, spoken(1_000_000, 'muito mais adiante', 2));
    expect(media.calls).not.toContain('seek:1000.3');
  });

  it('leaves the person where a later skip took them, not on the pending word (F-2)', async () => {
    const { media, engine, view } = await renderPanel(lecture());
    clickWord('muito mais adiante', 6);
    engine.skip(-15_000);
    await answerWords(view, 0, spoken(1_000_000, 'muito mais adiante', 2));
    expect(media.calls).not.toContain('seek:1000.3');
    expect(media.calls.at(-1)).toBe('seek:985');
  });

  it('lands on the pending word after the seek of its own click lands', async () => {
    const { media, view } = await renderPanel(lecture());
    clickWord('muito mais adiante', 6);
    media.emit('seeked');
    await view.fixture.whenStable();
    await answerWords(view, 0, spoken(1_000_000, 'muito mais adiante', 2));
    expect(media.calls.at(-1)).toBe('seek:1000.3');
  });

  it('still lands on the pending word when the app jumps a silence meanwhile', async () => {
    const { media, engine, view } = await renderPanel(lecture());
    clickWord('muito mais adiante', 6);
    engine.skipSilence(1_000_100);
    await answerWords(view, 0, spoken(1_000_000, 'muito mais adiante', 2));
    expect(media.calls.at(-1)).toBe('seek:1000.3');
  });

  it('keeps the segment start when the words of a clicked segment fail', async () => {
    wordByWordOption = false;
    const { media, view } = await renderPanel(lecture());
    clickWord('muito mais adiante', 6);
    http()
      .expectOne((request) => request.url.endsWith('/transcript/words'))
      .flush(null, { status: 503, statusText: 'Down' });
    await view.fixture.whenStable();
    expect(media.calls.filter((call) => call.startsWith('seek:'))).toEqual([
      'seek:1000',
    ]);
  });

  it('still plays the clicked word with the option off (FR-3)', async () => {
    wordByWordOption = false;
    const { media, view } = await renderPanel(lecture());
    clickWord('muito mais adiante', 6);
    await answerWords(view, 0, spoken(1_000_000, 'muito mais adiante', 2));
    expect(media.calls).toContain('seek:1000.3');
  });

  it('goes to the start of the segment with Enter on its time (FR-3)', async () => {
    const { media, view } = await renderPanel(lecture());
    await answerWords(view, 0, spoken(1_000));
    const [time] = timeButtons();
    if (time) fireEvent.click(time, { detail: 0 });
    expect(media.calls).toContain('seek:1');
  });

  it('goes to the start of the segment on a click on its time', async () => {
    const { media, view } = await renderPanel(lecture());
    await answerWords(view, 0, spoken(1_000));
    const [time] = timeButtons();
    caretText = LINE;
    caretOffset = 16;
    if (time) fireEvent.click(time, { detail: 1 });
    expect(media.calls).toContain('seek:1');
    expect(media.calls).not.toContain('seek:2.2');
  });

  it('adds no focusable element for the words (AC-6)', async () => {
    const { view } = await renderPanel(lecture());
    await answerWords(view, 0, spoken(1_000));
    const list = document.querySelector('ol');
    expect(list?.querySelectorAll('button')).toHaveLength(3);
    expect(document.querySelectorAll('.text *')).toHaveLength(0);
  });

  it('asks again for the words of a new version of the transcript', async () => {
    const { media, view } = await renderPanel(lecture());
    await answerWords(view, 0, spoken(1_000));
    await at(media, 1.7, view);
    expect(spokenWord()).toEqual(['está']);
    view.fixture.componentRef.setInput('transcript', {
      ...lecture(),
      version: 2,
    });
    await view.fixture.whenStable();
    expect(spokenWord()).toEqual([]);
    answeringVersion = 2;
    await answerWords(view, 0, spoken(1_000));
    expect(spokenWord()).toEqual(['está']);
  });

  it('keeps the words through a reload of the same version', async () => {
    const { view } = await renderPanel(lecture());
    await answerWords(view, 0, spoken(1_000));
    view.fixture.componentRef.setInput('transcript', lecture());
    await view.fixture.whenStable();
    http().expectNone((request) => request.url.endsWith('/transcript/words'));
  });

  it('asks for the next page near the end of this one, and only then', async () => {
    const segments = Array.from({ length: 150 }, (_, i) => ({
      startMs: i * 1_000,
      endMs: i * 1_000 + 900,
      text: `trecho ${i}`,
    }));
    const { media, view } = await renderPanel(transcriptOf({ segments }));
    await answerWords(view, 0, []);
    await at(media, 94.5, view);
    http().expectNone((request) => request.url.endsWith('/transcript/words'));
    await at(media, 95.5, view);
    await answerWords(view, 100, []);
  });
});
