import { provideZonelessChangeDetection } from '@angular/core';
import { fireEvent, render, screen } from '@testing-library/angular';
import type { DraftTrack } from '@kb-chat/contracts';
import { describe, expect, it, vi } from 'vitest';
import { TrackTimeline, type HandleMoved } from './track-timeline.js';
import { barHeight } from './waveform-canvas.js';

const track = (n: number, startMs: number, endMs: number): DraftTrack => ({
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
  level: null,
});

const ONE = { track: track(1, 10_000, 20_000), ordinal: 1 };
const TWO = { track: track(2, 20_000, 40_000), ordinal: 2 };

async function setup(moved: HandleMoved[] = []) {
  const rendered = await render(TrackTimeline, {
    providers: [provideZonelessChangeDetection()],
    inputs: {
      tracks: [ONE, TWO],
      selected: ONE,
      durationMs: 60_000,
      snap: { start: [9_000, 12_000], end: [18_000, 19_000, 21_000] },
      cursorMs: 0,
    },
    on: { moved: (move: HandleMoved) => moved.push(move) },
  });
  await rendered.fixture.whenStable();
  return rendered;
}

const key = (name: string, init: KeyboardEventInit) =>
  fireEvent.keyDown(screen.getByRole('slider', { name }), init);

describe('TrackTimeline (KBC-066)', () => {
  it('reads each handle in words (FR-4)', async () => {
    await setup();
    expect(
      screen
        .getByRole('slider', { name: 'Início da faixa 1' })
        .getAttribute('aria-valuetext'),
    ).toBe('Início da faixa 1: 10 segundos');
  });

  it('goes to the word edges with the arrows', async () => {
    const moved: HandleMoved[] = [];
    await setup(moved);
    key('Fim da faixa 1', { key: 'ArrowLeft' });
    expect(moved.at(-1)?.ms).toBe(19_000);
    key('Início da faixa 1', { key: 'ArrowRight' });
    expect(moved.at(-1)?.ms).toBe(12_000);
  });

  it('nudges with Alt, without snapping, and jumps 5 s with Shift, snapping', async () => {
    const moved: HandleMoved[] = [];
    await setup(moved);
    key('Fim da faixa 1', { key: 'ArrowLeft', altKey: true });
    expect(moved.at(-1)?.ms).toBe(19_500);
    key('Início da faixa 1', { key: 'ArrowLeft', shiftKey: true });
    expect(moved.at(-1)?.ms).toBe(5_000);
  });

  it('goes to the limits with Home and End, and says why it stopped', async () => {
    const moved: HandleMoved[] = [];
    await setup(moved);
    key('Início da faixa 1', { key: 'Home' });
    expect(moved.at(-1)?.ms).toBe(0);
    key('Fim da faixa 1', { key: 'End' });
    expect(moved).toHaveLength(1);
    key('Fim da faixa 1', { key: 'ArrowRight', altKey: true });
    expect(await screen.findByText('Encostou na faixa 2')).toBeTruthy();
  });

  it('moves nothing when a held key stays at a limit (R-4)', async () => {
    const moved: HandleMoved[] = [];
    await setup(moved);
    key('Fim da faixa 1', { key: 'ArrowRight', altKey: true });
    key('Fim da faixa 1', { key: 'ArrowRight', altKey: true });
    key('Fim da faixa 1', { key: 'ArrowRight', altKey: true });
    expect(moved).toEqual([]);
    expect(await screen.findByText('Encostou na faixa 2')).toBeTruthy();
  });

  describe('with a pointer', () => {
    /** The detail 500 px wide: the view is 50 s, so 100 ms a pixel. */
    const sized = () => {
      const detail = screen.getByTestId('track-detail');
      vi.spyOn(detail, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        width: 500,
      } as DOMRect);
    };
    const name = 'Início da faixa 1';
    const press = (clientX: number) =>
      fireEvent.pointerDown(screen.getByRole('slider', { name }), {
        button: 0,
        clientX,
        pointerId: 1,
      });
    const moveTo = (clientX: number) =>
      fireEvent.pointerMove(screen.getByRole('slider', { name }), {
        clientX,
        pointerId: 1,
      });
    const lift = (clientX: number) =>
      fireEvent.pointerUp(screen.getByRole('slider', { name }), {
        clientX,
        pointerId: 1,
      });

    it('moves nothing on a tap, anywhere on the 48 px target (R-4)', async () => {
      const moved: HandleMoved[] = [];
      await setup(moved);
      sized();
      // The line is at 100 px; the edge of the target at 124 px, 2,4 s away.
      press(124);
      lift(124);
      press(100);
      lift(100);
      expect(moved).toEqual([]);
    });

    it('moves nothing when a finger trembles under the slop', async () => {
      const moved: HandleMoved[] = [];
      await setup(moved);
      sized();
      press(120);
      moveTo(123);
      lift(123);
      expect(moved).toEqual([]);
    });

    it('takes the click that ends a drag for no click on the bar', async () => {
      const cursors: number[] = [];
      const rendered = await setup();
      rendered.fixture.componentInstance.cursorChange.subscribe((ms) =>
        cursors.push(ms),
      );
      sized();
      const detail = screen.getByTestId('track-detail');
      press(120);
      moveTo(160);
      lift(160);
      fireEvent.click(detail, { clientX: 160 });
      expect(cursors).toEqual([]);
      fireEvent.pointerDown(detail, { clientX: 300 });
      fireEvent.click(detail, { clientX: 300 });
      expect(cursors).toEqual([30_000]);
    });

    it('moves by what the pointer moved, not to where it landed (R-4)', async () => {
      const moved: HandleMoved[] = [];
      await setup(moved);
      sized();
      press(120);
      moveTo(160);
      lift(160);
      expect(moved).toEqual([
        { trackId: ONE.track.id, edge: 'start', ms: 14_000 },
      ]);
    });
  });

  it('listens with I and F and Space, from a handle (FR-5)', async () => {
    const heard: string[] = [];
    const rendered = await setup();
    rendered.fixture.componentInstance.listen.subscribe((kind) =>
      heard.push(kind),
    );
    key('Fim da faixa 1', { key: 'i' });
    key('Fim da faixa 1', { key: 'f' });
    key('Fim da faixa 1', { key: ' ' });
    expect(heard).toEqual(['start', 'end', 'track']);
  });

  it('has no handles while a proposal writes the draft', async () => {
    const rendered = await setup();
    rendered.fixture.componentRef.setInput('readOnly', true);
    await rendered.fixture.whenStable();
    expect(screen.queryByRole('slider')).toBeNull();
  });
});

describe('barHeight', () => {
  it('takes the loudest peak of a bar, and lifts quiet ones', () => {
    const peaks = Uint8Array.from([0, 64, 255]);
    expect(barHeight(peaks, { from: 0, to: 3 })).toBe(1);
    expect(barHeight(peaks, { from: 1, to: 2 })).toBeCloseTo(0.5, 1);
    expect(barHeight(peaks, { from: 5, to: 6 })).toBe(0);
  });
});
