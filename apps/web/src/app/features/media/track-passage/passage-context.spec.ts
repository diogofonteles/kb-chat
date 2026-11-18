import type { MediaTranscript } from '@kb-chat/contracts';
import {
  aroundHeard,
  aroundPassage,
  citedRange,
  lineStateAt,
  speakersBySegment,
} from './passage-context.js';

const transcript = (
  overrides: Partial<MediaTranscript> = {},
): MediaTranscript => ({
  mediaId: '11111111-1111-4111-8111-111111111111',
  version: 1,
  revision: 0,
  confidence: 'normal',
  segments: [
    { startMs: 0, endMs: 10_000, text: 'Um.' },
    { startMs: 10_000, endMs: 20_000, text: 'Dois.' },
    { startMs: 20_000, endMs: 30_000, text: 'Três.' },
    { startMs: 30_000, endMs: 40_000, text: '', restricted: true },
    { startMs: 40_000, endMs: 50_000, text: 'Cinco.' },
  ],
  ...overrides,
});

describe('passage context (KBC-150)', () => {
  it('finds the segments a passage falls on', () => {
    const { segments } = transcript();
    expect(citedRange(segments, { startMs: 12_000, endMs: 25_000 })).toEqual({
      first: 1,
      last: 2,
    });
    expect(citedRange(segments, { startMs: 90_000, endMs: 95_000 })).toBeNull();
  });

  it('keeps only the speech before, the passage as one line and the speech after, past what is restricted', () => {
    const lines = aroundPassage(transcript(), {
      startMs: 10_000,
      endMs: 30_000,
    });
    expect(
      lines.map(({ kind, startMs, text }) => [kind, startMs, text]),
    ).toEqual([
      ['before', 0, 'Um.'],
      ['cited', 10_000, 'Dois. Três.'],
      ['after', 40_000, 'Cinco.'],
    ]);
    expect(
      aroundPassage(transcript(), { startMs: 0, endMs: 5_000 }).map(
        (one) => one.kind,
      ),
    ).toEqual(['cited', 'after']);
    expect(
      aroundPassage(transcript(), { startMs: 90_000, endMs: 95_000 }),
    ).toEqual([]);
  });

  it('says who speaks each segment only when the transcript has the voices', () => {
    expect(speakersBySegment(transcript())).toEqual([]);
    const voiced = transcript({
      segments: transcript().segments.map((one, index) => ({
        ...one,
        voice: index < 2 ? 1 : 2,
      })),
      voiceNames: [
        {
          voice: 1,
          kind: 'person',
          name: 'Irmã Helena',
          main: false,
          speakerId: '22222222-2222-4222-8222-222222222222',
        },
      ],
    });
    const speakers = speakersBySegment(voiced);
    expect(speakers[1]?.name).toBe('Irmã Helena');
    expect(speakers[2]?.name).toBe('Falante não identificado');
    expect(speakers[2]?.voice).toBe(2);
  });

  it('marks the line heard now and the ones already heard, only while it plays', () => {
    const line = { startMs: 10_000, endMs: 20_000 };
    expect(lineStateAt(line, 15_000, false)).toBe('idle');
    expect(lineStateAt(line, 5_000, true)).toBe('idle');
    expect(lineStateAt(line, 15_000, true)).toBe('now');
    expect(lineStateAt(line, 20_000, true)).toBe('past');
  });

  describe('aroundHeard (KBC-154)', () => {
    const kinds = (lines: ReturnType<typeof aroundHeard>) =>
      lines?.map(({ kind, text }) => [kind, text]) ?? null;

    it(`keeps the passage's lines through the 2 s lead-in of "Ouvir o trecho"`, () => {
      // The passage starts at 20 s; playback starts at 18 s, on the line before it.
      const passage = { startMs: 20_000, endMs: 30_000 };
      expect(aroundHeard(transcript(), passage, { nowMs: 18_500 })).toBeNull();
      expect(aroundHeard(transcript(), passage, { nowMs: 25_000 })).toBeNull();
    });

    it("keeps the passage's lines while the line heard is next to it, past what is restricted", () => {
      const passage = { startMs: 20_000, endMs: 30_000 };
      expect(aroundHeard(transcript(), passage, { nowMs: 12_000 })).toBeNull();
      expect(aroundHeard(transcript(), passage, { nowMs: 45_000 })).toBeNull();
    });

    it('follows the line heard once it is beyond the lines around the passage', () => {
      expect(
        kinds(
          aroundHeard(
            transcript(),
            { startMs: 0, endMs: 5_000 },
            { nowMs: 25_000 },
          ),
        ),
      ).toEqual([
        ['before', 'Dois.'],
        ['heard', 'Três.'],
        ['after', 'Cinco.'],
      ]);
      expect(
        kinds(
          aroundHeard(
            transcript(),
            { startMs: 40_000, endMs: 50_000 },
            { nowMs: 5_000 },
          ),
        ),
      ).toEqual([
        ['heard', 'Um.'],
        ['after', 'Dois.'],
      ]);
    });
  });
});
