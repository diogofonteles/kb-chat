import type {
  ResearchConversation,
  SavedResearchTurn,
  SearchConversation,
} from '@kb-chat/contracts';
import { aSearchConversation } from '../../testing/fake-conversations.js';
import { withServerSources } from './server-sources.js';

const AT = '2026-11-10T12:00:00.000Z';

const turn = (
  overrides: Partial<SavedResearchTurn> = {},
): SavedResearchTurn => ({
  question: 'lua',
  answer: 'A lua [1].',
  sources: [{ n: 1, id: 'raw/velado.md', title: 'Velado' }],
  steps: 1,
  usd: 0,
  billing: 'per-token',
  model: 'stub/model',
  interrupted: false,
  at: AT,
  ...overrides,
});

const research = (turns: SavedResearchTurn[]): ResearchConversation => ({
  kind: 'research',
  id: '6f1c2b9b-8a11-4d0a-9d55-0b6f1f0e6a3e',
  topic: 'hermetismo',
  title: 'lua',
  createdAt: AT,
  updatedAt: AT,
  turns,
});

const CURSOR = {
  plan: { target: {}, phrases: [], extract: 'o que diz da lua' },
  totals: { documents: 2, scanned: 1, withHits: null, read: 1, batches: 1 },
  findings: [{ id: 'raw/velado.md', text: 'velado' }],
};

describe('withServerSources (KBC-110 BR-5)', () => {
  it('matches an older turn without an id by its start and question, cursor included', () => {
    const local = research([turn({ sweep: CURSOR })]);
    const server = research([
      turn({
        sources: [{ n: 1, restricted: true }],
        restrictedSources: 1,
        sweep: { ...CURSOR, findings: [] },
      }),
    ]);

    expect(withServerSources(local, server)).toEqual(server);
  });

  it('drops a local count and cursor the server no longer has', () => {
    const local = research([turn({ restrictedSources: 1, sweep: CURSOR })]);
    const server = research([turn()]);

    const [only] = (withServerSources(local, server) as ResearchConversation)
      .turns;

    expect(only).not.toHaveProperty('restrictedSources');
    expect(only).not.toHaveProperty('sweep');
  });

  it('leaves a copy alone when the server has none of its turns, or for a search', () => {
    const local = research([turn()]);
    const other = research([turn({ question: 'outra' })]);
    const search: SearchConversation = aSearchConversation();

    expect(withServerSources(local, other)).toBe(local);
    expect(withServerSources(search, local)).toBe(search);
  });
});
