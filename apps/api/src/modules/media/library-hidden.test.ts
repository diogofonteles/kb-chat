import { describe, expect, it, vi } from 'vitest';
import type { LibraryRecord } from '../../ports/media-store.js';
import { hiddenByRecording } from './library-service.js';
import type { MediaActor } from './media-service.js';

const record = (id: string, track: string | null = null) =>
  ({
    id,
    topic: 'hermetismo',
    level: 'ci',
    track: track
      ? {
          parentId: track,
          startMs: 0,
          endMs: 1,
          ordinal: 1,
          version: 0,
          fileVersion: 1,
        }
      : null,
  }) as unknown as LibraryRecord;

const ANA = {
  canSee: () => true,
  levelsIn: () => ['qs', 'ci'],
} as unknown as MediaActor;

describe("the library's hidden parts (KBC-106 review M4)", () => {
  it('reads the track levels of every recording in one call', () => {
    const records = [
      record('r1'),
      record('r2'),
      record('t1', 'r1'),
      record('r3'),
    ];
    const store = {
      liveTrackLevelsOf: vi.fn(
        () =>
          new Map([
            ['r1', [{ mediaId: 't1', level: 'cdc', startMs: 10, endMs: 20 }]],
          ]),
      ),
    };
    const hidden = hiddenByRecording(ANA, records, store);
    expect(store.liveTrackLevelsOf).toHaveBeenCalledTimes(1);
    expect(store.liveTrackLevelsOf).toHaveBeenCalledWith(['r1', 'r2', 'r3']);
    expect([...hidden]).toEqual([['r1', [{ startMs: 10, endMs: 20 }]]]);
  });

  it('asks nothing for whoever sees every level', () => {
    const store = { liveTrackLevelsOf: vi.fn(() => new Map()) };
    const master = { ...ANA, levelsIn: () => null } as unknown as MediaActor;
    expect(hiddenByRecording(master, [record('r1')], store).size).toBe(0);
    expect(store.liveTrackLevelsOf).not.toHaveBeenCalled();
  });
});
