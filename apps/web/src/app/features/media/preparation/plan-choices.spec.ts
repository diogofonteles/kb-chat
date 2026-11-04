import {
  defaultChoices,
  isGuided,
  planOf,
  recalledChoices,
  rememberChoices,
  withSpeakers,
  withTracks,
  withTranscribe,
} from './plan-choices.js';

describe('the choices of step 1 (KBC-072)', () => {
  beforeEach(() => localStorage.clear());

  it('comes with nothing paid ticked, and voices only for who edits (BR-2)', () => {
    expect(defaultChoices(true)).toEqual({
      transcribe: true,
      speakers: true,
      tracks: 'none',
      subjects: false,
    });
    expect(defaultChoices(false).speakers).toBe(false);
  });

  it('unticking "Transcrever" unticks what depends on it, and says so (AC-2)', () => {
    const { choices, dropped } = withTranscribe(
      { transcribe: true, speakers: true, tracks: 'ai', subjects: true },
      false,
    );
    expect(choices).toEqual({
      transcribe: false,
      speakers: false,
      tracks: 'none',
      subjects: false,
    });
    expect(dropped).toBe('transcribe');
  });

  it('has nothing to warn about when nothing depended on it', () => {
    const { dropped } = withTranscribe(
      { transcribe: true, speakers: false, tracks: 'none', subjects: false },
      false,
    );
    expect(dropped).toBeNull();
  });

  it('ticking "Transcrever" again ticks nothing else', () => {
    const { choices } = withTranscribe(
      { transcribe: false, speakers: false, tracks: 'none', subjects: false },
      true,
    );
    expect(choices.speakers).toBe(false);
  });

  it('unticking the voices takes the AI, not marking by hand (BR-1)', () => {
    const base = {
      transcribe: true,
      speakers: true,
      subjects: false,
    } as const;
    const ai = withSpeakers({ ...base, tracks: 'ai' }, false);
    expect(ai.choices.tracks).toBe('none');
    expect(ai.dropped).toBe('speakers');
    const manual = withSpeakers({ ...base, tracks: 'manual' }, false);
    expect(manual.choices.tracks).toBe('manual');
    expect(manual.dropped).toBeNull();
  });

  it('"Não dividir agora" takes the subjects with it', () => {
    expect(
      withTracks(
        { transcribe: true, speakers: true, tracks: 'manual', subjects: true },
        'none',
      ).subjects,
    ).toBe(false);
  });

  it('carries the value seen only on a paid choice (BR-4)', () => {
    const base = {
      transcribe: true,
      speakers: true,
      subjects: false,
    } as const;
    expect(planOf({ ...base, tracks: 'ai' }, 0.02).acceptedUsd).toBe(0.02);
    expect(planOf({ ...base, tracks: 'none' }, 0.02).acceptedUsd).toBeNull();
  });

  it('only "Transcrever" is not the guided flow (AC-15)', () => {
    expect(isGuided(defaultChoices(false))).toBe(false);
    expect(isGuided(defaultChoices(true))).toBe(true);
  });

  it('remembers the free choices and never a paid one (AC-4)', () => {
    rememberChoices({
      transcribe: false,
      speakers: true,
      tracks: 'ai',
      subjects: true,
    });
    expect(recalledChoices(true)).toEqual({
      transcribe: false,
      speakers: true,
      tracks: 'none',
      subjects: false,
    });
  });

  it('remembers marking by hand', () => {
    rememberChoices({
      transcribe: true,
      speakers: false,
      tracks: 'manual',
      subjects: false,
    });
    expect(recalledChoices(true).tracks).toBe('manual');
  });

  it('keeps of a memory only what the person may still ask', () => {
    rememberChoices({
      transcribe: false,
      speakers: true,
      tracks: 'manual',
      subjects: false,
    });
    expect(recalledChoices(false)).toEqual({
      ...defaultChoices(false),
      transcribe: false,
    });
  });

  it('ignores a memory it cannot read', () => {
    localStorage.setItem('kb-chat.preparation-choices', '{not json');
    expect(recalledChoices(true)).toEqual(defaultChoices(true));
    localStorage.setItem('kb-chat.preparation-choices', '{"transcribe":1}');
    expect(recalledChoices(true)).toEqual(defaultChoices(true));
    localStorage.setItem('kb-chat.preparation-choices', 'null');
    expect(recalledChoices(true)).toEqual(defaultChoices(true));
  });
});
