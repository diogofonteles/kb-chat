import {
  ALL_KINDS,
  readKindsPreference,
  toggleKind,
  writeKindsPreference,
} from './search-kinds.js';

const memory = (value: string | null = null) => {
  let stored = value;
  return {
    getItem: () => stored,
    setItem: (_key: string, next: string) => {
      stored = next;
    },
  };
};

describe('"Buscar em" preference (KBC-039 BR-4)', () => {
  it('defaults to every kind and remembers a choice', () => {
    const storage = memory();
    expect(readKindsPreference(storage)).toEqual(['text', 'audio']);
    writeKindsPreference(storage, ['audio']);
    expect(readKindsPreference(storage)).toEqual(['audio']);
  });

  it('falls back to every kind on junk, an empty list or blocked storage', () => {
    expect(readKindsPreference(memory('not json'))).toBe(ALL_KINDS);
    expect(readKindsPreference(memory('[]'))).toBe(ALL_KINDS);
    expect(readKindsPreference(memory('["video"]'))).toBe(ALL_KINDS);
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readKindsPreference(blocked)).toBe(ALL_KINDS);
    expect(() => writeKindsPreference(blocked, ['text'])).not.toThrow();
  });

  it('toggles a kind and never leaves none chosen', () => {
    expect(toggleKind(['text', 'audio'], 'text')).toEqual(['audio']);
    expect(toggleKind(['audio'], 'audio')).toEqual(['audio']);
    expect(toggleKind(['audio'], 'text')).toEqual(['text', 'audio']);
  });
});
