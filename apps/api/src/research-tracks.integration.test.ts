import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AnswerSource,
  MediaItem,
  MediaTranscript,
  ResearchEvent,
  SearchResponse,
} from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  caller,
  closeApp,
  events,
  signIn,
  type Call,
} from '../test/ai-app-harness.js';
import { FIXTURE_VAULT } from '../test/fixture-paths.js';
import {
  kbResult,
  leaseKb,
  publishedTracks,
  publisherMac,
  writeAsMac,
} from '../test/kb-publish-harness.js';
import { startWorld, type World } from '../test/track-items-harness.js';
import { StubLlmAdapter, type StubReply } from './adapters/stub-llm-adapter.js';

afterEach(closeApp);

const QUESTION = 'O que é o ritmo?';

const call = (name: string, args: Record<string, unknown>): StubReply => ({
  toolCalls: [{ name, arguments: args }],
});

/** Searches "pêndulo" (said only in the track), reads [1] around it, then `answer`. */
const reading = (answer: string): StubReply[] => [
  call('search_collection', { query: 'pêndulo', mode: 'all' }),
  call('read_document', { document: 1, around: 'pêndulo' }),
  { text: answer },
];

interface TrackWorld {
  readonly world: World;
  readonly llm: StubLlmAdapter;
  readonly track: MediaItem;
  readonly recording: MediaItem;
  readonly path: string;
}

/**
 * A recording of `hermetismo` with two tracks, published through the Mac (the fake kb), in
 * a vault copy: the whole path of KBC-099 up to the catalog.
 */
async function trackWorld(
  script: readonly StubReply[],
  beforeCatalog?: (world: World) => Promise<void>,
): Promise<TrackWorld> {
  const vault = await mkdtemp(join(tmpdir(), 'kbchat-vault-'));
  await cp(FIXTURE_VAULT, vault, { recursive: true });
  const llm = new StubLlmAdapter({ script });
  const world = await startWorld({ vault, llm });
  const { recording, tracks } = await publishedTracks(world);
  const mac = await publisherMac(world.media);
  const job = await leaseKb(world.media, mac.token);
  await beforeCatalog?.(world);
  await writeAsMac(vault, job);
  expect(
    (await kbResult(world.media, { token: mac.token, job })).statusCode,
  ).toBe(204);
  await world.media.started.catalog.refresh('hermetismo');
  const [track] = tracks;
  if (!track) throw new Error('no track');
  return {
    world,
    llm,
    track,
    recording,
    path: `raw/media/${recording.id}/${track.id}.md`,
  };
}

/** A member of `hermetismo` with exactly these features. */
async function memberWith(
  world: World,
  features: readonly string[],
): Promise<Call> {
  const { media } = world;
  const email = `${features.join('-') || 'nada'}@example.com`;
  const invited = await media.owner('POST', '/api/v1/people', { email });
  expect(invited.statusCode, invited.body).toBe(201);
  const updated = await media.owner(
    'PATCH',
    `/api/v1/people/${invited.json().id}`,
    {
      topics: ['hermetismo'],
      features,
    },
  );
  expect(updated.statusCode, updated.body).toBe(200);
  return caller(media.started.app, await signIn(media.started, email));
}

const RESEARCHER = [
  'search',
  'research',
  'media',
  'media-tracks',
  'media-research',
];

const ask = async (who: Call, profile = 'fast') => {
  const asked = await who('POST', '/api/v1/topics/hermetismo/research', {
    question: QUESTION,
    profile,
  });
  expect(asked.statusCode, asked.body).toBe(200);
  return events(asked.body);
};

/** The sources as the reader keeps them: the last `sources` event. */
const finalSources = (stream: readonly ResearchEvent[]): AnswerSource[] =>
  stream
    .flatMap((event) => (event.type === 'sources' ? [event.sources] : []))
    .at(-1) ?? [];

/** Everything the tools told the model this turn. */
const toolTexts = (llm: StubLlmAdapter): string =>
  (llm.messagesSeen.at(-1) ?? [])
    .filter((message) => message.role === 'tool')
    .map((message) => message.content)
    .join('\n');

async function segmentAt(world: World, trackId: string, startSecond: number) {
  const read = await world.media.owner(
    'GET',
    `/api/v1/media/${trackId}/transcript`,
  );
  expect(read.statusCode, read.body).toBe(200);
  const segment = read
    .json<MediaTranscript>()
    .segments.find((one) => Math.floor(one.startMs / 1000) === startSecond);
  if (!segment) throw new Error(`no segment at ${startSecond}s`);
  return { startMs: segment.startMs, endMs: segment.endMs };
}

describe('research over tracks (KBC-099)', () => {
  it.each(['fast', 'deep'])(
    'AC-5 (%s): the track is found, read with its labels and anchors, and [1@0:41] is its segment in media.db',
    async (profile) => {
      const { world, llm, track } = await trackWorld(
        reading('O ritmo é a lei do pêndulo [1@0:41].'),
      );
      const stream = await ask(await memberWith(world, RESEARCHER), profile);
      const [cited] = finalSources(stream);
      expect(cited?.media).toMatchObject({
        mediaId: track.id,
        kind: 'track',
        recordingTitle: 'Palestra de 12/03/2017',
        ordinal: 1,
        total: 2,
        confidence: 'normal',
      });
      expect(cited?.title).toBe('O que é o ritmo?');
      expect(cited?.passages).toEqual([
        { at: '0:41', ...(await segmentAt(world, track.id, 41)) },
      ]);
      const told = toolTexts(llm);
      expect(told).toContain('faixa de áudio (transcrição automática)');
      expect(told).toContain(
        'gravação “Palestra de 12/03/2017” · faixa 1 de 2',
      );
      expect(told).toContain('Gravação: Palestra de 12/03/2017 · faixa 1 de 2');
      expect(told).toContain('[0:41] O ritmo é a lei do pêndulo');
      expect(told).toContain('cite um trecho como [1@m:ss]');
      expect(told).toContain('Autoria: Mestre Laércio');
    },
  );

  it('AC-8: a minute never shown falls back to the last passage shown; a plain [1] too', async () => {
    const { world, track } = await trackWorld(
      reading('Algo inventado [1@7:77] e ainda [1].'),
    );
    const stream = await ask(await memberWith(world, RESEARCHER));
    const [cited] = finalSources(stream);
    const shown = await segmentAt(world, track.id, 41);
    expect(cited?.passages).toEqual([
      { at: '7:77', ...shown },
      { at: '', ...shown },
    ]);
  });

  it("find_text shows each occurrence with its paragraph's anchor, and that anchor is citable", async () => {
    const { world, llm, track } = await trackWorld([
      call('find_text', { phrase: 'pêndulo', output_mode: 'content' }),
      { text: 'Segundo a faixa [1@0:41].' },
    ]);
    const stream = await ask(await memberWith(world, RESEARCHER));
    expect(toolTexts(llm)).toMatch(/- @\d+ \[0:41\]: /);
    expect(finalSources(stream)[0]?.passages).toEqual([
      { at: '0:41', ...(await segmentAt(world, track.id, 41)) },
    ]);
  });

  it.each([
    ['without media-research', ['search', 'research', 'media', 'media-tracks']],
    ['without media', ['search', 'research', 'media-tracks', 'media-research']],
    ['without media-tracks', ['search', 'research', 'media', 'media-research']],
  ])(
    'AC-6: %s, no tool lists, reads or finds the track, and no source brings it',
    async (_, features) => {
      // The script is filled once the track's id is known: it asks for it by id too.
      const script: StubReply[] = [];
      const { world, llm, path } = await trackWorld(script);
      script.push(
        call('search_collection', { query: 'pêndulo', mode: 'all' }),
        call('find_text', { phrase: 'pêndulo' }),
        call('read_document', { document: path }),
        call('list_sources', {}),
        { text: 'Nada [1@0:41].' },
      );
      const stream = await ask(await memberWith(world, features));
      const told = toolTexts(llm);
      expect(told).not.toContain('O que é o ritmo?');
      expect(told).not.toContain('faixa de áudio');
      expect(told).not.toContain('media/hermetismo');
      expect(told).toContain('não encontrado');
      for (const sources of stream.flatMap((e) =>
        e.type === 'sources' ? [e.sources] : [],
      ))
        expect(sources.every((source) => !source.media)).toBe(true);
    },
  );

  it('AC-6: without the collection, the question is refused before any tool', async () => {
    const { world } = await trackWorld([{ text: 'nada' }]);
    const outsider = await memberWith(world, RESEARCHER);
    const { media } = world;
    const people = await media.owner('GET', '/api/v1/people');
    const id = people
      .json<{ items: { id: string; email: string }[] }>()
      .items.find((one) => one.email.startsWith('search-research'))?.id;
    await media.owner('PATCH', `/api/v1/people/${id}`, { topics: [] });
    const asked = await outsider('POST', '/api/v1/topics/hermetismo/research', {
      question: QUESTION,
    });
    expect([403, 404]).toContain(asked.statusCode);
  });

  it('AC-7: a track archived after its publication is gone from research, the file still in the vault', async () => {
    const script: StubReply[] = [];
    const { world, llm, track, path } = await trackWorld(script);
    script.push(
      call('search_collection', { query: 'pêndulo', mode: 'all' }),
      call('read_document', { document: path }),
      { text: 'Nada.' },
    );
    const archived = await world.media.started.app.inject({
      method: 'DELETE',
      url: `/api/v1/media/${track.id}`,
      headers: world.media.ownerHeaders,
    });
    expect(archived.statusCode, archived.body).toBe(204);
    expect(
      world.media.started.catalog.get('hermetismo')?.entries.get(path),
    ).toBeDefined();
    await ask(await memberWith(world, RESEARCHER));
    const told = toolTexts(llm);
    expect(told).not.toContain('O que é o ritmo?');
    expect(told).toContain('não encontrado');
  });

  it('AC-13: "Buscar documentos" lists and counts the same texts with the track documents in the vault', async () => {
    const searchOf = async (world: World) => {
      const found = await world.media.owner(
        'POST',
        '/api/v1/topics/hermetismo/searches',
        {
          q: 'pêndulo ritmo',
          mode: 'all',
        },
      );
      expect(found.statusCode, found.body).toBe(200);
      return { ...found.json<SearchResponse>(), tookMs: 0 };
    };
    let before: Awaited<ReturnType<typeof searchOf>> | undefined;
    let countBefore = 0;
    const countOf = async (world: World) =>
      (await world.media.owner('GET', '/api/v1/topics'))
        .json<{ items: { slug: string; documentCount: number }[] }>()
        .items.find((one) => one.slug === 'hermetismo')?.documentCount ?? -1;
    const { world, path } = await trackWorld(
      [{ text: 'nada' }],
      async (one) => {
        before = await searchOf(one);
        countBefore = await countOf(one);
      },
    );
    expect(
      world.media.started.catalog.get('hermetismo')?.entries.get(path)?.media,
    ).not.toBeNull();
    const after = await searchOf(world);
    expect(after.items.map((hit) => hit.id)).toEqual(
      before?.items.map((hit) => hit.id),
    );
    expect(after).toEqual(before);
    expect(await countOf(world)).toBe(countBefore);
    const opened = await world.media.owner(
      'GET',
      `/api/v1/topics/hermetismo/documents/${encodeURIComponent(path)}`,
    );
    expect(opened.statusCode).toBe(404);
  });
});
