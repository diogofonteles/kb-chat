import type { SavedResearchTurn } from '@kb-chat/contracts';
import {
  citedRestricted,
  citedSources,
  fromSavedTurn,
  toSavedTurn,
} from './research-turn.js';

/** KBC-110: a saved turn whose source 2 today's reader may not see. */
const SAVED: SavedResearchTurn = {
  id: '0b9d7c1e-3f2a-4c5b-8d6e-7f8091a2b3c4',
  question: 'lua',
  answer: 'A lua [1] e a velada [2].',
  sources: [
    { n: 1, id: 'raw/a.md', title: 'Aberta' },
    { n: 2, restricted: true },
    { n: 3, restricted: true },
  ],
  restrictedSources: 2,
  steps: 2,
  usd: 0,
  billing: 'per-token',
  model: 'stub/model',
  interrupted: false,
  at: '2026-11-10T12:00:00.000Z',
};

describe('a restored turn with restricted sources (KBC-110)', () => {
  it('keeps the visible sources apart from the numbers it may not open', () => {
    const turn = fromSavedTurn(1, SAVED);

    expect(turn.sources).toEqual([{ n: 1, id: 'raw/a.md', title: 'Aberta' }]);
    expect(turn.restricted).toEqual([2, 3]);
    expect(citedSources(turn).map((one) => one.n)).toEqual([1]);
    expect(citedRestricted(turn)).toEqual([2]);
  });

  it('saves them back in number order, restricted, without the server count', () => {
    const saved = toSavedTurn(fromSavedTurn(1, SAVED));

    expect(saved.sources).toEqual(SAVED.sources);
    expect(saved).not.toHaveProperty('restrictedSources');
  });
});
