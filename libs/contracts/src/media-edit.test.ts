import { describe, expect, it } from 'vitest';
import {
  approvalProblems,
  editTrackSchema,
  saveEditRequestSchema,
  timingProblems,
} from './media-edit.js';

const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const track = (n: number, startMs: number, endMs: number) => ({
  id: ID(n),
  startMs,
  endMs,
});
const editTrack = {
  id: ID(1),
  source: 'manual',
  startMs: 0,
  endMs: 6_000,
  kind: 'qa',
  title: '  Pergunta  ',
  askerVoice: null,
  answererVoice: null,
  askerSpeakerId: null,
  answererSpeakerId: null,
};

describe('track rules (KBC-066)', () => {
  it('lets neighbours touch and leaves gaps alone', () => {
    expect(
      timingProblems(
        [track(1, 0, 5_000), track(2, 5_000, 10_000), track(3, 20_000, 26_000)],
        60_000,
      ),
    ).toEqual([]);
  });

  it('points at the later of two overlapping tracks, numbered by time', () => {
    expect(
      timingProblems([track(2, 4_000, 12_000), track(1, 0, 5_000)], 60_000),
    ).toEqual([{ trackId: ID(2), ordinal: 2, problem: 'overlap' }]);
  });

  it('refuses a track of less than 5 s and accepts exactly 5 s', () => {
    expect(timingProblems([track(1, 0, 4_999)], 60_000)).toEqual([
      { trackId: ID(1), ordinal: 1, problem: 'short' },
    ]);
    expect(timingProblems([track(1, 0, 5_000)], 60_000)).toEqual([]);
  });

  it('refuses a track past the recording, with room for a word at the very end', () => {
    expect(timingProblems([track(1, 50_000, 61_000)], 60_000)).toEqual([]);
    expect(timingProblems([track(1, 50_000, 63_000)], 60_000)).toEqual([
      { trackId: ID(1), ordinal: 1, problem: 'range' },
    ]);
    expect(timingProblems([track(1, 50_000, 63_000)], null)).toEqual([]);
  });

  it('adds the empty title on approval, in the order of the tracks', () => {
    const tracks = [
      { ...track(1, 0, 5_000), title: 'Primeira' },
      { ...track(2, 5_000, 9_000), title: 'Curta' },
      { ...track(3, 9_000, 15_000), title: '   ' },
    ];
    expect(approvalProblems(tracks, 60_000)).toEqual([
      { trackId: ID(2), ordinal: 2, problem: 'short' },
      { trackId: ID(3), ordinal: 3, problem: 'title' },
    ]);
  });
});

describe('the draft contract (KBC-066)', () => {
  it('reads a blank title as none, never refusing the save (BR-5)', () => {
    expect(editTrackSchema.parse(editTrack).title).toBe('Pergunta');
    expect(editTrackSchema.parse({ ...editTrack, title: '  ' }).title).toBe(
      null,
    );
  });

  it('refuses a title over 120 characters', () => {
    const long = { ...editTrack, title: 'a'.repeat(121) };
    expect(editTrackSchema.safeParse(long).success).toBe(false);
  });

  it('keeps the run and the edited mark out of a save', () => {
    const body = { step: 3, tracks: [{ ...editTrack, edited: true }] };
    expect(saveEditRequestSchema.safeParse(body).success).toBe(false);
  });
});
