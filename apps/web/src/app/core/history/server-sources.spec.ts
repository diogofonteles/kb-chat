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

  it("keeps the local sources and cursor when the server's turn is still pending (review 2)", () => {
    const local = research([
      turn({
        id: '0b9d7c1e-3f2a-4c5b-8d6e-7f8091a2b3c4',
        sources: [
          { n: 1, id: 'raw/a.md', title: 'A' },
          { n: 2, id: 'raw/b.md', title: 'B' },
        ],
        sweep: CURSOR,
      }),
    ]);
    const server = research([
      turn({
        id: '0b9d7c1e-3f2a-4c5b-8d6e-7f8091a2b3c4',
        answer: '',
        sources: [],
        status: 'pending',
      }),
    ]);

    expect(withServerSources(local, server)).toEqual(local);
  });

  it('restricts only the numbers the server restricted, and recounts them', () => {
    const local = research([
      turn({
        sources: [
          { n: 1, id: 'raw/a.md', title: 'A' },
          { n: 2, id: 'raw/velado.md', title: 'Velado' },
        ],
        restrictedSources: 5,
      }),
    ]);
    const server = research([
      turn({
        sources: [
          { n: 1, id: 'raw/a.md', title: 'A' },
          { n: 2, restricted: true },
        ],
        restrictedSources: 1,
      }),
    ]);

    const [only] = (withServerSources(local, server) as ResearchConversation)
      .turns;

    expect(only?.sources).toEqual([
      { n: 1, id: 'raw/a.md', title: 'A' },
      { n: 2, restricted: true },
    ]);
    expect(only?.restrictedSources).toBe(1);
  });

  it("drops from the local cursor what the server's cursor hides: findings and the last id", () => {
    const local = research([
      turn({ sweep: { ...CURSOR, after: 'raw/velado.md' } }),
    ]);
    const server = research([
      turn({
        sources: [{ n: 1, restricted: true }],
        sweep: { ...CURSOR, findings: [] },
      }),
    ]);

    const [only] = (withServerSources(local, server) as ResearchConversation)
      .turns;

    expect(only?.sweep?.findings).toEqual([]);
    expect(only?.sweep).not.toHaveProperty('after');
    expect(JSON.stringify(only)).not.toContain('velado');
  });

  it('keeps the newer local findings when the server holds an older cursor (review R2-3)', () => {
    const newer = {
      ...CURSOR,
      totals: { ...CURSOR.totals, scanned: 2, read: 2, batches: 2 },
      findings: [...CURSOR.findings, { id: 'raw/novo.md', text: 'novo' }],
    };
    const local = research([turn({ sweep: newer })]);
    const server = research([turn({ sweep: CURSOR })]);

    const [only] = (withServerSources(local, server) as ResearchConversation)
      .turns;

    expect(only?.sweep).toEqual(newer);
  });

  it('pairs two local turns of one start with two server turns, once each (QA F-8)', () => {
    const local = research([
      turn({ sources: [{ n: 1, id: 'raw/a.md', title: 'A' }] }),
      turn({ sources: [{ n: 1, id: 'raw/b.md', title: 'B' }] }),
    ]);
    const server = research([
      turn({ sources: [{ n: 1, id: 'raw/a.md', title: 'A' }] }),
      turn({ sources: [{ n: 1, restricted: true }] }),
    ]);

    const masked = withServerSources(local, server) as ResearchConversation;

    expect(masked.turns.map((one) => one.sources)).toEqual([
      [{ n: 1, id: 'raw/a.md', title: 'A' }],
      [{ n: 1, restricted: true }],
    ]);
  });

  it('leaves a copy alone when the server has none of its turns, or for a search', () => {
    const local = research([turn()]);
    const other = research([turn({ question: 'outra' })]);
    const search: SearchConversation = aSearchConversation();

    expect(withServerSources(local, other)).toBe(local);
    expect(withServerSources(search, local)).toBe(search);
  });
});
