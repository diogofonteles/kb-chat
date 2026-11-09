import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  KbDocument,
  MediaTranscript,
  SearchHit,
  SearchRequest,
  SearchResponse,
  Topic,
  TopicFacets,
  TopicList,
} from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp, type Call } from '../test/ai-app-harness.js';
import {
  SUB,
  changeMedia,
  memberWith,
  moveToSub,
  trackWorld,
  type TrackWorld,
} from '../test/track-documents-harness.js';
import { transcribed } from '../test/track-items-harness.js';

/*
 * KBC-101: a transcribed track is a document of the collection in "Buscar documentos" (T2):
 * in the list, the facets and every count, for who has the collection, `media` and
 * `media-tracks`, while media.db confirms it; one card per track with "Na fala".
 */

afterEach(closeApp);

const LISTENER = ['search', 'media', 'media-tracks'];
const RESEARCHER = [
  'search',
  'research',
  'media',
  'media-tracks',
  'media-research',
];
const RECORDING = 'Palestra de 12/03/2017';

async function search(
  who: Call,
  request: SearchRequest,
  topic = 'hermetismo',
): Promise<SearchResponse> {
  const found = await who(
    'POST',
    `/api/v1/topics/${encodeURIComponent(topic)}/searches`,
    { limit: 50, ...request },
  );
  expect(found.statusCode, found.body).toBe(200);
  return found.json<SearchResponse>();
}

/** The topic list by slug. */
const topicsOf = (listed: { json: <T>() => T }): Map<string, Topic> =>
  new Map(listed.json<TopicList>().items.map((one) => [one.slug, one]));

const tracksOf = (found: SearchResponse): SearchHit[] =>
  found.items.filter((hit) => hit.media);

const countOf = (
  list: readonly { value: string | number; count: number }[],
  value: string | number,
): number =>
  list.find((one) => String(one.value) === String(value))?.count ?? 0;

/** The exact segment of a track that starts in this second, from media.db. */
async function segmentAt(tracks: TrackWorld, second: number) {
  const read = await tracks.world.media.owner(
    'GET',
    `/api/v1/media/${tracks.track.id}/transcript`,
  );
  const segment = read
    .json<MediaTranscript>()
    .segments.find((one) => Math.floor(one.startMs / 1000) === second);
  if (!segment) throw new Error(`no segment at ${second}s`);
  return { startMs: segment.startMs, endMs: segment.endMs };
}

/** Rewrites one frontmatter key of the track's document, as kb would, and reloads. */
async function setKey(tracks: TrackWorld, key: string, value: string) {
  const file = join(tracks.vault, 'hermetismo', tracks.path);
  const text = await readFile(file, 'utf8');
  const pattern = new RegExp(`^${key}: .*$`, 'm');
  await writeFile(
    file,
    pattern.test(text)
      ? text.replace(pattern, `${key}: ${value}`)
      : text.replace(/^---\n/, `---\n${key}: ${value}\n`),
  );
  await tracks.world.media.started.catalog.load();
}

describe('tracks in the documents search (KBC-101)', () => {
  it('AC-10, AC-13: the track is a card among the texts, counted apart, for media + media-tracks without media-research', async () => {
    const tracks = await trackWorld();
    const listener = await memberWith(tracks.world, LISTENER);
    const reader = await memberWith(tracks.world, ['search']);
    const found = await search(listener, { q: 'ritmo', kinds: ['text'] });
    const texts = await search(reader, { q: 'ritmo' });
    const all = await search(listener, { q: 'ritmo' });

    expect(tracksOf(texts)).toEqual([]);
    expect(texts.trackTotal).toBe(0);
    expect(found.trackTotal).toBe(0);
    // Both tracks speak of "ritmo" (kb's summary of each says so).
    expect(all.total).toBe(texts.total + 2);
    expect(all.trackTotal).toBe(2);
    const card = tracksOf(all).find((hit) => hit.id === tracks.path);
    expect(card).toMatchObject({
      id: tracks.path,
      topic: 'hermetismo',
      title: 'O que é o ritmo?',
      genre: 'talk_or_interview',
      relevance: 'core',
      concepts: ['Ritmo'],
      authorship: 'mestre-laercio',
      copies: [],
      media: {
        mediaId: tracks.track.id,
        kind: 'track',
        recordingTitle: RECORDING,
        ordinal: 1,
        total: 2,
        confidence: 'normal',
        stale: false,
      },
    });
    // FR-8: never the frontmatter, the heading nor an anchor.
    expect(card?.snippet).not.toMatch(/\[\d+:\d{2}\]|kb_chat_|^# /);
  });

  it('AC-11: the facets count the track, a choice it lacks hides it, and "Fora do tema" hides it by default', async () => {
    const tracks = await trackWorld();
    const listener = await memberWith(tracks.world, LISTENER);
    const reader = await memberWith(tracks.world, ['search']);
    const texts = await search(reader, { q: 'ritmo' });
    const all = await search(listener, { q: 'ritmo' });
    for (const [facet, value] of [
      ['genres', 'talk_or_interview'],
      ['depths', 2],
      ['relevances', 'core'],
      ['concepts', 'Ritmo'],
    ] as const)
      expect(
        countOf(all.facets[facet], value) - countOf(texts.facets[facet], value),
        facet,
      ).toBe(2);
    const deep = await search(listener, {
      q: 'ritmo',
      filters: { depths: [3] },
    });
    expect(tracksOf(deep)).toEqual([]);
    expect(deep.trackTotal).toBe(0);

    await setKey(tracks, 'relevance', 'off_topic');
    const hidden = await search(listener, { q: 'ritmo' });
    const hiddenTexts = await search(reader, { q: 'ritmo' });
    expect(tracksOf(hidden).map((hit) => hit.id)).not.toContain(tracks.path);
    expect(hidden.hiddenOffTopic).toBe(hiddenTexts.hiddenOffTopic + 1);
    const shown = await search(listener, {
      q: 'ritmo',
      filters: { relevances: ['off_topic'] },
    });
    expect(tracksOf(shown).map((hit) => hit.id)).toContain(tracks.path);
  });

  it('AC-12: a track of other authors in a sub-collection counts in "Outros autores", says where it is, and "Mestre Laércio" leaves it out', async () => {
    const tracks = await trackWorld();
    const id = await moveToSub(tracks, { otherAuthor: true });
    const listener = await memberWith(tracks.world, LISTENER);
    const reader = await memberWith(tracks.world, ['search']);
    const all = await search(listener, { q: 'ritmo' });
    const texts = await search(reader, { q: 'ritmo' });
    expect(
      tracksOf(all)
        .filter((hit) => hit.topic === SUB)
        .map((hit) => [hit.id, hit.authorship]),
    ).toEqual([[tracks.path, 'outros-autores']]);
    expect(id).toBe(`palestras/${tracks.path}`);
    expect(
      countOf(all.facets.authorships, 'outros-autores') -
        countOf(texts.facets.authorships, 'outros-autores'),
    ).toBe(1);
    expect(countOf(all.facets.topics, SUB)).toBe(1);
    const main = await search(listener, {
      q: 'ritmo',
      filters: { authorships: ['mestre-laercio'] },
    });
    expect(tracksOf(main).map((hit) => hit.topic)).not.toContain(SUB);
  });

  it.each([
    ['without media', ['search', 'media-tracks']],
    ['without media-tracks', ['search', 'media']],
  ])(
    'AC-13 %s: no list, count, facet, suggestion or "Buscar em" has the track',
    async (_, features) => {
      const tracks = await trackWorld();
      const who = await memberWith(tracks.world, features);
      const reader = await memberWith(tracks.world, ['search']);
      const found = await search(who, { q: 'ritmo' });
      const texts = await search(reader, { q: 'ritmo' });
      expect(tracksOf(found)).toEqual([]);
      expect(found.items).toEqual(texts.items);
      expect([found.total, found.trackTotal, found.kinds.text]).toEqual([
        texts.total,
        0,
        texts.kinds.text,
      ]);
      // "Autoria" also counts "Na fala" for who may listen: the document facets alone.
      for (const facet of [
        'genres',
        'depths',
        'relevances',
        'concepts',
        'topics',
      ] as const)
        expect(found.facets[facet], facet).toEqual(texts.facets[facet]);
      if (!features.includes('media')) expect(found.kinds.audio).toBeNull();
      const facets = (one: Call) =>
        one('GET', '/api/v1/topics/hermetismo/facets').then((r) =>
          r.json<TopicFacets>(),
        );
      expect(await facets(who)).toEqual(await facets(reader));
      const suggestions = (one: Call) =>
        one('GET', '/api/v1/topics/hermetismo/suggestions').then((r) =>
          r.json<unknown>(),
        );
      expect(await suggestions(who)).toEqual(await suggestions(reader));
    },
  );

  it('AC-13: without the collection the search is refused; the collection-wide counts take the track for who sees it', async () => {
    const tracks = await trackWorld();
    const listener = await memberWith(tracks.world, LISTENER);
    const reader = await memberWith(tracks.world, ['search']);
    const facets = (one: Call) =>
      one('GET', '/api/v1/topics/hermetismo/facets').then((r) =>
        r.json<TopicFacets>(),
      );
    expect(
      countOf((await facets(listener)).genres, 'talk_or_interview') -
        countOf((await facets(reader)).genres, 'talk_or_interview'),
    ).toBe(2);
    const outsider = await memberWith(tracks.world, LISTENER);
    const people = await tracks.world.media.owner('GET', '/api/v1/people');
    const id = people
      .json<{ items: { id: string; email: string }[] }>()
      .items.filter((one) => one.email.startsWith('search-media-media-tracks'))
      .at(-1)?.id;
    await tracks.world.media.owner('PATCH', `/api/v1/people/${id}`, {
      topics: [],
    });
    const refused = await outsider(
      'POST',
      '/api/v1/topics/hermetismo/searches',
      {
        q: 'ritmo',
      },
    );
    expect([403, 404]).toContain(refused.statusCode);
  });

  it('AC-14: archived, or moved to another collection, the track is gone at once; published there, it shows there', async () => {
    const tracks = await trackWorld();
    const listener = await memberWith(tracks.world, LISTENER);
    const { world, track, vault, path } = tracks;
    changeMedia(world, { id: track.id, set: { topic: 'alquimia' } });
    const moved = await search(listener, { q: 'ritmo' });
    expect(tracksOf(moved).map((hit) => hit.media?.mediaId)).toEqual([
      tracks.other.id,
    ]);
    expect(moved.trackTotal).toBe(1);
    const there = join(vault, 'alquimia', path);
    await mkdir(dirname(there), { recursive: true });
    await writeFile(
      there,
      await readFile(join(vault, 'hermetismo', path), 'utf8'),
    );
    await world.media.started.catalog.load();
    const alquimia = await search(
      world.media.owner,
      { q: 'ritmo' },
      'alquimia',
    );
    expect(tracksOf(alquimia).map((hit) => hit.media?.mediaId)).toEqual([
      track.id,
    ]);
    expect(
      tracksOf(await search(world.media.owner, { q: 'ritmo' })).map(
        (hit) => hit.media?.mediaId,
      ),
    ).toEqual([tracks.other.id]);

    changeMedia(world, {
      id: track.id,
      set: { topic: 'alquimia', archived_at: new Date().toISOString() },
    });
    expect(
      tracksOf(await search(world.media.owner, { q: 'ritmo' }, 'alquimia')),
    ).toEqual([]);
  });

  it('AC-15, AC-17: one card per track, with the spoken passage; "Buscar em" counts it once, under "Áudios"', async () => {
    const tracks = await trackWorld();
    const listener = await memberWith(tracks.world, LISTENER);
    const found = await search(listener, { q: 'pêndulo' });
    const [card] = tracksOf(found);
    expect(card?.media).toMatchObject({
      ...(await segmentAt(tracks, 41)),
      spoken: { text: 'O ritmo é a lei do pêndulo que tudo governa' },
    });
    const marked = card?.media?.spoken?.highlights.map(({ start, end }) =>
      card.media?.spoken?.text.slice(start, end),
    );
    expect(marked).toEqual(['pêndulo']);
    expect(
      found.media.filter((hit) => hit.mediaId === tracks.track.id),
    ).toEqual([]);
    expect(found.kinds.audio).toBe(1);

    const textsOnly = await search(listener, { q: 'pêndulo', kinds: ['text'] });
    expect(tracksOf(textsOnly)).toEqual([]);
    expect(textsOnly.media).toEqual([]);
    expect(textsOnly.kinds).toEqual(found.kinds);
    const audioOnly = await search(listener, { q: 'ritmo', kinds: ['audio'] });
    expect(audioOnly.items.every((hit) => hit.media)).toBe(true);
    expect(audioOnly.items).toHaveLength(2);
    expect(audioOnly.total).toBe(2);
  });

  it('BR-8: a track hidden as "Fora do tema" keeps its "Na fala" passage until its card is shown', async () => {
    const tracks = await trackWorld();
    const listener = await memberWith(tracks.world, LISTENER);
    await setKey(tracks, 'relevance', 'off_topic');
    const spokenOf = (found: SearchResponse) =>
      found.media.filter((hit) => hit.mediaId === tracks.track.id);

    const hidden = await search(listener, { q: 'pêndulo' });
    expect(tracksOf(hidden)).toEqual([]);
    expect(spokenOf(hidden)).not.toEqual([]);
    const shown = await search(listener, {
      q: 'pêndulo',
      filters: { relevances: ['off_topic'] },
    });
    expect(tracksOf(shown).map((hit) => hit.media?.mediaId)).toEqual([
      tracks.track.id,
    ]);
    expect(spokenOf(shown)).toEqual([]);
  });

  it('AC-16: a recording without tracks and its document are one card; a track still without a document keeps its "Na fala" card', async () => {
    let alone: { id: string } | undefined;
    const tracks = await trackWorld({
      beforeTracks: async (world) => {
        alone = await transcribed(
          world,
          [{ at: 10, text: 'O ritmo da respiração serena' }],
          {
            title: 'Conversa sem faixas',
          },
        );
      },
    });
    const { world, vault, other } = tracks;
    if (!alone) throw new Error('no recording');
    await rm(
      join(
        vault,
        'hermetismo',
        `raw/media/${tracks.recording.id}/${other.id}.md`,
      ),
    );
    await world.media.started.catalog.load();
    const listener = await memberWith(world, LISTENER);

    const breath = await search(listener, { q: 'respiração' });
    expect(
      tracksOf(breath).map((hit) => [hit.media?.mediaId, hit.media?.kind]),
    ).toEqual([[alone?.id, 'recording']]);
    expect(breath.media.filter((hit) => hit.mediaId === alone?.id)).toEqual([]);
    const polarity = await search(listener, { q: 'polaridade' });
    expect(tracksOf(polarity)).toEqual([]);
    expect(polarity.media.map((hit) => hit.mediaId)).toContain(other.id);
  });

  it('AC-18: a text and a track with the same title are two cards, never copies', async () => {
    const tracks = await trackWorld();
    const file = join(
      tracks.vault,
      'hermetismo',
      'raw/articles/o-que-e-o-ritmo.md',
    );
    await writeFile(
      file,
      '---\ntitle: O que é o ritmo?\ntype: source\n---\n\nUm texto sobre o ritmo.\n',
    );
    await tracks.world.media.started.catalog.load();
    const listener = await memberWith(tracks.world, LISTENER);
    const found = await search(listener, { q: 'ritmo' });
    const same = found.items.filter((hit) => hit.title === 'O que é o ritmo?');
    expect(same).toHaveLength(2);
    expect(same.every((hit) => hit.copies.length === 0)).toBe(true);
  });

  it('AC-9: the texts keep their order, counts and the topic list with the tracks in the vault (KBC-099 AC-13 replaced)', async () => {
    const tracks = await trackWorld();
    const listener = await memberWith(tracks.world, LISTENER);
    const reader = await memberWith(tracks.world, ['search']);
    const all = await search(listener, { q: 'pêndulo ritmo' });
    const texts = await search(reader, { q: 'pêndulo ritmo' });
    expect(all.items.filter((hit) => !hit.media).map((hit) => hit.id)).toEqual(
      texts.items.map((hit) => hit.id).slice(0, all.items.length - 1),
    );
    const listed = topicsOf(await reader('GET', '/api/v1/topics'));
    // Who does not see tracks counts the texts alone, as before the tracks (KBC-099 AC-13).
    expect(listed.get('hermetismo')?.trackCount).toBe(0);
    // The vault's Markdown is never shown to people (ADR 0035 §7).
    const opened = await listener(
      'GET',
      `/api/v1/topics/hermetismo/documents/${encodeURIComponent(tracks.path)}`,
    );
    expect(opened.statusCode).toBe(404);
  });
});

describe('the collection counts its tracks as documents (KBC-101, owner decision C17)', () => {
  it('counts the tracks the person sees, apart, in the parent and in the sub-collection, and drops one archived at once', async () => {
    const tracks = await trackWorld();
    await moveToSub(tracks, { otherAuthor: true });
    const listener = await memberWith(tracks.world, LISTENER);
    const reader = await memberWith(tracks.world, ['search']);
    const hearsOnly = await memberWith(tracks.world, ['search', 'media']);
    const read = async (who: Call) =>
      topicsOf(await who('GET', '/api/v1/topics'));
    const texts = await read(reader);
    const seen = await read(listener);
    expect(seen.get('hermetismo')).toMatchObject({
      documentCount: (texts.get('hermetismo')?.documentCount ?? 0) + 2,
      trackCount: 2,
    });
    expect(seen.get(SUB)).toMatchObject({
      documentCount: (texts.get(SUB)?.documentCount ?? 0) + 1,
      trackCount: 1,
    });
    expect(texts.get('hermetismo')?.trackCount).toBe(0);
    expect(await read(hearsOnly)).toEqual(texts);

    changeMedia(tracks.world, {
      id: tracks.other.id,
      set: { archived_at: new Date().toISOString() },
    });
    expect((await read(listener)).get('hermetismo')?.trackCount).toBe(1);
  });
});

describe('tracks in "Veja também" (KBC-101 AC-7)', () => {
  it('lists a track kb linked to a concept with its media to who researches tracks, and to nobody else', async () => {
    const tracks = await trackWorld();
    await setKey(tracks, 'example_of', '["[[Ritmo]]"]');
    const concept = encodeURIComponent('wiki/concepts/Ritmo.md');
    const open = async (who: Call) => {
      const read = await who(
        'GET',
        `/api/v1/topics/hermetismo/documents/${concept}`,
      );
      expect(read.statusCode, read.body).toBe(200);
      return read.json<KbDocument>().seeAlso.examples;
    };
    const researcher = await memberWith(tracks.world, RESEARCHER);
    const examples = await open(researcher);
    const page = async (who: Call) =>
      (
        await who(
          'GET',
          `/api/v1/topics/hermetismo/documents/${concept}/relations/examples?limit=50`,
        )
      ).json<{ items: { id: string; media?: unknown }[] }>().items;
    expect((await page(researcher)).find((one) => one.media)).toMatchObject({
      id: tracks.path,
      title: 'O que é o ritmo?',
      media: {
        mediaId: tracks.track.id,
        recordingTitle: RECORDING,
        ordinal: 1,
        total: 2,
      },
    });
    const listener = await memberWith(tracks.world, [
      'search',
      'research',
      'media',
      'media-tracks',
    ]);
    const without = await open(listener);
    expect((await page(listener)).some((one) => one.media)).toBe(false);
    expect(without.total).toBe(examples.total - 1);

    changeMedia(tracks.world, {
      id: tracks.track.id,
      set: { archived_at: new Date().toISOString() },
    });
    expect((await page(researcher)).some((one) => one.media)).toBe(false);
  });

  it('FR-5: a sub-collection document named from its parent opens in the panel', async () => {
    const tracks = await trackWorld();
    const sub = join(tracks.vault, SUB, 'raw/articles/sobre-o-pendulo.md');
    await mkdir(dirname(sub), { recursive: true });
    await writeFile(
      sub,
      '---\ntitle: Sobre o pêndulo\ntype: source\n---\n\nO pêndulo.\n',
    );
    await tracks.world.media.started.catalog.load();
    const reader = await memberWith(tracks.world, ['search']);
    const opened = await reader(
      'GET',
      `/api/v1/topics/hermetismo/documents/${encodeURIComponent('palestras/raw/articles/sobre-o-pendulo.md')}`,
    );
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.json<KbDocument>()).toMatchObject({
      title: 'Sobre o pêndulo',
      body: 'O pêndulo.',
    });
  });
});
