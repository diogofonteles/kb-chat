import type { AnswerSource } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import type { ShownPassages } from './source-book.js';
import { snapToSegment } from '@kb-chat/contracts';
import { resolvePassages } from './passage-resolution.js';

const TRACK = '0b9c1f7e-1111-4a2b-8c3d-000000000001';

const track: AnswerSource = {
  n: 1,
  id: 'raw/media/r/t.md',
  title: 'O que é o ritmo?',
  media: {
    mediaId: TRACK,
    kind: 'track',
    recordingTitle: 'Palestra de 12/03/2017',
    ordinal: 3,
    total: 12,
    durationMs: 508_000,
    confidence: 'normal',
  },
};
const text: AnswerSource = { n: 2, id: 'raw/articles/x.md', title: 'Um texto' };

const SEGMENTS = [
  { startMs: 0, endMs: 40_500 },
  { startMs: 41_300, endMs: 70_000 },
  { startMs: 70_000, endMs: 95_000 },
  { startMs: 125_900, endMs: 140_000 },
];

const shown = (anchors: number[], last: number | null): ShownPassages => ({
  anchors: new Set(anchors),
  last,
});

const resolve = (
  answer: string,
  memory: Partial<Record<number, ShownPassages>>,
  sources: AnswerSource[] = [track, text],
) =>
  resolvePassages({
    answer,
    sources,
    shownOf: (n) => memory[n],
    segmentsOf: () => SEGMENTS,
  });

describe('resolvePassages (KBC-099 FR-6, BR-5, ADR 0035 §6)', () => {
  it('AC-5: a shown anchor is the passage, with the exact times of its segment', () => {
    const [cited] = resolve('O ritmo é a lei do pêndulo [1@0:41].', {
      1: shown([0, 41, 70], 70),
    });
    expect(cited?.passages).toEqual([
      { at: '0:41', startMs: 41_300, endMs: 70_000 },
    ]);
  });

  it('AC-8: a time never shown for that source falls back to the last passage shown, never to it', () => {
    const [cited] = resolve('Algo [1@7:77] e mais [1@2:00].', {
      1: shown([0, 41], 41),
    });
    expect(cited?.passages).toEqual([
      { at: '7:77', startMs: 41_300, endMs: 70_000 },
      { at: '2:00', startMs: 41_300, endMs: 70_000 },
    ]);
  });

  it('AC-8: a plain [n] of a track is its last passage shown', () => {
    const [cited] = resolve('Segundo a faixa [1].', { 1: shown([0, 70], 70) });
    expect(cited?.passages).toEqual([
      { at: '', startMs: 70_000, endMs: 95_000 },
    ]);
  });

  it('with nothing of the track shown, the passage is its start', () => {
    const [cited] = resolve('Segundo a faixa [1@0:41].', {});
    expect(cited?.passages).toEqual([
      { at: '0:41', startMs: 0, endMs: 40_500 },
    ]);
  });

  it('an anchor shown for another source does not count for this one', () => {
    const other: AnswerSource = { ...track, n: 3, id: 'raw/media/r/u.md' };
    const [cited] = resolve(
      'Na outra [1@2:05].',
      { 1: shown([0], 0), 3: shown([125], 125) },
      [track, other],
    );
    expect(cited?.passages).toEqual([
      { at: '2:05', startMs: 0, endMs: 40_500 },
    ]);
  });

  it('keeps every passage once, in the order the answer cites them', () => {
    const [cited] = resolve('[1@1:10] depois [1@0:41] e de novo [1@1:10] [1]', {
      1: shown([41, 70], 41),
    });
    expect(cited?.passages?.map((one) => one.at)).toEqual(['1:10', '0:41', '']);
  });

  it('leaves texts, uncited tracks and older answers as they were', () => {
    const sources = resolve('Um texto [2].', { 1: shown([41], 41) });
    expect(sources).toEqual([track, text]);
  });

  it('reads "[10@…]" as source 10, not source 1', () => {
    const ten: AnswerSource = { ...track, n: 10 };
    const [cited] = resolve('Na décima [10@0:41].', { 10: shown([41], 41) }, [
      ten,
    ]);
    expect(cited?.passages?.[0]?.startMs).toBe(41_300);
  });
});

describe('snapToSegment', () => {
  it('takes the segment that starts in that second', () => {
    expect(snapToSegment(SEGMENTS, 41)).toEqual({
      startMs: 41_300,
      endMs: 70_000,
    });
  });

  it('else the segment that holds that second', () => {
    expect(snapToSegment(SEGMENTS, 50)).toEqual({
      startMs: 41_300,
      endMs: 70_000,
    });
  });

  it('else the next one, else the last, in a silence', () => {
    expect(snapToSegment(SEGMENTS, 100)).toEqual({
      startMs: 125_900,
      endMs: 140_000,
    });
    expect(snapToSegment(SEGMENTS, 900)).toEqual({
      startMs: 125_900,
      endMs: 140_000,
    });
  });

  it('without a time, the first segment; without segments, the time itself', () => {
    expect(snapToSegment(SEGMENTS, null)).toEqual({
      startMs: 0,
      endMs: 40_500,
    });
    expect(snapToSegment([], 41)).toEqual({ startMs: 41_000, endMs: 41_000 });
    expect(snapToSegment([], null)).toEqual({ startMs: 0, endMs: 0 });
  });
});
