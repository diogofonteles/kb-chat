import type {
  AnswerSource,
  MediaTranscript,
  ResearchEvent,
  SweepCoverage,
  SweepCursor,
  SweepPlan,
} from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp, events, type Call } from '../test/ai-app-harness.js';
import {
  SUB,
  memberWith,
  moveToSub,
  trackWorld,
  type TrackWorld,
} from '../test/track-documents-harness.js';
import { StubLlmAdapter, type StubReply } from './adapters/stub-llm-adapter.js';

/*
 * KBC-101 BR-1 to BR-4: in the exhaustive profile a visible track is a document of the set
 * like a text: planned, cut by the phrases, read in batches and counted apart in the
 * coverage the app measures. A stub model plans and answers; no real model, no kb.
 */

afterEach(closeApp);

const RESEARCHER = [
  'search',
  'research',
  'media',
  'media-tracks',
  'media-research',
];
const QUESTION = 'Liste tudo o que o acervo diz sobre o pêndulo';

const plan = (
  target: SweepPlan['target'],
  phrases: string[] = [],
): StubReply => ({
  toolCalls: [
    {
      name: 'plan_sweep',
      arguments: {
        target,
        phrases,
        extract: 'o que se diz do pêndulo, com o trecho',
      },
    },
  ],
});

interface Sweep {
  readonly tracks: TrackWorld;
  readonly llm: StubLlmAdapter;
  /** Every batch's text, as the model got it. */
  readonly batches: string[];
}

/** A track world whose stub plans `first`, writes `reply` per batch and answers `answer`. */
async function sweepWorld(
  script: readonly StubReply[],
  reply: (user: string) => string = () => '',
  finalText?: string,
): Promise<Sweep> {
  const batches: string[] = [];
  const llm = new StubLlmAdapter({
    script,
    ...(finalText && { finalText }),
    batchReply: (user) => {
      batches.push(user);
      return reply(user);
    },
  });
  return { tracks: await trackWorld({ llm }), llm, batches };
}

async function exhaustive(
  who: Call,
  extra: { sweep?: SweepCursor } = {},
): Promise<ResearchEvent[]> {
  const asked = await who('POST', '/api/v1/topics/hermetismo/research', {
    question: QUESTION,
    profile: 'exhaustive',
    ...extra,
  });
  expect(asked.statusCode, asked.body).toBe(200);
  return events(asked.body);
}

function coverageOf(stream: readonly ResearchEvent[]): SweepCoverage {
  const done = stream.find((event) => event.type === 'done');
  if (done?.type !== 'done' || !done.coverage)
    throw new Error(`no coverage: ${JSON.stringify(stream.at(-1))}`);
  return done.coverage;
}

const plannedOf = (stream: readonly ResearchEvent[]) =>
  stream.flatMap((event) =>
    event.type === 'sweep' && event.sweep.status === 'planned'
      ? [event.sweep]
      : [],
  )[0];

/** How many documents the collection and its sub-collection have, texts only. */
function textCount(tracks: TrackWorld): number {
  const { catalog } = tracks.world.media.started;
  return [...(catalog.scopeView('hermetismo')?.entries.values() ?? [])].filter(
    (entry) => entry.media === null,
  ).length;
}

describe('tracks in the exhaustive sweep (KBC-101)', () => {
  it('AC-1, NFR-2: with no phrases every text and track is read, and the coverage counts the tracks apart', async () => {
    const { tracks, llm, batches } = await sweepWorld([
      plan({}),
      { text: 'Tudo lido [1].' },
    ]);
    const stream = await exhaustive(await memberWith(tracks.world, RESEARCHER));
    const coverage = coverageOf(stream);
    const texts = textCount(tracks);
    expect(coverage).toMatchObject({
      documents: texts + 2,
      read: texts + 2,
      missing: 0,
      tracks: { documents: 2, read: 2 },
    });
    const told = batches.join('\n');
    expect(told).toContain(
      'O que é o ritmo? · faixa de áudio (transcrição automática)',
    );
    expect(told).toContain('gravação “Palestra de 12/03/2017” · faixa 1 de 2');
    expect(told).toContain('[0:41] O ritmo é a lei do pêndulo');
    // NFR-2: the estimate is the requests made, give or take one.
    const planned = plannedOf(stream);
    // Every call the stub got this turn (batch calls included).
    const made = llm.agentCalls.length;
    expect(Math.abs((planned?.requests ?? 0) - made)).toBeLessThanOrEqual(1);
  });

  it('AC-2: phrases said only in a track send only it to a batch; the rest are checked by the phrases', async () => {
    const { tracks, batches } = await sweepWorld([
      plan({}, ['pêndulo']),
      { text: 'Só a faixa [1].' },
    ]);
    const coverage = coverageOf(
      await exhaustive(await memberWith(tracks.world, RESEARCHER)),
    );
    expect(coverage).toMatchObject({
      documents: textCount(tracks) + 2,
      scanned: textCount(tracks) + 2,
      withHits: 1,
      needed: 1,
      read: 1,
      tracks: { documents: 2, read: 1 },
    });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toContain('O que é o ritmo?');
  });

  it('AC-3: the authorship filter leaves out a track of other authors; "Faixas de áudio" keeps only tracks', async () => {
    const { tracks, batches } = await sweepWorld([
      plan({ authorship: 'mestre-laercio' }),
      { text: 'Nada.' },
    ]);
    await moveToSub(tracks, { otherAuthor: true });
    const researcher = await memberWith(tracks.world, RESEARCHER);
    const main = coverageOf(await exhaustive(researcher));
    expect(main.tracks).toEqual({ documents: 1, read: 1 });
    expect(batches.join('\n')).not.toContain('O que é o ritmo?');

    const onlyTracks = await sweepWorld([
      plan({ source: 'faixas-de-audio' }),
      { text: 'Faixas.' },
    ]);
    const coverage = coverageOf(
      await exhaustive(await memberWith(onlyTracks.tracks.world, RESEARCHER)),
    );
    expect(coverage).toMatchObject({
      documents: 2,
      read: 2,
      tracks: { documents: 2, read: 2 },
    });
  });

  it('AC-4: a finding that quotes a track resolves to that segment of media.db', async () => {
    const { tracks } = await sweepWorld(
      [plan({ source: 'faixas-de-audio' })],
      (user) => {
        const label = /\[D(\d+)\] O que é o ritmo\?/.exec(user)?.[1];
        return label
          ? `- [D${label}] Diz que “o ritmo é a lei do pêndulo que tudo governa”.`
          : '';
      },
      'Segundo a faixa, o ritmo é a lei do pêndulo [1].',
    );
    const stream = await exhaustive(await memberWith(tracks.world, RESEARCHER));
    const sources =
      stream
        .flatMap((event) => (event.type === 'sources' ? [event.sources] : []))
        .at(-1) ?? [];
    const cited = sources.find(
      (one: AnswerSource) => one.media?.mediaId === tracks.track.id,
    );
    const transcript = (
      await tracks.world.media.owner(
        'GET',
        `/api/v1/media/${tracks.track.id}/transcript`,
      )
    ).json<MediaTranscript>();
    const spoken = transcript.segments.find(
      (one) => Math.floor(one.startMs / 1000) === 41,
    );
    expect(cited?.passages?.[0]).toEqual({
      at: '',
      startMs: spoken?.startMs,
      endMs: spoken?.endMs,
    });
  });

  it('AC-5: without media-research the set and the coverage have no track and nothing says "faixas"', async () => {
    const { tracks, batches } = await sweepWorld([plan({}), { text: 'Nada.' }]);
    const coverage = coverageOf(
      await exhaustive(
        await memberWith(tracks.world, [
          'search',
          'research',
          'media',
          'media-tracks',
        ]),
      ),
    );
    expect(coverage.documents).toBe(textCount(tracks));
    expect(coverage.tracks).toBeUndefined();
    expect(JSON.stringify(coverage)).not.toMatch(/faixa/i);
    expect(batches.join('\n')).not.toMatch(/faixa de áudio|O que é o ritmo\?/);
  });

  it('AC-6: a track in a sub-collection is found by find_text and swept from the parent', async () => {
    const { tracks, llm } = await sweepWorld([
      { toolCalls: [{ name: 'find_text', arguments: { phrase: 'pêndulo' } }] },
      plan({}, ['pêndulo']),
      { text: 'A faixa [1].' },
    ]);
    await moveToSub(tracks);
    const coverage = coverageOf(
      await exhaustive(await memberWith(tracks.world, RESEARCHER)),
    );
    const told = llm.messagesSeen
      .flat()
      .filter((message) => message.role === 'tool')
      .map((message) => message.content)
      .join('\n');
    expect(told).toContain('O que é o ritmo?');
    expect(coverage).toMatchObject({
      withHits: 1,
      tracks: { documents: 2, read: 1 },
    });
    expect(
      tracks.world.media.started.catalog
        .scopeView('hermetismo')
        ?.entries.get(`palestras/${tracks.path}`)?.home,
    ).toEqual({ topic: SUB, id: tracks.path });
  });

  it('AC-8: a cursor from before the covered mark reads the tracks that joined its set, wherever their ids sort', async () => {
    const { tracks, batches } = await sweepWorld([
      { text: 'Continuação [1].' },
    ]);
    const view = tracks.world.media.started.catalog.scopeView('hermetismo');
    const entries = [...(view?.entries.values() ?? [])];
    const texts = entries
      .filter((e) => e.media === null && !e.home)
      .map((e) => e.id)
      .sort();
    const lastText = texts.at(-1) ?? '';
    expect(entries.some((e) => e.media && e.id < lastText)).toBe(true);
    const cursor: SweepCursor = {
      plan: { target: {}, phrases: [], extract: 'tudo' },
      after: lastText,
      totals: {
        documents: entries.length,
        scanned: texts.length,
        withHits: null,
        read: texts.length,
        batches: 3,
      },
      findings: [],
    };
    const coverage = coverageOf(
      await exhaustive(await memberWith(tracks.world, RESEARCHER), {
        sweep: cursor,
      }),
    );
    expect(coverage).toMatchObject({
      continued: true,
      documents: entries.length,
      read: entries.length,
      missing: 0,
      tracks: { documents: 2, read: 2 },
    });
    const swept = batches.join('\n');
    expect(swept).toContain('O que é o ritmo?');
    expect(swept).not.toContain('A LEI DO RITMO');
  });

  it('AC-8: "Continuar varredura" resumes after the last document swept and the coverage adds the tracks', async () => {
    const { tracks, batches } = await sweepWorld([
      { text: 'Continuação [1].' },
    ]);
    const view = tracks.world.media.started.catalog.scopeView('hermetismo');
    const ids = [...(view?.entries.keys() ?? [])].sort();
    const lastText = ids.filter((id) => id < 'raw/media/').at(-1);
    const done = ids.filter((id) => id <= (lastText ?? '')).length;
    const cursor: SweepCursor = {
      plan: { target: {}, phrases: [], extract: 'tudo' },
      ...(lastText && { after: lastText }),
      totals: {
        documents: ids.length,
        scanned: done,
        withHits: null,
        read: done,
        batches: 3,
      },
      findings: [],
    };
    const coverage = coverageOf(
      await exhaustive(await memberWith(tracks.world, RESEARCHER), {
        sweep: cursor,
      }),
    );
    expect(coverage).toMatchObject({
      continued: true,
      documents: ids.length,
      read: ids.length,
      missing: 0,
      tracks: { documents: 2, read: 2 },
    });
    const swept = batches.join('\n');
    expect(swept).toContain('O que é o ritmo?');
    expect(swept).not.toContain('A LEI DO RITMO');
  });
});
