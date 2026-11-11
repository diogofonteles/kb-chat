import type {
  AnswerSource,
  ResearchConversation,
  SavedResearchTurn,
  SweepCursor,
} from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import type { ScopedDocument, ViewedScope } from '../../ports/level-view.js';
import {
  OPEN_VIEW,
  scaledView,
  type LevelView,
  type StoredLevel,
} from '../access-levels/index.js';
import { maskConversation, type ScopeOf } from './conversation-mask.js';
import { unmaskResearchTurns } from './research-turns.js';

const AT = '2026-11-10T12:00:00.000Z';

const level = (id: string): StoredLevel => ({
  id,
  code: id.toUpperCase(),
  description: '',
  createdBy: 'owner@example.com',
  createdAt: AT,
});

const placed = (entries: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(entries).map(([id, one]) => [
      id,
      { level: one, setBy: 'owner@example.com', setAt: AT },
    ]),
  );

/** QS < CI < CDC; `hermetismo/aulas` holds `raw/ci-2.md` (scope id `aulas/raw/ci-2.md`). */
const PLACEMENTS: Record<string, ReturnType<typeof placed>> = {
  hermetismo: placed({ 'raw/qs-1.md': 'qs', 'raw/cdc-1.md': 'cdc' }),
  'hermetismo/aulas': placed({ 'raw/ci-2.md': 'ci' }),
};

const viewAt = (rank: number): LevelView =>
  scaledView({
    scale: [level('qs'), level('ci'), level('cdc')],
    rank,
    placementsOf: (collection) => PLACEMENTS[collection] ?? {},
    memo: (_catalog, compute) => compute(),
  });

const doc = (id: string, home?: ScopedDocument['home']): ScopedDocument => ({
  id,
  media: null,
  ...(home ? { home } : {}),
});

const SCOPE: ViewedScope<ScopedDocument> = {
  topic: 'hermetismo',
  entries: new Map([
    ['raw/qs-1.md', doc('raw/qs-1.md')],
    [
      'aulas/raw/ci-2.md',
      doc('aulas/raw/ci-2.md', {
        topic: 'hermetismo/aulas',
        id: 'raw/ci-2.md',
      }),
    ],
    ['raw/cdc-1.md', doc('raw/cdc-1.md')],
  ]),
};
const scopeOf: ScopeOf = (topic) =>
  topic === 'hermetismo' ? SCOPE : undefined;

const source = (n: number, id: string): AnswerSource => ({
  n,
  id,
  title: `Título ${id}`,
  authorship: 'outros-autores',
});

const SOURCES = [
  source(1, 'raw/qs-1.md'),
  source(2, 'aulas/raw/ci-2.md'),
  source(3, 'raw/cdc-1.md'),
];

const CURSOR: SweepCursor = {
  plan: { target: {}, phrases: [], extract: 'o que diz da lua' },
  totals: { documents: 3, scanned: 2, withHits: null, read: 2, batches: 1 },
  findings: [
    { id: 'raw/qs-1.md', text: 'aberto' },
    { id: 'raw/cdc-1.md', text: 'velado' },
  ],
};

const turn = (
  overrides: Partial<SavedResearchTurn> = {},
): SavedResearchTurn => ({
  id: '0b9d7c1e-3f2a-4c5b-8d6e-7f8091a2b3c4',
  question: 'lua',
  answer: 'A lua [1] [2] [3].',
  sources: SOURCES,
  steps: 1,
  usd: 0,
  billing: 'per-token',
  model: 'stub/model',
  interrupted: false,
  at: AT,
  ...overrides,
});

const conversation = (
  turns: SavedResearchTurn[] = [turn()],
): ResearchConversation => ({
  kind: 'research',
  id: '6f1c2b9b-8a11-4d0a-9d55-0b6f1f0e6a3e',
  topic: 'hermetismo',
  title: 'lua',
  createdAt: AT,
  updatedAt: AT,
  turns,
});

const turnsOf = (masked: ReturnType<typeof maskConversation>) =>
  masked.kind === 'research' ? masked.turns : [];

describe('maskConversation (KBC-110)', () => {
  it('hides the sources above the level and counts them, keeping the prose', () => {
    const [masked] = turnsOf(
      maskConversation(conversation(), viewAt(1), scopeOf),
    );

    expect(masked?.answer).toBe('A lua [1] [2] [3].');
    expect(masked?.sources).toEqual([
      SOURCES[0],
      SOURCES[1],
      { n: 3, restricted: true },
    ]);
    expect(masked?.restrictedSources).toBe(1);
  });

  it('judges a sub-collection document where it is: hidden below its level', () => {
    const [masked] = turnsOf(
      maskConversation(conversation(), viewAt(0), scopeOf),
    );

    expect(masked?.sources).toEqual([
      SOURCES[0],
      { n: 2, restricted: true },
      { n: 3, restricted: true },
    ]);
    expect(masked?.restrictedSources).toBe(2);
  });

  it('closes a source the catalog no longer has in a scaled collection', () => {
    const gone = turn({ sources: [source(1, 'raw/apagado.md')] });

    const [masked] = turnsOf(
      maskConversation(conversation([gone]), viewAt(2), scopeOf),
    );

    expect(masked?.sources).toEqual([{ n: 1, restricted: true }]);
  });

  it('closes a cited track for a member until tracks hold levels', () => {
    const track = turn({
      sources: [
        {
          ...source(1, 'raw/qs-1.md'),
          media: {
            mediaId: '1c8e6d2f-4a3b-4d6c-9e7f-8091a2b3c4d5',
            kind: 'recording',
            recordingTitle: 'Aula',
            durationMs: 1000,
            confidence: 'normal',
          },
        },
      ],
    });
    const scope: ScopeOf = () => undefined;

    const [masked] = turnsOf(
      maskConversation(conversation([track]), viewAt(2), scope),
    );

    expect(masked?.sources).toEqual([{ n: 1, restricted: true }]);
  });

  it('drops the hidden findings of a sweep cursor', () => {
    const [masked] = turnsOf(
      maskConversation(
        conversation([turn({ sweep: CURSOR })]),
        viewAt(1),
        scopeOf,
      ),
    );

    expect(masked?.sweep?.findings).toEqual([
      { id: 'raw/qs-1.md', text: 'aberto' },
    ]);
    expect(masked?.sweep?.totals).toEqual(CURSOR.totals);
  });

  it("drops the cursor's last swept id when that document is hidden (QA E2)", () => {
    const hiddenAfter = { ...CURSOR, after: 'raw/cdc-1.md' };
    const openAfter = { ...CURSOR, after: 'raw/qs-1.md' };

    const [hidden] = turnsOf(
      maskConversation(
        conversation([turn({ sweep: hiddenAfter })]),
        viewAt(1),
        scopeOf,
      ),
    );
    const [open] = turnsOf(
      maskConversation(
        conversation([turn({ sweep: openAfter })]),
        viewAt(1),
        scopeOf,
      ),
    );

    expect(hidden?.sweep).not.toHaveProperty('after');
    expect(open?.sweep?.after).toBe('raw/qs-1.md');
  });

  it('returns the conversation itself when the view sees everything (AC-8)', () => {
    const stored = conversation([turn({ sweep: CURSOR })]);

    expect(maskConversation(stored, OPEN_VIEW, scopeOf)).toBe(stored);
    expect(maskConversation(stored, viewAt(2), scopeOf)).toEqual(stored);
  });
});

describe('unmaskResearchTurns (KBC-110 BR-4)', () => {
  const stored = conversation([turn({ sweep: CURSOR })]);
  const masked = maskConversation(
    stored,
    viewAt(0),
    scopeOf,
  ) as ResearchConversation;

  it('gives a restricted source and a filtered cursor their stored values back', () => {
    expect(unmaskResearchTurns(masked, stored)).toEqual(stored);
  });

  it('gives a hidden "after" back with the findings (BR-4)', () => {
    const hiddenAfter = conversation([
      turn({ sweep: { ...CURSOR, after: 'raw/cdc-1.md' } }),
    ]);
    const read = maskConversation(
      hiddenAfter,
      viewAt(0),
      scopeOf,
    ) as ResearchConversation;

    expect(unmaskResearchTurns(read, hiddenAfter)).toEqual(hiddenAfter);
  });

  it('keeps a cursor whose "after" is not the stored one', () => {
    const stale = conversation([
      turn({ sweep: { ...CURSOR, after: 'raw/zz.md', findings: [] } }),
    ]);
    const withAfter = conversation([
      turn({ sweep: { ...CURSOR, after: 'raw/cdc-1.md' } }),
    ]);

    expect(unmaskResearchTurns(stale, withAfter).turns[0]?.sweep?.after).toBe(
      'raw/zz.md',
    );
  });

  it('matches an older turn without an id by its start and question', () => {
    const [first] = masked.turns;
    const olderStored = conversation([
      { ...turn({ sweep: CURSOR }), id: undefined },
    ]);
    const older = conversation(first ? [{ ...first, id: undefined }] : []);

    expect(unmaskResearchTurns(older, olderStored).turns[0]?.sources).toEqual(
      SOURCES,
    );
  });

  it('keeps a restricted source with no stored one, and never the client count', () => {
    const lone = conversation([
      turn({ sources: [{ n: 1, restricted: true }], restrictedSources: 1 }),
    ]);

    const [restored] = unmaskResearchTurns(lone, null).turns;

    expect(restored?.sources).toEqual([{ n: 1, restricted: true }]);
    expect(restored?.restrictedSources).toBeUndefined();
  });

  it('keeps a cursor that moved on, rather than the stored one', () => {
    const moved = conversation([
      turn({ sweep: { ...CURSOR, after: 'raw/qs-1.md', findings: [] } }),
    ]);

    expect(unmaskResearchTurns(moved, stored).turns[0]?.sweep?.after).toBe(
      'raw/qs-1.md',
    );
  });

  it('keeps a cursor whose findings are not the stored ones', () => {
    const other = { id: 'raw/qs-1.md', text: 'outro achado' };
    const changed = conversation([
      turn({ sweep: { ...CURSOR, findings: [other] } }),
    ]);

    expect(
      unmaskResearchTurns(changed, stored).turns[0]?.sweep?.findings,
    ).toEqual([other]);
  });
});
