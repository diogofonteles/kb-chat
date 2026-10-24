import { readModePreference, writeModePreference } from './mode-preference.js';

describe('mode preference', () => {
  it('round-trips a valid mode through storage', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    writeModePreference(storage, 'exact');
    expect(readModePreference(storage)).toBe('exact');
  });

  it('defaults to all for a missing, invalid or throwing storage', () => {
    expect(readModePreference(undefined)).toBe('all');
    expect(readModePreference({ getItem: () => 'nonsense' })).toBe('all');
    expect(
      readModePreference({
        getItem: () => {
          throw new Error('blocked');
        },
      }),
    ).toBe('all');
    expect(() =>
      writeModePreference(
        {
          setItem: () => {
            throw new Error('blocked');
          },
        },
        'all',
      ),
    ).not.toThrow();
  });
});
