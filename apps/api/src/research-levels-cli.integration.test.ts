import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp, events } from '../test/ai-app-harness.js';
import {
  HIDDEN_TITLES,
  SIX,
  memberOf,
  setPersonLevel,
  sixAtThreeLevels,
  startLevels,
  type LevelsWorld,
} from '../test/levels-world.js';

/*
 * KBC-104 BR-5, AC-5 (ADR 0036 §7): an external model reaches only the turn's MCP tools,
 * built with the person's view. The fake Claude CLI (the owner's subscription lent to Ana)
 * and the fake Codex behind its sandbox runner call the tools and log what they got.
 */

afterEach(closeApp);

const OPEN_TITLES = [
  'Lua Primeira Aberta',
  'Lua Segunda Aberta',
  'Lua Media Uno',
  'Lua Media Duo',
];

/** What the fake CLI calls over the turn's MCP endpoint. */
const CALLS = [
  { name: 'search_collection', arguments: { query: 'lua', mode: 'all' } },
  {
    name: 'find_text',
    arguments: { phrase: 'lua', output_mode: 'files' },
  },
  { name: 'list_sources', arguments: {} },
  { name: 'read_document', arguments: { document: 'raw/cdc-1.md' } },
];

interface Logged {
  readonly name: string;
  readonly text: string;
}

/** Writes the fake CLI's settings in `home` and returns a reader of its tool log. */
async function scriptCli(home: string): Promise<() => Promise<Logged[]>> {
  const toolLog = join(home, 'tool-log.jsonl');
  await writeFile(
    join(home, 'fake-cli.json'),
    JSON.stringify({ calls: CALLS, toolLog }),
  );
  return async () =>
    (await readFile(toolLog, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Logged);
}

/** Ana at CI, served by the AI `appAi` the owner lends her. */
async function anaLent(
  world: LevelsWorld,
  appAi: string,
  extra: { readonly dailyResearches?: number } = {},
) {
  const ana = await memberOf(world, 'ana@example.com');
  await sixAtThreeLevels(world);
  await setPersonLevel(world, ana.id, { hermetismo: 'ci' });
  const lent = await world.owner('PATCH', `/api/v1/people/${ana.id}`, {
    ai: { appAi, subscriptionTermsAccepted: true, ...extra },
  });
  expect(lent.statusCode, lent.body).toBe(200);
  return ana;
}

async function askAsAna(ana: Awaited<ReturnType<typeof anaLent>>) {
  const asked = await ana.call('POST', '/api/v1/topics/hermetismo/research', {
    question: 'o que dizem sobre a lua?',
    profile: 'deep',
  });
  expect(asked.statusCode, asked.body).toBe(200);
  return asked.body;
}

function expectOnlyVisible(logged: readonly Logged[], body: string) {
  expect(logged.map((one) => one.name)).toEqual(CALLS.map((one) => one.name));
  const told = logged.map((one) => one.text).join('\n');
  for (const title of OPEN_TITLES) expect(told).toContain(title);
  for (const title of HIDDEN_TITLES) {
    expect(told).not.toContain(title);
    expect(body).not.toContain(title);
  }
  expect(told).toContain('Outros autores 4 ');
  // find_text on its own: the 4 visible documents with "lua".
  expect(logged[1]?.text).toMatch(/\b4 documento/);
  expect(logged.at(-1)?.text).toContain('não encontrado');
  expect(body).not.toContain('cdc-');
}

describe('External models over the turn MCP within the person level (KBC-104 AC-5)', () => {
  it("the owner's Claude subscription lent to Ana sees only her 4 documents", async () => {
    const world = await startLevels(SIX, { claude: true });
    const toolLog = await scriptCli(world.started.state);
    const ana = await anaLent(world, 'claude-subscription');
    const body = await askAsAna(ana);
    expectOnlyVisible(await toolLog(), body);
  });

  it('Codex through its sandbox runner, lent to Ana, sees only her 4 documents', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'kbchat-codex-home-'));
    const toolLog = await scriptCli(codexHome);
    const world = await startLevels(SIX, { codexHome });
    const on = await world.owner('PUT', '/api/v1/house-ai', {
      codexEnabled: true,
    });
    expect(on.statusCode, on.body).toBe(200);
    const ana = await anaLent(world, 'chatgpt-subscription');
    const body = await askAsAna(ana);
    expectOnlyVisible(await toolLog(), body);
  });
  it('QA F-3: the exhaustive sweep through the lent Claude CLI covers only her 4 documents', async () => {
    const world = await startLevels(SIX, { claude: true });
    const home = world.started.state;
    const runLog = join(home, 'run-log.jsonl');
    const plan = {
      target: {},
      phrases: ['lua'],
      extract: 'o que se diz da lua',
    };
    await writeFile(
      join(home, 'fake-cli.json'),
      JSON.stringify({
        calls: [{ name: 'plan_sweep', arguments: plan }],
        log: runLog,
      }),
    );
    // An exhaustive turn takes 100 house units; the quota is raised for this test only.
    const ana = await anaLent(world, 'claude-subscription', {
      dailyResearches: 200,
    });
    const asked = await ana.call('POST', '/api/v1/topics/hermetismo/research', {
      question: 'Liste tudo sobre a lua',
      profile: 'exhaustive',
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const stream = events(asked.body);
    const done = stream.find((event) => event.type === 'done');
    expect(done, asked.body.slice(-600)).toMatchObject({
      type: 'done',
      coverage: { documents: 4, withHits: 4 },
    });
    const runs = await readFile(runLog, 'utf8');
    // The batches the CLI read: the visible titles, never a CDC one.
    expect(runs).toContain('Lua Primeira Aberta');
    for (const title of HIDDEN_TITLES) {
      expect(runs).not.toContain(title);
      expect(asked.body).not.toContain(title);
    }
    expect(asked.body).not.toContain('cdc-');
  });
});
