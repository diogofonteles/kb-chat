import { randomUUID } from 'node:crypto';
import type {
  ResearchConversation,
  SavedResearchTurn,
} from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp, type Call } from '../test/ai-app-harness.js';
import {
  memberOf,
  setPersonLevel,
  sixAtThreeLevels,
  startLevels,
  type LevelsWorld,
} from '../test/levels-world.js';

/*
 * KBC-110 (ADR 0036 §8): a stored research answer is re-checked against today's level. Ana
 * was at CDC when the answer cited QS, CI and CDC documents; the master moves her to CI.
 */

afterEach(closeApp);

const CDC_ID = 'raw/cdc-1.md';
const CDC_TITLE = 'Zircônio Velado';
const CDC_PASSAGE = 'trecho velado do zircônio';
const URL = '/api/v1/conversations';
const AT = '2026-11-10T12:00:00.000Z';

function aTurn(overrides: Partial<SavedResearchTurn> = {}): SavedResearchTurn {
  return {
    id: randomUUID(),
    question: 'o que dizem da lua?',
    answer: 'A lua aparece em três graus [1] [2] [3].',
    sources: [
      {
        n: 1,
        id: 'raw/qs-1.md',
        title: 'Lua Primeira Aberta',
        authorship: 'outros-autores',
      },
      {
        n: 2,
        // A sub-collection's document, by its scope id (ADR 0028).
        id: 'aulas/raw/ci-2.md',
        title: 'Lua Media Duo',
        authorship: 'outros-autores',
      },
      {
        n: 3,
        id: CDC_ID,
        title: CDC_TITLE,
        authorship: 'outros-autores',
        author: 'Autor Velado',
      },
    ],
    steps: 3,
    usd: 0,
    billing: 'subscription',
    model: 'stub/model',
    interrupted: false,
    at: AT,
    ...overrides,
  };
}

/** A sweep cursor carrying a finding of each of an open and the hidden document. */
const CURSOR = {
  plan: { target: {}, phrases: [], extract: 'o que diz da lua' },
  after: 'raw/ci-1.md',
  totals: { documents: 6, scanned: 3, withHits: null, read: 3, batches: 1 },
  findings: [
    { id: 'raw/qs-1.md', text: 'a lua no primeiro grau' },
    { id: CDC_ID, text: CDC_PASSAGE },
  ],
};

const aConversation = (
  turns: SavedResearchTurn[] = [aTurn()],
): ResearchConversation => ({
  kind: 'research',
  id: randomUUID(),
  topic: 'hermetismo',
  title: 'o que dizem da lua?',
  createdAt: AT,
  updatedAt: AT,
  turns,
});

interface Case {
  readonly world: LevelsWorld;
  readonly ana: Awaited<ReturnType<typeof memberOf>>;
  readonly saved: ResearchConversation;
}

/** Ana at CDC saves the answer; then the master puts her at `level`. */
async function anaSavedThenAt(
  level: string,
  saved: ResearchConversation = aConversation(),
): Promise<Case> {
  const world = await startLevels();
  const ana = await memberOf(world, 'ana@example.com');
  await sixAtThreeLevels(world);
  await setPersonLevel(world, ana.id, { hermetismo: 'cdc' });
  const put = await ana.call('PUT', `${URL}/${saved.id}`, saved);
  expect(put.statusCode, put.body).toBe(200);
  await setPersonLevel(world, ana.id, { hermetismo: level });
  return { world, ana, saved };
}

const read = (call: Call, id: string) => call('GET', `${URL}/${id}`);

/** None of the hidden document's title, id, author or passage, anywhere in the body. */
function expectNothingHidden(body: string): void {
  for (const secret of [
    CDC_TITLE,
    CDC_ID,
    'cdc-1',
    'Autor Velado',
    CDC_PASSAGE,
  ])
    expect(body).not.toContain(secret);
}

describe('GET /api/v1/conversations/:id after a demotion (KBC-110)', () => {
  it('AC-1: keeps the prose and the visible sources, the CDC one restricted and counted', async () => {
    const { ana, saved } = await anaSavedThenAt('ci');

    const response = await read(ana.call, saved.id);

    expect(response.statusCode, response.body).toBe(200);
    const [turn] = response.json<ResearchConversation>().turns;
    expect(turn?.answer).toBe('A lua aparece em três graus [1] [2] [3].');
    expect(turn?.sources).toEqual([
      saved.turns[0]?.sources[0],
      saved.turns[0]?.sources[1],
      { n: 3, restricted: true },
    ]);
    expect(turn?.restrictedSources).toBe(1);
  });

  it('AC-2: the whole JSON of the read and of the list has no title, id or passage of the CDC document', async () => {
    const saved = aConversation([aTurn({ sweep: CURSOR })]);
    const { ana } = await anaSavedThenAt('ci', saved);

    const one = await read(ana.call, saved.id);
    const list = await ana.call('GET', URL);

    expect(one.statusCode).toBe(200);
    expectNothingHidden(one.body);
    expect(one.json<ResearchConversation>().turns[0]?.sweep?.findings).toEqual([
      CURSOR.findings[0],
    ]);
    expect(list.statusCode).toBe(200);
    expectNothingHidden(list.body);
  });

  it('AC-3: back at CDC, the source is whole again (the file never lost anything)', async () => {
    const saved = aConversation([aTurn({ sweep: CURSOR })]);
    const { world, ana } = await anaSavedThenAt('ci', saved);
    await read(ana.call, saved.id);

    await setPersonLevel(world, ana.id, { hermetismo: 'cdc' });
    const response = await read(ana.call, saved.id);

    const [turn] = response.json<ResearchConversation>().turns;
    expect(turn?.sources).toEqual(saved.turns[0]?.sources);
    expect(turn?.restrictedSources).toBeUndefined();
    expect(turn?.sweep).toEqual(CURSOR);
  });

  it('AC-4: a PUT with the CDC source whole answers and reads back masked', async () => {
    const { ana, saved } = await anaSavedThenAt('ci');

    const put = await ana.call('PUT', `${URL}/${saved.id}`, saved);
    const after = await read(ana.call, saved.id);

    expect(put.statusCode, put.body).toBe(200);
    expectNothingHidden(put.body);
    expectNothingHidden(after.body);
    expect(after.json<ResearchConversation>().turns[0]?.restrictedSources).toBe(
      1,
    );
  });

  it('BR-4: saving the masked copy the page read keeps the file whole', async () => {
    const saved = aConversation([aTurn({ sweep: CURSOR })]);
    const { world, ana } = await anaSavedThenAt('ci', saved);
    const masked = (
      await read(ana.call, saved.id)
    ).json<ResearchConversation>();

    const put = await ana.call('PUT', `${URL}/${saved.id}`, {
      ...masked,
      updatedAt: '2026-11-10T13:00:00.000Z',
    });
    await setPersonLevel(world, ana.id, { hermetismo: 'cdc' });
    const whole = await read(ana.call, saved.id);

    expect(put.statusCode, put.body).toBe(200);
    const [turn] = whole.json<ResearchConversation>().turns;
    expect(turn?.sources).toEqual(saved.turns[0]?.sources);
    expect(turn?.sweep).toEqual(CURSOR);
  });

  it('AC-6: once she loses the collection, every source of its conversation is restricted', async () => {
    const { world, ana, saved } = await anaSavedThenAt('cdc');
    const revoked = await world.owner('PATCH', `/api/v1/people/${ana.id}`, {
      topics: ['alquimia'],
    });
    expect(revoked.statusCode, revoked.body).toBe(200);

    const response = await read(ana.call, saved.id);

    expect(response.statusCode, response.body).toBe(200);
    const [turn] = response.json<ResearchConversation>().turns;
    expect(turn?.sources).toEqual([
      { n: 1, restricted: true },
      { n: 2, restricted: true },
      { n: 3, restricted: true },
    ]);
    expect(turn?.restrictedSources).toBe(3);
    expect(response.body).not.toContain('Lua Primeira Aberta');
  });

  it('AC-8: at the level that cited them, or as the master, nothing is masked', async () => {
    const { world, ana, saved } = await anaSavedThenAt('cdc');

    const hers = await read(ana.call, saved.id);

    const [turn] = hers.json<ResearchConversation>().turns;
    expect(turn?.sources).toEqual(saved.turns[0]?.sources);
    expect(turn?.restrictedSources).toBeUndefined();
    const own = aConversation();
    await world.owner('PUT', `${URL}/${own.id}`, own);
    const owner = await read(world.owner, own.id);
    expect(owner.json<ResearchConversation>().turns[0]?.sources).toEqual(
      own.turns[0]?.sources,
    );
  });
});
