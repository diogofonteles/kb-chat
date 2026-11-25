import type { DocumentUpload } from '@kb-chat/contracts';
import {
  durationText,
  macStateOf,
  secondsSince,
  stepsOf,
  summaryOf,
} from './document-progress.js';

const upload = (fields: Partial<DocumentUpload>): DocumentUpload => ({
  id: crypto.randomUUID(),
  topic: 'hermetismo',
  kind: 'file',
  name: 'a.pdf',
  state: 'received',
  failure: null,
  detail: null,
  document: null,
  mediaId: null,
  bytes: null,
  received: null,
  uploadUrl: null,
  batch: null,
  heldBy: null,
  review: false,
  entryCount: 0,
  mine: true,
  retriable: false,
  progress: {
    startedAt: null,
    position: null,
    startsInSeconds: null,
    takesSeconds: null,
    media: null,
  },
  createdAt: '2026-11-25T10:00:00.000Z',
  updatedAt: '2026-11-25T10:00:00.000Z',
  ...fields,
});

describe('how far an item is (KBC-184)', () => {
  it.each([
    ['file', 'received', 0],
    ['file', 'converting', 1],
    ['url', 'classifying', 2],
    ['url', 'mapping', 3],
    ['file', 'mapped', 3],
    ['file', 'ready', 5],
    ['recording', 'received', 0],
    ['recording', 'converting', 1],
    ['recording', 'transcribing', 2],
    ['recording', 'ready', 5],
    ['list', 'converting', 1],
    ['list', 'choosing', 2],
  ] as const)('a %s that is %s is at step %i', (kind, state, at) => {
    expect(stepsOf(upload({ kind, state }))?.at).toBe(at);
  });

  it('one that failed has no way to show: it says why', () => {
    expect(stepsOf(upload({ state: 'failed' }))).toBeNull();
  });

  it.each([
    [0, 'menos de 1 min'],
    [59, 'menos de 1 min'],
    [90, '2 min'],
    [59 * 60, '59 min'],
    [59 * 60 + 45, '1 h'],
    [60 * 60 + 59 * 60 + 45, '2 h'],
    [23 * 60 * 60 + 59 * 60 + 45, '1 dia'],
    [60 * 60, '1 h'],
    [80 * 60, '1 h 20 min'],
    [25 * 60 * 60, '1 dia'],
    [49 * 60 * 60, '2 dias'],
  ])('%i seconds read "%s"', (seconds, text) => {
    expect(durationText(seconds)).toBe(text);
  });

  it('two clocks that differ a little never give a negative time', () => {
    expect(
      secondsSince(
        '2026-11-25T10:00:05.000Z',
        Date.parse('2026-11-25T10:00:00.000Z'),
      ),
    ).toBe(0);
  });
});

describe('how everything stands', () => {
  it('the parts add up, and each inclusion counts once', () => {
    const batch = { id: crypto.randomUUID(), capUsd: 0.5, spentUsd: 0.1 };
    const other = { id: crypto.randomUUID(), capUsd: 1, spentUsd: 0 };
    const uploads = [
      upload({ batch }),
      upload({ batch, state: 'ready' }),
      upload({ batch: other, state: 'choosing', kind: 'list' }),
      upload({ state: 'failed' }),
      upload({ state: 'mapped' }),
    ];
    const { total, counts, spentUsd, capUsd } = summaryOf(uploads);
    expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(total);
    expect(counts).toEqual({
      active: 1,
      yours: 1,
      waiting: 1,
      failed: 1,
      ready: 1,
    });
    expect(spentUsd).toBeCloseTo(0.1);
    expect(capUsd).toBe(1.5);
  });

  it('with the Mac off the time left is what each takes, one after the other', () => {
    const waiting = (position: number) =>
      upload({
        progress: {
          ...upload({}).progress,
          position,
          takesSeconds: 60,
        },
      });
    expect(summaryOf([waiting(1), waiting(2)]).secondsLeft).toBe(120);
    expect(summaryOf([upload({ state: 'ready' })]).secondsLeft).toBeNull();
  });

  it('a Mac that has an item now is there, whatever was last heard', () => {
    const mac = { state: 'off', lastSeenAt: null, doing: null } as const;
    expect(macStateOf({ mac, busy: true, waiting: 0 })).toBe('on');
    expect(macStateOf({ mac, busy: false, waiting: 0 })).toBe('off');
  });
});
