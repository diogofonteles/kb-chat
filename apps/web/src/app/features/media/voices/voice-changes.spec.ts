import { sampleOf, voiceChangeStarts, voiceLookOf } from './voice-changes.js';

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

describe('sampleOf (KBC-065 FR-3)', () => {
  const turn = (voice: number, startMs: number, endMs: number) => ({
    voice,
    startMs,
    endMs,
  });

  it("takes the first 5 s of the voice's longest turn", () => {
    expect(
      sampleOf(
        [turn(1, 0, 2_000), turn(2, 2_000, 30_000), turn(1, 30_000, 60_000)],
        1,
      ),
    ).toEqual({ startMs: 30_000, endMs: 35_000 });
  });

  it('plays a shorter turn whole', () => {
    expect(sampleOf([turn(3, 1_000, 3_000)], 3)).toEqual({
      startMs: 1_000,
      endMs: 3_000,
    });
  });

  it('has nothing for a voice with no turn', () => {
    expect(sampleOf([turn(1, 0, 1_000)], 2)).toBeNull();
  });
});
