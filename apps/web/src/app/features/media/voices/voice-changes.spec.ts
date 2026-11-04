import { voiceChangeStarts, voiceLookOf } from './voice-changes.js';

const segments = (...voices: (number | null)[]) =>
  voices.map((voice) => ({ voice }));

describe('voiceChangeStarts (KBC-064 FR-5)', () => {
  it('labels the first segment of each change of voice', () => {
    expect([...voiceChangeStarts(segments(1, 1, 2, 2, 1, 3))]).toEqual([
      0, 2, 4, 5,
    ]);
  });

  it('does not label the same voice again after a segment with no voice', () => {
    expect([...voiceChangeStarts(segments(null, 1, null, 1, 2))]).toEqual([
      1, 4,
    ]);
  });

  it('labels only the start of a recording of one voice (AC-5)', () => {
    expect([...voiceChangeStarts(segments(1, 1, 1))]).toEqual([0]);
  });
});

describe('voiceLookOf (AC-8: never colour alone)', () => {
  it('gives the first five voices five shapes and tones, and the next five hollow ones', () => {
    const looks = Array.from({ length: 10 }, (_, index) =>
      voiceLookOf(index + 1),
    );
    const keys = looks.map(
      (look) => `${look.tone}-${look.shape}-${String(look.hollow)}`,
    );
    expect(new Set(keys).size).toBe(10);
    expect(new Set(looks.slice(0, 5).map((look) => look.shape)).size).toBe(5);
    expect(looks[5]).toEqual({ tone: 1, shape: 'circle', hollow: true });
  });
});
