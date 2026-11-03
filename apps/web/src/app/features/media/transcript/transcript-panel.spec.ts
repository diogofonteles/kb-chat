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
import { SEARCH_HIGHLIGHTS } from './search-highlights.js';
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

async function renderPanel(transcript = transcriptOf(), debounceMs = 0) {
  localStorage.clear();
  painted.clear();
  const media: FakeMedia = fakeMediaElement();
  const view = await render(TranscriptPanel, {
    inputs: { transcript, title: 'Palestra de 1998' },
    providers: [
      provideZonelessChangeDetection(),
      { provide: MEDIA_ELEMENT_FACTORY, useValue: () => media.element },
      { provide: ANIMATION_FRAMES, useValue: EMPTY },
      { provide: TRANSCRIPT_SEARCH_DEBOUNCE_MS, useValue: debounceMs },
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
});
