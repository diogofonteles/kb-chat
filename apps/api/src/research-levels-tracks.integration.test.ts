import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  KbDocument,
  ResearchEvent,
  SweepCoverage,
} from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  caller,
  closeApp,
  events,
  signIn,
  type Call,
} from '../test/ai-app-harness.js';
import {
  changeMedia,
  memberWith,
  trackWorld,
  type TrackWorld,
} from '../test/track-documents-harness.js';
import { StubLlmAdapter, type StubReply } from './adapters/stub-llm-adapter.js';

/*
 * KBC-106 AC-4 (KBC-104 review #1): in a collection with a scale a track document answers by
 * the track's own level in media.db: a member below it gets no tool, sweep, SSE event or "Veja
 * também" that names the track, even with `media`, `media-tracks` and `media-research`. A
 * member at the track's level, and the master, find it (controls).
 */

const RESEARCHER = [
  'search',
  'research',
  'media',
  'media-tracks',
  'media-research',
];

const call = (name: string, args: Record<string, unknown>): StubReply => ({
  toolCalls: [{ name, arguments: args }],
});

/** "pêndulo" is said only in the first track. */
const LOOKING: readonly StubReply[] = [
  call('search_collection', { query: 'pêndulo', mode: 'all' }),
  call('find_text', { phrase: 'pêndulo', output_mode: 'files' }),
  call('find_text', { source: 'faixas-de-audio', output_mode: 'files' }),
  call('list_sources', {}),
  { text: 'Nada de faixas [1].' },
];

const PLAN: StubReply = {
  toolCalls: [
    {
      name: 'plan_sweep',
      arguments: { target: {}, phrases: ['pêndulo'], extract: 'o pêndulo' },
    },
  ],
};

afterEach(closeApp);

async function scaled(script: readonly StubReply[]) {
  const batches: string[] = [];
  const llm = new StubLlmAdapter({
    script,
    batchReply: (user) => {
      batches.push(user);
      return '';
    },
  });
  const tracks = await trackWorld({ llm });
  const owner = tracks.world.media.owner;
  for (const code of ['QS', 'CDC']) {
    const scale = await owner('POST', '/api/v1/topics/hermetismo/levels', {
      code,
    });
    expect(scale.statusCode, scale.body).toBe(201);
  }
  // Both tracks above the recording (QS): their own level, as the track edit writes it.
  for (const one of [tracks.track, tracks.other])
    changeMedia(tracks.world, {
      id: one.id,
      set: { level: 'cdc', level_own: '1' },
    });
  return { tracks, llm, batches, owner };
}

/** A researcher of hermetismo placed at `level` there. */
async function researcherAt(tracks: TrackWorld, level: string): Promise<Call> {
  const { media } = tracks.world;
  const email = `alto-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const invited = await media.owner('POST', '/api/v1/people', { email });
  expect(invited.statusCode, invited.body).toBe(201);
  const placed = await media.owner(
    'PATCH',
    `/api/v1/people/${invited.json<{ id: string }>().id}`,
    {
      topics: ['hermetismo'],
      features: RESEARCHER,
      levels: { hermetismo: level },
    },
  );
  expect(placed.statusCode, placed.body).toBe(200);
  return caller(media.started.app, await signIn(media.started, email));
}

async function ask(who: Call, llm: StubLlmAdapter, profile = 'deep') {
  const seen = llm.messagesSeen.length;
  const asked = await who('POST', '/api/v1/topics/hermetismo/research', {
    question: 'o que se diz do pêndulo?',
    profile,
  });
  expect(asked.statusCode, asked.body).toBe(200);
  const told = llm.messagesSeen
    .slice(seen)
    .flat()
    .map((message) => message.content)
    .join('\n');
  return { body: asked.body, stream: events(asked.body), told };
}

/** Nothing of either track: its title, its media id, its document path or its label. */
function expectNoTrack(text: string, { track, other, recording }: TrackWorld) {
  for (const id of [track.id, other.id, recording.id])
    expect(text).not.toContain(id);
  expect(text).not.toContain('faixa de áudio (transcrição automática');
  expect(text).not.toContain('O que é o ritmo?');
  expect(text).not.toContain('pêndulo que tudo governa');
}

const coverageOf = (stream: readonly ResearchEvent[]): SweepCoverage => {
  const done = stream.find((event) => event.type === 'done');
  if (done?.type !== 'done' || !done.coverage) throw new Error('no coverage');
  return done.coverage;
};

describe('Track documents with their own level (KBC-106 AC-4, KBC-104 review #1)', () => {
  it('a member with every media permission gets no track from any tool, nor in the SSE', async () => {
    const { tracks, llm, owner } = await scaled(LOOKING);
    const member = await memberWith(tracks.world, RESEARCHER);
    const asMember = await ask(member, llm);
    expectNoTrack(asMember.told, tracks);
    expectNoTrack(asMember.body, tracks);
    // Control: the master sees the track the same tools find.
    const asMaster = await ask(owner, llm);
    expect(asMaster.told).toContain('O que é o ritmo?');
  });

  it('nor in the exhaustive sweep: set, batches and coverage leave the tracks out', async () => {
    const { tracks, llm, batches, owner } = await scaled([PLAN]);
    const member = await memberWith(tracks.world, RESEARCHER);
    const asMember = await ask(member, llm, 'exhaustive');
    const coverage = coverageOf(asMember.stream);
    expect(coverage.tracks).toBeUndefined();
    expect(coverage.withHits).toBe(0);
    expectNoTrack(batches.join('\n'), tracks);
    expectNoTrack(asMember.body, tracks);
    batches.length = 0;
    const asMaster = await ask(owner, llm, 'exhaustive');
    expect(coverageOf(asMaster.stream).tracks).toMatchObject({ documents: 2 });
  });

  it('a member at the tracks\' level finds them; one below does not see them in "Veja também"', async () => {
    const { tracks, llm } = await scaled(LOOKING);
    const high = await researcherAt(tracks, 'cdc');
    const asHigh = await ask(high, llm);
    expect(asHigh.told).toContain('O que é o ritmo?');

    // "Veja também": the track kb linked to a concept, for whoever reaches its level only.
    const file = join(tracks.vault, 'hermetismo', tracks.path);
    const text = await readFile(file, 'utf8');
    await writeFile(
      file,
      text.replace(/^---\n/, '---\nexample_of: ["[[Ritmo]]"]\n'),
    );
    await tracks.world.media.started.catalog.load();
    const concept = encodeURIComponent('wiki/concepts/Ritmo.md');
    const examples = async (who: Call) => {
      const read = await who(
        'GET',
        `/api/v1/topics/hermetismo/documents/${concept}/relations/examples?limit=50`,
      );
      expect(read.statusCode, read.body).toBe(200);
      return read.json<{ items: { id: string; media?: unknown }[] }>().items;
    };
    expect((await examples(high)).some((one) => one.media)).toBe(true);
    const low = await memberWith(tracks.world, RESEARCHER);
    expect((await examples(low)).some((one) => one.media)).toBe(false);
    const page = await low(
      'GET',
      `/api/v1/topics/hermetismo/documents/${concept}`,
    );
    expect(page.json<KbDocument>().seeAlso.examples.items).not.toContainEqual(
      expect.objectContaining({ id: tracks.path }),
    );
    expect(page.body).not.toContain(tracks.track.id);
  });
});
