/**
 * Subjects in the search, the filters and "Veja também" (KBC-070): only accepted links
 * count, through the real routes, for who has `media-tracks` and `media-subjects`, in the
 * collections they see.
 */
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  LibraryPage,
  SearchResponse,
  SubjectTracksPage,
  TrackAbout,
  TrackSubjects,
} from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp, type Call } from '../test/ai-app-harness.js';
import { member, type Media } from '../test/media-harness.js';
import {
  approve,
  finishCuts,
  startWorld,
  transcribed,
  type World,
} from '../test/track-items-harness.js';

afterEach(closeApp);

const TOPIC = 'hermetismo';
const SEARCH = `/api/v1/topics/${TOPIC}/searches`;
const LISTENER = ['search', 'media', 'media-library', 'media-tracks'];
const SUBJECTS = [...LISTENER, 'media-subjects'];

const TRACKS = [
  { startMs: 0, endMs: 60_000, title: 'O que é a burracheira?' },
  { startMs: 60_000, endMs: 240_000, title: 'Sobre o preparo' },
  { startMs: 240_000, endMs: 400_000, title: 'Ainda sem assunto' },
];
const SPEECH = [
  { at: 10, text: 'a experiência da sessão' },
  { at: 100, text: 'o chá feito na cozinha do templo' },
  { at: 300, text: 'a cabala fora dos assuntos desta faixa' },
];

interface Track {
  readonly mediaId: string;
  readonly version: number;
}

/** A recording with published tracks, in the order of TRACKS. */
async function publishedTracks(world: World): Promise<Track[]> {
  const { media } = world;
  const recording = await transcribed(world, SPEECH);
  await approve(media, recording.id, TRACKS);
  await finishCuts(media);
  const step = await media.owner(
    'GET',
    `/api/v1/media/${recording.id}/edit/subjects`,
  );
  return step.json<{ tracks: TrackSubjects[] }>().tracks;
}

async function link(
  media: Media,
  track: Track,
  input: { subjects: object[]; summary?: string },
): Promise<void> {
  const saved = await media.started.app.inject({
    method: 'PUT',
    url: `/api/v1/media/${track.mediaId}/subjects`,
    headers: { ...media.ownerHeaders, 'if-match': `"${track.version}"` },
    payload: { summary: null, ...input },
  });
  expect(saved.statusCode, saved.body).toBe(200);
}

/** What no route can do: a run's suggestion, or an archived track. */
function sql(media: Media, statement: string): void {
  const db = new DatabaseSync(join(media.mediaDir, 'media.db'));
  db.exec(statement);
  db.close();
}

const concept = (name: string) => ({ kind: 'concept', name });

const search = async (who: Call, body: object): Promise<SearchResponse> => {
  const found = await who('POST', SEARCH, body);
  expect(found.statusCode, found.body).toBe(200);
  return found.json<SearchResponse>();
};

const byConcept = (name: string, q = name) => ({
  q,
  filters: { concepts: [name] },
});

const titles = (found: SearchResponse) => found.media.map((hit) => hit.title);

const cabalaCount = (found: SearchResponse) =>
  found.facets.concepts.find((one) => one.value === 'Cabala');

/** A world with a track on Cabala, one on Ritmo and a third with nothing accepted. */
async function worldWithSubjects() {
  const world = await startWorld();
  const { media } = world;
  const [first, second, third] = await publishedTracks(world);
  if (!first || !second || !third) throw new Error('three tracks expected');
  await link(media, first, {
    subjects: [concept('Cabala')],
    summary: 'Como a burracheira chega na sessão.',
  });
  await link(media, second, { subjects: [concept('Ritmo')] });
  const reader = await member(media, {
    email: 'leitora@example.com',
    topics: [TOPIC],
    features: SUBJECTS,
  });
  return { world, media, first, second, third, reader: reader.call };
}

describe('the concept filter over tracks (KBC-070)', () => {
  it('finds a linked track by the subject alone, with its chip (AC-1)', async () => {
    const { reader, first } = await worldWithSubjects();
    const found = await search(reader, byConcept('Cabala', ''));
    expect(found.media).toHaveLength(1);
    const [hit] = found.media;
    expect(hit).toMatchObject({
      mediaId: first.mediaId,
      match: 'subject',
      startMs: 0,
      text: 'Como a burracheira chega na sessão.',
      subjects: [{ name: 'Cabala' }],
    });
    expect(found.kinds.audio).toBe(1);
  });

  it('reads the subject name as the question as no text (BR-2)', async () => {
    const { reader } = await worldWithSubjects();
    const found = await search(reader, byConcept('Cabala'));
    expect(titles(found)).toEqual(['O que é a burracheira?']);
  });

  it('refuses a search with neither text nor subject', async () => {
    const { reader } = await worldWithSubjects();
    const found = await reader('POST', SEARCH, { q: ' ' });
    expect(found.statusCode).toBe(400);
  });

  it('with text, the track must hold it in speech, title or summary (AC-2)', async () => {
    const { reader } = await worldWithSubjects();
    const inSummary = await search(reader, byConcept('Cabala', 'sessao'));
    const inTitle = await search(reader, byConcept('Cabala', 'burracheira'));
    const nowhere = await search(reader, byConcept('Cabala', 'chá'));
    expect(titles(inTitle)).toEqual(['O que é a burracheira?']);
    expect(inSummary.media.some((hit) => hit.match === 'speech')).toBe(true);
    expect(nowhere.media).toEqual([]);
    expect(nowhere.kinds.audio).toBe(0);
  });

  it('shows the speech inside a linked track as a passage with its subjects', async () => {
    const { reader } = await worldWithSubjects();
    const found = await search(reader, byConcept('Ritmo', 'cozinha'));
    expect(found.media).toHaveLength(1);
    expect(found.media[0]).toMatchObject({
      match: 'speech',
      subjects: [{ name: 'Ritmo' }],
    });
    expect(found.media[0]?.highlights).toHaveLength(1);
  });

  it('never counts a suggestion (AC-3)', async () => {
    const { reader, third, media } = await worldWithSubjects();
    sql(
      media,
      `
      INSERT INTO media_subject_links (id, media_id, kind, subject_key, concept_name, source,
        status, created_at)
      VALUES ('s1', '${third.mediaId}', 'concept', 'concept:cabala', 'Cabala', 'ai', 'suggested',
        '2026-11-04T00:00:00.000Z')`,
    );
    const found = await search(reader, byConcept('Cabala', ''));
    expect(titles(found)).toEqual(['O que é a burracheira?']);
    expect(cabalaCount(found)?.tracks).toBe(1);
  });

  it('counts documents and tracks apart (AC-4)', async () => {
    const { reader } = await worldWithSubjects();
    const found = await search(reader, byConcept('Cabala'));
    const counted = cabalaCount(found);
    expect(counted?.count).toBeGreaterThan(0);
    expect(counted?.tracks).toBe(1);
  });

  it('counts tracks under the text, and over the whole collection', async () => {
    const { reader } = await worldWithSubjects();
    const narrowed = await search(reader, { q: 'cozinha' });
    expect(cabalaCount(narrowed)?.tracks ?? 0).toBe(0);
    const whole = await reader('GET', `/api/v1/topics/${TOPIC}/facets`);
    expect(
      whole
        .json<SearchResponse['facets']>()
        .concepts.find((one) => one.value === 'Cabala')?.tracks,
    ).toBe(1);
  });

  it('adds a free subject only tracks have, and filters by it', async () => {
    const { reader, media, third } = await worldWithSubjects();
    const made = await media.owner('POST', `/api/v1/topics/${TOPIC}/subjects`, {
      name: 'Preparo do chá',
    });
    await link(media, third, {
      subjects: [{ kind: 'free', id: made.json<{ id: string }>().id }],
    });
    const all = await search(reader, { q: 'cabala' });
    expect(
      all.facets.concepts.find((one) => one.value === 'Preparo do chá'),
    ).toEqual({ value: 'Preparo do chá', count: 0, tracks: 1 });
    const found = await search(reader, byConcept('Preparo do chá', ''));
    expect(titles(found)).toEqual(['Ainda sem assunto']);
  });

  it('follows "Autoria" over tracks', async () => {
    const { reader } = await worldWithSubjects();
    const found = await search(reader, {
      q: '',
      filters: { concepts: ['Cabala'], authorships: ['outros-autores'] },
    });
    expect(found.media).toEqual([]);
    expect(
      found.facets.authorships.find((one) => one.value === 'mestre-laercio')
        ?.count,
    ).toBeGreaterThan(0);
  });

  it('hides tracks from a text-only filter or kind', async () => {
    const { reader } = await worldWithSubjects();
    const genre = await search(reader, {
      q: 'cabala',
      filters: { concepts: ['Cabala'], genres: ['paper'] },
    });
    const texts = await search(reader, {
      q: 'cabala',
      kinds: ['text'],
      filters: { concepts: ['Cabala'] },
    });
    expect(genre.media).toEqual([]);
    expect(texts.media).toEqual([]);
    expect(cabalaCount(texts)?.tracks).toBeUndefined();
  });

  it('stops counting a concept the catalog lost and an archived track', async () => {
    const { reader, media, first } = await worldWithSubjects();
    sql(
      media,
      `UPDATE media SET archived_at = '2026-11-04T00:00:00.000Z' WHERE id = '${first.mediaId}'`,
    );
    const found = await search(reader, byConcept('Cabala', ''));
    expect(found.media).toEqual([]);
    expect(cabalaCount(found)?.tracks).toBe(0);
  });
});

describe('who sees subjects (AC-6, BR-3)', () => {
  it.each([
    ['no media-subjects', LISTENER],
    ['no media-tracks', ['search', 'media', 'media-library', 'media-subjects']],
    ['no media', ['search', 'media-tracks', 'media-subjects']],
    ['only media-classify', [...LISTENER, 'media-classify']],
  ])('leaves search and counts as today with %s', async (_, features) => {
    const { media, first } = await worldWithSubjects();
    const { call } = await member(media, {
      email: 'outra@example.com',
      topics: [TOPIC],
      features,
    });
    const found = await search(call, byConcept('Cabala'));
    expect(found.media).toEqual([]);
    expect(cabalaCount(found)?.tracks).toBeUndefined();
    const plain = await search(call, { q: 'experiência' });
    expect(plain.media.flatMap((hit) => hit.subjects)).toEqual([]);
    const about = await call('GET', `/api/v1/media/${first.mediaId}/about`);
    expect(about.statusCode).toBe(403);
    const tracks = await call(
      'GET',
      `/api/v1/topics/${TOPIC}/concepts/Cabala/media`,
    );
    expect(tracks.statusCode).toBe(403);
  });

  it('tells nothing of a collection the person cannot see', async () => {
    const { media, first } = await worldWithSubjects();
    const { call } = await member(media, {
      email: 'fora@example.com',
      topics: ['alquimia'],
      features: SUBJECTS,
    });
    const found = await call('POST', SEARCH, byConcept('Cabala'));
    expect(found.statusCode).toBe(404);
    const facets = await call('GET', `/api/v1/topics/${TOPIC}/facets`);
    expect(facets.statusCode).toBe(404);
    const tracks = await call(
      'GET',
      `/api/v1/topics/${TOPIC}/concepts/Cabala/media`,
    );
    expect(tracks.statusCode).toBe(404);
    const about = await call('GET', `/api/v1/media/${first.mediaId}/about`);
    expect(about.statusCode).toBe(404);
    const library = await call('GET', '/api/v1/media/library');
    expect(library.json<LibraryPage>().facets.subjects).toEqual([]);
  });
});

describe('GET …/concepts/{name}/media (FR-3)', () => {
  it('lists the linked tracks, newest first, in pages (AC-5)', async () => {
    const { reader, media, second } = await worldWithSubjects();
    await link(
      media,
      { ...second, version: 1 },
      {
        subjects: [concept('Ritmo'), concept('Cabala')],
      },
    );
    const url = `/api/v1/topics/${TOPIC}/concepts/Cabala/media`;
    const page = await reader('GET', `${url}?limit=1`);
    expect(page.statusCode, page.body).toBe(200);
    const body = page.json<SubjectTracksPage>();
    expect(body.total).toBe(2);
    expect(body.nextOffset).toBe(1);
    const rest = await reader('GET', `${url}?offset=1&limit=1`);
    expect(rest.json<SubjectTracksPage>().nextOffset).toBeNull();
    expect(rest.json<SubjectTracksPage>().items).toHaveLength(1);
  });

  it('answers 404 for a subject the collection does not have', async () => {
    const { reader } = await worldWithSubjects();
    const page = await reader(
      'GET',
      `/api/v1/topics/${TOPIC}/concepts/Inexistente/media`,
    );
    expect(page.statusCode).toBe(404);
  });

  it('marks a concept article with its concept', async () => {
    const { reader } = await worldWithSubjects();
    const doc = await reader(
      'GET',
      `/api/v1/topics/${TOPIC}/documents/wiki%2Fconcepts%2FCabala.md`,
    );
    expect(doc.json<{ concept: string | null }>().concept).toBe('Cabala');
  });
});

describe('GET /media/{id}/about', () => {
  it('gives the accepted subjects and the summary, never a suggestion', async () => {
    const { reader, first } = await worldWithSubjects();
    const about = await reader('GET', `/api/v1/media/${first.mediaId}/about`);
    expect(about.statusCode, about.body).toBe(200);
    expect(about.json<TrackAbout>()).toEqual({
      subjects: [{ key: 'concept:cabala', name: 'Cabala' }],
      summary: 'Como a burracheira chega na sessão.',
    });
  });
});

describe('the library by subject (AC-7)', () => {
  it('offers the subjects and lists only the linked tracks', async () => {
    const { reader, first } = await worldWithSubjects();
    const all = await reader('GET', '/api/v1/media/library');
    const { facets } = all.json<LibraryPage>();
    expect(facets.subjects.map((one) => one.name)).toEqual(['Cabala', 'Ritmo']);
    const page = await reader(
      'GET',
      `/api/v1/media/library?subject=${encodeURIComponent('concept:cabala')}`,
    );
    expect(page.json<LibraryPage>().items.map((item) => item.id)).toEqual([
      first.mediaId,
    ]);
    expect(page.json<LibraryPage>().total).toBe(1);
  });

  it('remembers the filter in the account', async () => {
    const { reader } = await worldWithSubjects();
    const saved = await reader('PUT', '/api/v1/media/preferences', {
      libraryFilters: {
        states: [],
        authors: [],
        topic: null,
        subject: 'concept:cabala',
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const read = await reader('GET', '/api/v1/media/preferences');
    expect(
      read.json<{ libraryFilters: object }>().libraryFilters,
    ).toMatchObject({ subject: 'concept:cabala' });
  });

  it('ignores the filter and offers nothing without media-subjects', async () => {
    const { media } = await worldWithSubjects();
    const { call } = await member(media, {
      email: 'semassunto@example.com',
      topics: [TOPIC],
      features: LISTENER,
    });
    const page = await call(
      'GET',
      `/api/v1/media/library?subject=${encodeURIComponent('concept:cabala')}`,
    );
    const body = page.json<LibraryPage>();
    expect(body.facets.subjects).toEqual([]);
    expect(body.items.length).toBeGreaterThan(0);
  });
});
