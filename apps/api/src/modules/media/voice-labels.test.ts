import type { SpeakerTurn } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import type { StoredVoiceLabel } from '../../ports/speaker-store.js';
import {
  aliasOf,
  carryLabels,
  mergeTurns,
  toCollectionSpeaker,
  voiceLabelOf,
} from './voice-labels.js';

const turn = (voice: number, startMs: number, endMs: number): SpeakerTurn => ({
  voice,
  startMs,
  endMs,
});

const speaker = {
  id: '11111111-1111-4111-8111-111111111111',
  collection: 'udv',
  name: 'O Mestre',
  authorSlug: 'mestre-gabriel',
};

const named = (voice: number): StoredVoiceLabel => ({
  voice,
  speaker,
  audience: false,
  mergedInto: null,
});

const audience = (voice: number): StoredVoiceLabel => ({
  voice,
  speaker: null,
  audience: true,
  mergedInto: null,
});

describe('carryLabels (KBC-065 BR-5)', () => {
  it('carries a name at exactly 70 % of the old voice inside the new one', () => {
    const carried = carryLabels({
      labels: [named(1)],
      oldTurns: [turn(1, 0, 10_000)],
      newTurns: [turn(2, 0, 7_000), turn(3, 7_000, 10_000)],
    });
    expect(carried).toEqual([
      { voice: 2, speakerId: speaker.id, audience: false },
    ]);
  });

  it('leaves the voice unnamed below 70 %', () => {
    const carried = carryLabels({
      labels: [named(1)],
      oldTurns: [turn(1, 0, 10_000)],
      newTurns: [turn(2, 0, 6_999), turn(3, 6_999, 10_000)],
    });
    expect(carried).toEqual([]);
  });

  it('adds up the turns of a voice across the recording', () => {
    const carried = carryLabels({
      labels: [audience(2)],
      oldTurns: [turn(2, 0, 2_000), turn(2, 8_000, 10_000)],
      newTurns: [
        turn(1, 0, 2_000),
        turn(3, 2_000, 8_000),
        turn(1, 8_000, 10_000),
      ],
    });
    expect(carried).toEqual([{ voice: 1, speakerId: null, audience: true }]);
  });

  it('lets the voice sharing more time win when two old voices fall in one', () => {
    const carried = carryLabels({
      labels: [audience(1), named(2)],
      oldTurns: [turn(1, 0, 1_000), turn(2, 1_000, 10_000)],
      newTurns: [turn(1, 0, 10_000)],
    });
    expect(carried).toEqual([
      { voice: 1, speakerId: speaker.id, audience: false },
    ]);
  });

  it('ignores unnamed and joined voices', () => {
    const carried = carryLabels({
      labels: [
        { voice: 1, speaker: null, audience: false, mergedInto: null },
        { ...named(2), mergedInto: 1 },
      ],
      oldTurns: [turn(1, 0, 10_000)],
      newTurns: [turn(1, 0, 10_000)],
    });
    expect(carried).toEqual([]);
  });
});

describe('mergeTurns (KBC-065 FR-2)', () => {
  it('reads joined voices as one and joins their back-to-back turns', () => {
    const alias = aliasOf([{ ...named(3), mergedInto: 2 }]);
    expect(
      mergeTurns([turn(1, 0, 5), turn(2, 5, 8), turn(3, 8, 9)], alias),
    ).toEqual([turn(1, 0, 5), turn(2, 5, 9)]);
  });

  it('leaves the turns as they are with no join', () => {
    const turns = [turn(1, 0, 5), turn(2, 5, 8)];
    expect(mergeTurns(turns, new Map())).toEqual(turns);
  });
});

describe('labels as read (KBC-065 BR-2, BR-6)', () => {
  const noAuthor = () => null;

  it("shows a linked speaker with the author's name and ✦", () => {
    const authorOf = () => ({ name: 'Mestre Gabriel', main: true });
    expect(toCollectionSpeaker(speaker, authorOf)).toMatchObject({
      name: 'Mestre Gabriel',
      main: true,
    });
  });

  it('falls back to its own name when the author is gone', () => {
    expect(toCollectionSpeaker(speaker, noAuthor)).toMatchObject({
      name: 'O Mestre',
      main: false,
    });
  });

  it('reads a voice with no row as unnamed and the audience with no name', () => {
    expect(voiceLabelOf(4, undefined, noAuthor)).toEqual({
      voice: 4,
      kind: 'unnamed',
      speakerId: null,
      name: null,
      main: false,
    });
    expect(voiceLabelOf(2, audience(2), noAuthor).kind).toBe('audience');
  });
});
