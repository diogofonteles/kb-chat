import type { LibrarySearch } from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp } from '../test/ai-app-harness.js';
import {
  leaseJob,
  member,
  queuedItem,
  vaultWithUdv,
  type Media,
} from '../test/media-harness.js';
import {
  approve,
  convertLong,
  finishCuts,
  libraryEntry,
  say,
  startWorld,
  transcribed,
  type World,
} from '../test/track-items-harness.js';

/** KBC-096: the library's search answers with tracks, the speech first. */

afterEach(closeApp);

const SEARCH = '/api/v1/media/library/search';

const TRACKS = [
  { startMs: 0, endMs: 60_000, title: 'Infância' },
  { startMs: 60_000, endMs: 240_000, title: 'Encontro com o Padre Orlando' },
  { startMs: 300_000, endMs: 360_000, title: 'Velhice' },
];

const SPEECH = [
  { at: 10, text: 'nada a ver com o interior' },
  { at: 100, text: 'conheci o Padre Orlando em Manaus' },
  { at: 270, text: 'intervalo com a hoasca fora de qualquer faixa' },
  { at: 310, text: 'o padre Orlândo voltou depois' },
];

const LISTENER = ['media', 'media-tracks', 'media-library', 'search'];

async function interview(
  world: World,
  options: { title?: string; speech?: typeof SPEECH } = {},
) {
  const { media } = world;
  const recording = await transcribed(world, options.speech ?? SPEECH, {
    title: options.title ?? 'Entrevista de 1985',
  });
  await approve(media, recording.id, TRACKS);
  await finishCuts(media);
  const entry = await libraryEntry(media.owner, recording.id);
  return { recording, tracks: entry?.tracks ?? [] };
}

const search = async (
  call: Media['owner'],
  q: string,
  more = '',
): Promise<LibrarySearch> => {
  const found = await call(
    'GET',
    `${SEARCH}?q=${encodeURIComponent(q)}${more}`,
  );
  expect(found.statusCode, found.body).toBe(200);
  return found.json<LibrarySearch>();
};

/** The next conversion and transcription in the queue, saying `text`. */
async function convertedAndSaid(world: World, text: string): Promise<void> {
  const { media } = world;
  await convertLong(media, await leaseJob(media));
  await say(world, [{ at: 10, text }]);
}

const titles = (page: LibrarySearch) => page.items.map((hit) => hit.item.title);

describe('The library search answers with tracks (KBC-096)', () => {
  it('AC-1: only the tracks that speak, marked, in their own time, whatever the case or accent', async () => {
    const world = await startWorld();
    const { tracks } = await interview(world);
    const owner = world.media.owner;

    for (const q of ['padre orlando', 'Padre Orlando', 'PADRE ORLÂNDO']) {
      const page = await search(owner, q);
      expect(page.total).toBe(2);
      expect(new Set(page.items.map((hit) => hit.item.id))).toEqual(
        new Set([tracks[1]?.id, tracks[2]?.id]),
      );
    }

    const page = await search(owner, 'orlando');
    const second = page.items.find((hit) => hit.item.id === tracks[1]?.id);
    expect(second).toMatchObject({
      match: 'speech',
      passage: {
        text: 'conheci o Padre Orlando em Manaus',
        startMs: 40_000,
        confidence: 'normal',
      },
    });
    const third = page.items.find((hit) => hit.item.id === tracks[2]?.id);
    expect(third?.passage?.text).toBe('o padre Orlândo voltou depois');
    const { text = '', highlights = [] } = second?.passage ?? {};
    expect(highlights.map(({ start, end }) => text.slice(start, end))).toEqual([
      'Orlando',
    ]);
  });

  it('AC-2: audio with no tracks, and a word in the gap between tracks, answer as the recording', async () => {
    const world = await startWorld();
    const { recording } = await interview(world);
    const single = await transcribed(
      world,
      [{ at: 495, text: 'a hoasca num áudio inteiro' }],
      { title: 'Palestra sem faixas' },
    );

    const page = await search(world.media.owner, 'hoasca');

    expect(page.items.map((hit) => hit.item.id).sort()).toEqual(
      [recording.id, single.id].sort(),
    );
    const undivided = page.items.find((hit) => hit.item.id === single.id);
    expect(undivided).toMatchObject({
      match: 'speech',
      trackCount: 0,
      passage: { startMs: 495_000 },
    });
    const gap = page.items.find((hit) => hit.item.id === recording.id);
    expect(gap).toMatchObject({ trackCount: 3, passage: { startMs: 270_000 } });
  });

  it('AC-3: speech comes before title, and a result appears once', async () => {
    const world = await startWorld();
    await interview(world, { title: 'Entrevista sobre Orlando' });
    const page = await search(world.media.owner, 'orlando');

    expect(page.items.map((hit) => hit.match)).toEqual([
      'speech',
      'speech',
      'title',
    ]);
    expect(titles(page)[2]).toBe('Entrevista sobre Orlando');
    const ids = page.items.map((hit) => hit.item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('R3: a recording found by its title is one row, not all its tracks', async () => {
    const world = await startWorld();
    const { recording } = await interview(world, { title: 'Conversa Rara' });

    const page = await search(world.media.owner, 'conversa rara');

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      item: { id: recording.id },
      match: 'title',
      trackCount: 3,
      passage: null,
    });
  });

  it('AC-4: without `search` nothing spoken is found or sent, and titles still are', async () => {
    const world = await startWorld();
    const { media } = world;
    const { tracks } = await interview(world);
    const person = await member(media, {
      email: 'semfala@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-tracks', 'media-library'],
    });

    const spoken = await search(person.call, 'manaus');
    expect(spoken).toMatchObject({ items: [], total: 0 });

    const titled = await search(person.call, 'padre orlando');
    expect(titled.items).toHaveLength(1);
    expect(titled.items[0]).toMatchObject({
      item: { id: tracks[1]?.id },
      match: 'title',
      passage: null,
    });
    expect(JSON.stringify(titled)).not.toContain('Manaus');
  });

  it('AC-5: without media-tracks the recording answers in its own time', async () => {
    const world = await startWorld();
    const { media } = world;
    const { recording } = await interview(world);
    const person = await member(media, {
      email: 'semfaixas@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-library', 'search'],
    });

    const page = await search(person.call, 'manaus');

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      item: { id: recording.id },
      trackCount: 0,
      passage: { startMs: 100_000 },
    });
  });

  it('AC-5: nothing of a collection the person does not see', async () => {
    const world = await startWorld();
    const { media } = world;
    await interview(world);
    const person = await member(media, {
      email: 'fora@example.com',
      topics: [],
      features: LISTENER,
    });

    expect((await search(person.call, 'orlando')).items).toEqual([]);
  });

  it('AC-5: the route needs media-library', async () => {
    const world = await startWorld();
    const { media } = world;
    const person = await member(media, {
      email: 'sembiblioteca@example.com',
      topics: ['hermetismo'],
      features: ['media', 'search'],
    });
    const refused = await person.call('GET', `${SEARCH}?q=orlando`);
    expect(refused.statusCode).toBe(403);
    const bare = await media.owner('GET', SEARCH);
    expect(bare.statusCode).toBe(400);
  });

  it('AC-6: the filters in force narrow the results', async () => {
    const world = await startWorld();
    const { media } = world;
    const { tracks } = await interview(world);
    const first = tracks[1]?.id ?? '';
    await media.owner('PUT', '/api/v1/media/played', {
      ids: [first],
      played: true,
    });

    const heard = await search(media.owner, 'orlando', '&state=heard');
    expect(heard.items.map((hit) => hit.item.id)).toEqual([first]);

    const here = await search(media.owner, 'orlando', '&topic=hermetismo');
    expect(here.total).toBe(2);
    const elsewhere = await search(media.owner, 'orlando', '&topic=udv');
    expect(elsewhere.total).toBe(0);
  });

  it('AC-6: a chosen collection brings its sub-collections, and the author narrows', async () => {
    const world = await startWorld({ vault: await vaultWithUdv() });
    const { media } = world;
    await media.owner('POST', '/api/v1/topics/hermetismo/authors', {
      name: 'Outra Pessoa',
    });
    await interview(world);
    const sub = await queuedItem(
      media,
      encodeURIComponent('udv/palavra-do-mestre'),
      {
        title: 'Hoje no sub-acervo',
      },
    );

    const inTree = await search(media.owner, 'sub-acervo', '&topic=udv');
    expect(inTree.items.map((hit) => hit.item.id)).toEqual([]);
    await convertedAndSaid(world, 'manaus no sub-acervo');
    const found = await search(media.owner, 'sub-acervo', '&topic=udv');
    expect(found.items.map((hit) => hit.item.id)).toEqual([sub.id]);

    const byAuthor = await search(
      media.owner,
      'orlando',
      '&author=outra-pessoa',
    );
    expect(byAuthor.total).toBe(0);
    const anyone = await search(
      media.owner,
      'orlando',
      '&author=mestre-laercio',
    );
    expect(anyone.total).toBe(2);
  });

  it('R4: an upload still converting is no result, not even for who sent it', async () => {
    const world = await startWorld();
    const { media } = world;
    await queuedItem(media, 'hermetismo', { title: 'Convertendo Rara' });

    const page = await search(media.owner, 'convertendo rara');

    expect(page).toMatchObject({ items: [], total: 0 });
  });

  it("R3: a track enters by author only when the author is not its recording's", async () => {
    const world = await startWorld();
    await interview(world);

    const page = await search(world.media.owner, 'laercio');

    expect(page.items.map((hit) => hit.trackCount)).toEqual([3]);
    expect(page.items[0]).toMatchObject({ match: 'title' });
  });

  it('keeps pages and the cap apart: the second page continues the first', async () => {
    const world = await startWorld();
    await interview(world);
    const page = await search(world.media.owner, 'orlando', '&cursor=1');
    expect(page.items).toHaveLength(1);
    expect(page).toMatchObject({ total: 2, capped: false, nextCursor: null });
  });

  it('GET /media/library no longer takes the words', async () => {
    const world = await startWorld();
    const refused = await world.media.owner(
      'GET',
      '/api/v1/media/library?q=orlando',
    );
    expect(refused.statusCode).toBe(400);
  });
});

describe('Subjects in the library search (KBC-096 R2, R4)', () => {
  const concept = (name: string) => ({ kind: 'concept', name });

  async function linked(world: World) {
    const { media } = world;
    const { tracks } = await interview(world);
    const track = tracks[0];
    if (!track?.parent) throw new Error('no track');
    const put = await media.started.app.inject({
      method: 'PUT',
      url: `/api/v1/media/${track.id}/subjects`,
      headers: {
        ...media.ownerHeaders,
        'if-match': `"${track.parent.version}"`,
      },
      payload: {
        subjects: [concept('Cabala')],
        summary: 'Resumo sobre a tradição oral.',
      },
    });
    expect(put.statusCode, put.body).toBe(200);
    return track;
  }

  it('finds by subject and by summary after the speech and the title', async () => {
    const world = await startWorld();
    const track = await linked(world);
    const owner = world.media.owner;

    for (const q of ['cabala', 'tradição oral']) {
      const page = await search(owner, q);
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        item: { id: track.id },
        match: 'subject',
        passage: null,
      });
    }
    const chosen = `&subject=${encodeURIComponent('concept:cabala')}`;
    const inTrack = await search(owner, 'interior', chosen);
    expect(inTrack.items.map((hit) => hit.item.id)).toEqual([track.id]);
    expect((await search(owner, 'orlando', chosen)).total).toBe(0);
  });

  it('without `search` the subject answers, a summary never: it comes from the speech', async () => {
    const world = await startWorld();
    const { media } = world;
    const track = await linked(world);
    const person = await member(media, {
      email: 'semfalacomassunto@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-library', 'media-tracks', 'media-subjects'],
    });

    expect((await search(person.call, 'tradição oral')).total).toBe(0);
    const named = await search(person.call, 'cabala');
    expect(named.items.map((hit) => hit.item.id)).toEqual([track.id]);
  });

  it('without media-subjects neither the subject nor the summary answers', async () => {
    const world = await startWorld();
    const { media } = world;
    await linked(world);
    const person = await member(media, {
      email: 'semassuntos@example.com',
      topics: ['hermetismo'],
      features: LISTENER,
    });

    expect((await search(person.call, 'cabala')).total).toBe(0);
    expect((await search(person.call, 'tradição oral')).total).toBe(0);
  });
});

describe('The search limit (ND-22)', () => {
  it('refuses past the limit with RATE_LIMITED', async () => {
    const world = await startWorld({ env: { SEARCH_RATE_LIMIT: '2' } });
    const { owner } = world.media;
    const asked = () => owner('GET', `${SEARCH}?q=qualquer`);
    expect((await asked()).statusCode).toBe(200);
    expect((await asked()).statusCode).toBe(200);
    const refused = await asked();
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe('RATE_LIMITED');
  });
});
