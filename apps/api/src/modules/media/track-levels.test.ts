import { describe, expect, it } from 'vitest';
import {
  approvedLevelOf,
  hiddenSpansOf,
  levelsBelow,
  ownLevelOf,
  touchesHidden,
  trackLevelChoices,
} from './track-levels.js';

const SCALE = [
  { id: 'qs', code: 'QS' },
  { id: 'ci', code: 'CI' },
  { id: 'cdc', code: 'CDC' },
  { id: 'qm', code: 'QM' },
];
const errorCode = (run: () => unknown): string | undefined => {
  try {
    run();
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
};

describe("a track's own level (KBC-106 BR-1, FR-1)", () => {
  const ci = { scale: SCALE, recording: 'ci', allowed: ['qs', 'ci', 'cdc'] };

  it('offers the levels above the recording, up to the person', () => {
    expect(trackLevelChoices(ci)).toEqual({
      recording: { id: 'ci', code: 'CI' },
      choices: [{ id: 'cdc', code: 'CDC' }],
    });
    expect(trackLevelChoices({ ...ci, allowed: null })?.choices).toEqual([
      { id: 'cdc', code: 'CDC' },
      { id: 'qm', code: 'QM' },
    ]);
    expect(trackLevelChoices({ ...ci, scale: [] })).toBeNull();
    expect(trackLevelChoices({ ...ci, recording: null })).toBeNull();
  });

  it('refuses below the recording, above the person and unknown; the recording is following', () => {
    expect(ownLevelOf(ci, 'cdc')).toBe('cdc');
    expect(ownLevelOf(ci, 'ci')).toBeNull();
    expect(ownLevelOf(ci, null)).toBeNull();
    expect(errorCode(() => ownLevelOf(ci, 'qs'))).toBe('LEVEL_BELOW_RECORDING');
    expect(errorCode(() => ownLevelOf(ci, 'qm'))).toBe('LEVEL_ABOVE_YOURS');
    expect(errorCode(() => ownLevelOf(ci, 'xyz'))).toBe('VALIDATION_FAILED');
    expect(errorCode(() => ownLevelOf({ ...ci, scale: [] }, 'ci'))).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('approves a drafted level only while it is above the recording', () => {
    expect(approvedLevelOf(ci, 'cdc')).toBe('cdc');
    expect(approvedLevelOf(ci, 'qs')).toBeNull();
    expect(approvedLevelOf(ci, 'gone')).toBeNull();
    expect(approvedLevelOf(ci, null)).toBeNull();
  });

  it('names the levels under a new recording level', () => {
    expect(levelsBelow(SCALE, 'cdc')).toEqual(['qs', 'ci']);
    expect(levelsBelow(SCALE, 'qs')).toEqual([]);
    expect(levelsBelow(SCALE, null)).toEqual([]);
  });
});

describe('the hidden parts of a recording (KBC-106 FR-2)', () => {
  const track = (startMs: number, endMs: number, level: string | null) => ({
    mediaId: `${startMs}`,
    level,
    startMs,
    endMs,
  });

  it('keeps the tracks the person does not hear, merged where they touch', () => {
    const sees = (level: string | null) => level === 'qs' || level === 'ci';
    expect(
      hiddenSpansOf(
        [
          track(120_000, 180_000, 'cdc'),
          track(0, 60_000, 'ci'),
          track(60_000, 120_000, 'cdc'),
          track(200_000, 210_000, null),
        ],
        sees,
      ),
    ).toEqual([
      { startMs: 60_000, endMs: 180_000 },
      { startMs: 200_000, endMs: 210_000 },
    ]);
    expect(hiddenSpansOf([track(0, 60_000, 'ci')], sees)).toEqual([]);
  });

  it('closes any stretch that touches a hidden span, not one that only meets it', () => {
    const spans = [{ startMs: 60_000, endMs: 120_000 }];
    expect(touchesHidden(spans, { startMs: 59_000, endMs: 61_000 })).toBe(true);
    expect(touchesHidden(spans, { startMs: 50_000, endMs: 60_000 })).toBe(
      false,
    );
    expect(touchesHidden(spans, { startMs: 120_000, endMs: 121_000 })).toBe(
      false,
    );
  });
});
