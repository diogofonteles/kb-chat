import {
  readTopicPreference,
  topicPreferenceKey,
  writeTopicPreference,
} from './topic-preference.js';

describe('topic preference (KBC-157)', () => {
  const key = topicPreferenceKey('ana@example.com');

  it('round-trips a slug under the person key', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    writeTopicPreference(storage, key, 'alquimia');
    expect(readTopicPreference(storage, key)).toBe('alquimia');
    expect(
      readTopicPreference(storage, topicPreferenceKey('bia@x.com')),
    ).toBeNull();
  });

  it('has no key and keeps nothing without a person', () => {
    expect(topicPreferenceKey(null)).toBeNull();
    expect(topicPreferenceKey('')).toBeNull();
    const setItem = vi.fn();
    writeTopicPreference({ setItem }, null, 'alquimia');
    expect(setItem).not.toHaveBeenCalled();
    expect(readTopicPreference({ getItem: () => 'alquimia' }, null)).toBeNull();
  });

  it('reads nothing from a missing, invalid or throwing storage (BR-4)', () => {
    expect(readTopicPreference(undefined, key)).toBeNull();
    expect(
      readTopicPreference({ getItem: () => 'Not A Slug!' }, key),
    ).toBeNull();
    expect(
      readTopicPreference(
        {
          getItem: () => {
            throw new Error('blocked');
          },
        },
        key,
      ),
    ).toBeNull();
    expect(() =>
      writeTopicPreference(
        {
          setItem: () => {
            throw new Error('blocked');
          },
        },
        key,
        'alquimia',
      ),
    ).not.toThrow();
  });
});
