import type { MediaTranscript, VoiceLabel } from '@kb-chat/contracts';
import { cuesWithSpeakers, speakerChanges } from './speaker-names.js';

const label = (
  overrides: Partial<VoiceLabel> & { voice: number },
): VoiceLabel => ({
  kind: 'unnamed',
  speakerId: null,
  name: null,
  main: false,
  ...overrides,
});

const MASTER = '11111111-1111-4111-8111-111111111111';

const transcript = (
  voices: (number | null)[],
  voiceNames: VoiceLabel[],
  extra: Partial<MediaTranscript> = {},
): MediaTranscript => ({
  mediaId: '22222222-2222-4222-8222-222222222222',
  version: 1,
  revision: 0,
  confidence: 'normal',
  segments: voices.map((voice, index) => ({
    startMs: index * 1000,
    endMs: index * 1000 + 900,
    text: `t${index}`,
    voice,
  })),
  voiceNames,
  ...extra,
});

const namesOf = (read: MediaTranscript) =>
  [...speakerChanges(read)].map(([index, { name, main }]) => [
    index,
    name,
    main,
  ]);

describe('speakerChanges (KBC-065 FR-4, BR-6)', () => {
  it('names the main author and the audience at each change (AC-1)', () => {
    const read = transcript(
      [1, 1, 2, 3],
      [
        label({
          voice: 1,
          kind: 'person',
          speakerId: MASTER,
          name: 'Mestre Gabriel',
          main: true,
        }),
        label({ voice: 2, kind: 'audience' }),
        label({ voice: 3, kind: 'audience' }),
      ],
    );
    expect(namesOf(read)).toEqual([
      [0, 'Mestre Gabriel', true],
      [2, 'Pergunta da plateia', false],
      [3, 'Pergunta da plateia', false],
    ]);
  });

  it('does not repeat a person between two of their voices', () => {
    const person = { kind: 'person', speakerId: MASTER, name: 'Ana' } as const;
    const read = transcript(
      [1, 2, 1],
      [label({ voice: 1, ...person }), label({ voice: 2, ...person })],
    );
    expect(namesOf(read)).toEqual([[0, 'Ana', false]]);
  });

  it('says "Falante não identificado" to whoever only listens (AC-5)', () => {
    const read = transcript([1], [label({ voice: 1 })]);
    expect(namesOf(read)).toEqual([[0, 'Falante não identificado', false]]);
  });

  it('says "Voz N" to whoever edits', () => {
    const read = transcript([2], [label({ voice: 2 })], {
      speakers: {
        version: 1,
        createdAt: '2026-11-03T12:00:00.000Z',
        transcriptVersion: 1,
        staleTranscript: false,
        requestedVoices: null,
        voiceCount: 1,
        voices: [],
        turns: [],
        labels: [],
        merged: [],
        namesPending: false,
      },
    });
    expect(namesOf(read)).toEqual([[0, 'Voz 2', false]]);
  });

  it('leaves out a transcript with no voices (AC-4)', () => {
    const read: MediaTranscript = {
      mediaId: '22222222-2222-4222-8222-222222222222',
      version: 1,
      revision: 0,
      confidence: 'normal',
      segments: [{ startMs: 0, endMs: 900, text: 'a' }],
    };
    expect(namesOf(read)).toEqual([]);
  });
});

describe('cuesWithSpeakers (KBC-065 FR-4)', () => {
  const cue = (startMs: number, text: string) => ({
    startMs,
    endMs: startMs + 400,
    text,
  });

  it('prefixes only the first cue of each change, with ✦ for the main author (AC-1)', () => {
    const read = transcript(
      [1, 1, 2],
      [
        label({
          voice: 1,
          kind: 'person',
          speakerId: MASTER,
          name: 'Mestre Gabriel',
          main: true,
        }),
        label({ voice: 2, kind: 'audience' }),
      ],
    );
    const cues = cuesWithSpeakers(
      [cue(0, 'um'), cue(500, 'dois'), cue(1000, 'três'), cue(2000, 'quatro')],
      read,
    );
    expect(cues.map(({ text }) => text)).toEqual([
      '— ✦ Mestre Gabriel: um',
      'dois',
      'três',
      '— Pergunta da plateia: quatro',
    ]);
  });

  it('gives the name to the next cue when a short segment has none of its own', () => {
    const read = transcript(
      [1, 2, 2],
      [label({ voice: 1 }), label({ voice: 2, kind: 'audience' })],
    );
    const cues = cuesWithSpeakers([cue(0, 'a'), cue(2000, 'b')], read);
    expect(cues.map(({ text }) => text)).toEqual([
      '— Falante não identificado: a',
      '— Pergunta da plateia: b',
    ]);
  });

  it('leaves the cues alone with no voices', () => {
    const cues = [cue(0, 'a')];
    expect(cuesWithSpeakers(cues, transcript([null], []))).toEqual(cues);
  });
});
