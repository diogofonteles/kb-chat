import { describe, expect, it } from 'vitest';
import {
  byArrival,
  cursorOf,
  facetsOf,
  folderOf,
  matches,
  offsetOf,
  type UnassignedRow,
} from './unassigned.js';

const row = (over: Partial<UnassignedRow> = {}): UnassignedRow => ({
  topic: 'hermetismo',
  id: 'raw/a.md',
  title: 'A',
  origin: 'text',
  authorship: 'outros-autores',
  author: null,
  folder: 'raw',
  firstSeenAt: '2026-11-05T10:00:00.000Z',
  ...over,
});

describe('the "Sem nível" queue (KBC-107 FR-1)', () => {
  it('names the folder of a document in its collection, the root as empty', () => {
    expect(folderOf('raw/audio/a.md')).toBe('raw/audio');
    expect(folderOf('a.md')).toBe('');
  });

  it('keeps a row only when every filter given agrees, asOf included (BR-3)', () => {
    const one = row();
    expect(matches({})(one)).toBe(true);
    expect(matches({ origin: 'audio' })(one)).toBe(false);
    expect(matches({ collection: 'hermetismo/aulas' })(one)).toBe(false);
    expect(matches({ authorship: 'mestre-laercio' })(one)).toBe(false);
    expect(matches({ folder: '' })(one)).toBe(false);
    expect(matches({ since: '2026-11-05' })(one)).toBe(true);
    expect(matches({ since: '2026-11-06' })(one)).toBe(false);
    expect(matches({ asOf: '2026-11-05T09:59:59.999Z' })(one)).toBe(false);
  });

  it('orders newest first, then by collection and id', () => {
    const rows = [
      row({ id: 'b.md' }),
      row({ id: 'a.md' }),
      row({ id: 'c.md', firstSeenAt: '2026-11-06T00:00:00.000Z' }),
    ];
    expect(rows.sort(byArrival).map((one) => one.id)).toEqual([
      'c.md',
      'a.md',
      'b.md',
    ]);
  });

  it('counts each facet value, the most common first', () => {
    const facets = facetsOf([row(), row({ origin: 'audio' }), row()]);
    expect(facets.origins).toEqual([
      { value: 'text', count: 2 },
      { value: 'audio', count: 1 },
    ]);
  });

  it('reads back its own cursor and refuses any other as a validation error', () => {
    expect(offsetOf(cursorOf(30))).toBe(30);
    expect(offsetOf(undefined)).toBe(0);
    for (const bad of [
      'nope',
      cursorOf(-1),
      Buffer.from('{"o":1.5}').toString('base64url'),
    ])
      expect(() => offsetOf(bad)).toThrow(
        expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      );
  });
});
