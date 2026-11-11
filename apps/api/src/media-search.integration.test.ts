/**
 * Spoken passages in the free search (KBC-039, ADR 0024): the transcripts' own index
 * merged with the documents, with permissions, authorship, confidence and the kinds.
 */
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  MediaHit,
  RawTranscript,
  SearchResponse,
  WorkerJob,
} from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_VAULT } from '../test/fixture-paths.js';
import {
  OWNER_EMAIL,
  caller,
  closeApp,
  signIn,
  start,
  type Call,
  type Started,
} from '../test/ai-app-harness.js';
import {
  AUDIO,
  CONVERTED,
  aRequest,
  leaseJob,
  upload,
  worker,
  type Media,
} from '../test/media-harness.js';
import {
  FLAC,
  leaseTranscription,
  pair,
  sendTranscript,
} from '../test/transcription-harness.js';
import { writeFileSync } from 'node:fs';

afterEach(closeApp);

const DOC = (title: string, body: string) =>
  `---\ntitle: ${title}\ntype: source\ngenre: paper\nauthor_group: outros-autores\n---\n\n${body}\n`;

/** A copy of the fixture vault with `udv`, its sub-collection and a text about the Hoasca. */
async function vaultWithUdv(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kbchat-vault-'));
  await cp(FIXTURE_VAULT, root, { recursive: true });
  const sub = join(root, 'udv', 'palavra-do-mestre');
  await mkdir(join(root, 'udv', 'raw'), { recursive: true });
  await mkdir(join(sub, 'raw'), { recursive: true });
  await writeFile(join(root, 'udv', 'topic.yaml'), 'title: UDV\n');
  await writeFile(join(sub, 'topic.yaml'), 'title: Palavra do Mestre\n');
  await writeFile(
    join(root, 'udv', 'raw', 'historia.md'),
    DOC('História da Hoasca', 'A Hoasca era a conselheira do rei.'),
  );
  await writeFile(
    join(sub, 'raw', 'sessao.md'),
    DOC('Sessão da Hoasca', 'Na sessão, a Hoasca.'),
  );
  return root;
}

interface Spoken {
  readonly at: number;
  readonly text: string;
}

/** A raw result with one segment per passage (`at` in seconds), clean or doubted. */
function rawOf(passages: readonly Spoken[], low = false): RawTranscript {
  return {
    chunks: [
      {
        offset: 0,
        end: 600,
        result: {
          segments: passages.map(({ at, text }) => {
            const words = text.split(' ');
            return {
              start: at,
              end: at + words.length * 0.4,
              text: ` ${text}`,
              avg_logprob: low ? -1.2 : -0.2,
              compression_ratio: 1.3,
              no_speech_prob: 0.01,
              words: words.map((word, i) => ({
                word: ` ${word}`,
                start: at + i * 0.4,
                end: at + (i + 1) * 0.4,
                probability: low ? 0.3 : 0.95,
              })),
            };
          }),
        },
      },
    ],
  };
}

interface World {
  readonly started: Started;
  readonly owner: Call;
  readonly media: Media;
  readonly token: string;
}

async function startWorld(): Promise<World> {
  const started = await start({ media: true, vault: await vaultWithUdv() });
  const ownerHeaders = await signIn(started, OWNER_EMAIL);
  const owner = caller(started.app, ownerHeaders);
  const media: Media = {
    started,
    owner,
    ownerHeaders,
    mediaDir: join(started.state, 'media'),
  };
  await owner('POST', '/api/v1/topics/udv/authors', { name: 'Mestre Gabriel' });
  await owner('POST', '/api/v1/topics/udv/authors', { name: 'Outro Autor' });
  await owner('PATCH', '/api/v1/topics/udv', { mainAuthor: 'mestre-gabriel' });
  const { token } = await pair(media);
  return { started, owner, media, token };
}

/** Ten minutes of "converted" audio with its FLAC, so 08:15 is inside the track. */
async function convertLong(media: Media, job: WorkerJob) {
  writeFileSync(join(media.mediaDir, job.targetPath), CONVERTED);
  if (job.flacTargetPath)
    writeFileSync(join(media.mediaDir, job.flacTargetPath), FLAC);
  const done = await worker(
    media,
    `/api/v1/media-worker/jobs/${job.id}/complete`,
    {
      worker: 'vm',
      leaseId: job.leaseId,
      durationMs: 600_000,
      bytes: CONVERTED.length,
      flacBytes: FLAC.length,
    },
  );
  expect(done.statusCode).toBe(204);
}

/** An audio uploaded, converted and transcribed with these passages. */
async function spokenAudio(
  world: World,
  input: {
    topic?: string;
    title: string;
    author?: string | null;
    passages: readonly Spoken[];
    low?: boolean;
  },
): Promise<string> {
  const { media, owner, token } = world;
  const topic = encodeURIComponent(input.topic ?? 'udv');
  const created = await owner(
    'POST',
    `/api/v1/topics/${topic}/media`,
    aRequest({ title: input.title, author: input.author ?? null }),
  );
  expect(created.statusCode).toBe(201);
  const id: string = created.json().id;
  expect((await upload(media, { id, body: AUDIO })).statusCode).toBe(200);
  await convertLong(media, await leaseJob(media));
  const job = await leaseTranscription(media, token);
  const sent = await sendTranscript(media, {
    token,
    job,
    raw: rawOf(input.passages, input.low),
  });
  expect(sent.statusCode).toBe(204);
  return id;
}

/** A member who sees `topics` with `features`. */
async function member(
  world: World,
  email: string,
  grant: { topics: string[]; features: string[] },
): Promise<Call> {
  const invited = await world.owner('POST', '/api/v1/people', {
    email,
    sendEmail: false,
  });
  await world.owner('PATCH', `/api/v1/people/${invited.json().id}`, grant);
  return caller(world.started.app, await signIn(world.started, email));
}

const searchAs = async (
  call: Call,
  body: object,
  topic = 'udv',
): Promise<{ status: number; body: SearchResponse }> => {
  const response = await call(
    'POST',
    `/api/v1/topics/${encodeURIComponent(topic)}/searches`,
    body,
  );
  return { status: response.statusCode, body: response.json() };
};

const titles = (hits: readonly MediaHit[]) => hits.map((hit) => hit.title);

describe('spoken passages in the search (KBC-039)', () => {
  it('AC-1, FR-2: finds the passage at 08:15 with its words highlighted and leaves the texts as they were', async () => {
    const world = await startWorld();
    const id = await spokenAudio(world, {
      title: 'Palestra do Tiuaco',
      author: 'mestre-gabriel',
      passages: [
        { at: 10, text: 'Bom dia a todos.' },
        { at: 495, text: 'Tiuaco é Mariri na história.' },
      ],
    });

    const { status, body } = await searchAs(world.owner, {
      q: 'tiuaco mariri',
    });

    expect(status).toBe(200);
    expect(body.media).toHaveLength(1);
    const hit = body.media[0];
    expect(hit).toMatchObject({
      mediaId: id,
      topic: 'udv',
      title: 'Palestra do Tiuaco',
      authorship: 'mestre-laercio',
      author: { slug: 'mestre-gabriel', name: 'Mestre Gabriel', main: true },
      text: 'Tiuaco é Mariri na história.',
      startMs: 495_000,
      confidence: 'normal',
    });
    expect(
      hit?.highlights.map(({ start, end }) => hit.text.slice(start, end)),
    ).toEqual(['Tiuaco', 'Mariri']);
    expect(hit?.score).toBeGreaterThanOrEqual(0);
    expect(hit?.score).toBeLessThanOrEqual(1);
    expect(body.kinds).toEqual({ text: 0, audio: 1 });
    expect(body.items).toEqual([]);
  });

  it('AC-2: finds "Hoasca" by "hoasca", "HOASCA" and "hóasca", in a sub-collection too', async () => {
    const world = await startWorld();
    await spokenAudio(world, {
      topic: 'udv/palavra-do-mestre',
      title: 'Conselheira',
      passages: [{ at: 30, text: 'A Hoasca era conselheira.' }],
    });

    for (const q of ['hoasca', 'HOASCA', 'hóasca']) {
      const { body } = await searchAs(world.owner, { q });
      expect(titles(body.media), q).toEqual(['Conselheira']);
      expect(body.media[0]?.topic).toBe('udv/palavra-do-mestre');
    }
  });

  it('AC-3, BR-1: nothing spoken for whoever does not see the collection or may not listen', async () => {
    const world = await startWorld();
    await spokenAudio(world, {
      title: 'Palestra',
      passages: [{ at: 1, text: 'Hoasca.' }],
    });
    const outsider = await member(world, 'caio@example.com', {
      topics: ['hermetismo'],
      features: ['search', 'media'],
    });
    const reader = await member(world, 'bia@example.com', {
      topics: ['udv'],
      features: ['search'],
    });
    const listener = await member(world, 'ana@example.com', {
      topics: ['udv'],
      features: ['search', 'media'],
    });

    const unseen = await searchAs(outsider, { q: 'hoasca' });
    const hermetismo = await searchAs(outsider, { q: 'hoasca' }, 'hermetismo');
    const noMedia = await searchAs(reader, { q: 'hoasca' });
    const allowed = await searchAs(listener, { q: 'hoasca' });

    expect(unseen.status).toBe(404);
    expect(hermetismo.body.media).toEqual([]);
    expect(hermetismo.body.kinds.audio).toBeNull();
    expect(noMedia.body.media).toEqual([]);
    expect(noMedia.body.kinds.audio).toBeNull();
    expect(noMedia.body.items.length).toBeGreaterThan(0);
    expect(titles(allowed.body.media)).toEqual(['Palestra']);
  });

  it('AC-3: a person granted only a sub-collection hears only its passages', async () => {
    const world = await startWorld();
    await spokenAudio(world, {
      title: 'No pai',
      passages: [{ at: 1, text: 'Hoasca no pai.' }],
    });
    await spokenAudio(world, {
      topic: 'udv/palavra-do-mestre',
      title: 'No sub-acervo',
      passages: [{ at: 1, text: 'Hoasca no sub-acervo.' }],
    });
    const sub = await member(world, 'davi@example.com', {
      topics: ['udv/palavra-do-mestre'],
      features: ['search', 'media'],
    });

    const parent = await searchAs(sub, { q: 'hoasca' });
    const own = await searchAs(sub, { q: 'hoasca' }, 'udv/palavra-do-mestre');

    expect(parent.status).toBe(404);
    expect(titles(own.body.media)).toEqual(['No sub-acervo']);
  });

  it("AC-4, BR-2: the main author's filter keeps his passages; a genre filter hides them all", async () => {
    const world = await startWorld();
    await spokenAudio(world, {
      title: 'Do Mestre',
      author: 'mestre-gabriel',
      passages: [{ at: 1, text: 'Chacrona e Mariri.' }],
    });
    await spokenAudio(world, {
      title: 'De outro',
      author: 'outro-autor',
      passages: [{ at: 1, text: 'Chacrona também.' }],
    });

    const main = await searchAs(world.owner, {
      q: 'chacrona',
      filters: { authorships: ['mestre-laercio'] },
    });
    const others = await searchAs(world.owner, {
      q: 'chacrona',
      filters: { authorships: ['outros-autores'] },
    });
    const synthesis = await searchAs(world.owner, {
      q: 'chacrona',
      filters: { authorships: ['sintese'] },
    });
    const genre = await searchAs(world.owner, {
      q: 'chacrona',
      filters: { genres: ['paper'] },
    });
    const sub = await searchAs(world.owner, {
      q: 'chacrona',
      filters: { topics: ['udv/palavra-do-mestre'] },
    });

    const authorshipCount = (body: SearchResponse, value: string) =>
      body.facets.authorships.find((one) => one.value === value)?.count;
    // The "Autoria" counts take the passages in, whatever group is chosen.
    for (const one of [main, others, synthesis]) {
      expect(authorshipCount(one.body, 'mestre-laercio')).toBe(1);
      expect(
        authorshipCount(one.body, 'outros-autores'),
      ).toBeGreaterThanOrEqual(1);
    }
    expect(titles(main.body.media)).toEqual(['Do Mestre']);
    expect(titles(others.body.media)).toEqual(['De outro']);
    expect(synthesis.body.media).toEqual([]);
    expect(genre.body.media).toEqual([]);
    expect(genre.body.kinds.audio).toBe(0);
    expect(sub.body.media).toEqual([]);
  });

  it('AC-5, BR-3: the normal passage comes before the low-confidence one, which says so', async () => {
    const world = await startWorld();
    await spokenAudio(world, {
      title: 'Ruidosa',
      low: true,
      passages: [{ at: 1, text: 'Caiano e Minguarana.' }],
    });
    await spokenAudio(world, {
      title: 'Limpa',
      passages: [{ at: 1, text: 'Caiano e Minguarana.' }],
    });

    const { body } = await searchAs(world.owner, { q: 'caiano' });

    expect(body.media.map((hit) => [hit.title, hit.confidence])).toEqual([
      ['Limpa', 'normal'],
      ['Ruidosa', 'low'],
    ]);
  });

  it('AC-6: a retranscribed media is found only by its new words', async () => {
    const world = await startWorld();
    const id = await spokenAudio(world, {
      title: 'Retranscrita',
      passages: [{ at: 1, text: 'Palavra antiga burracheira.' }],
    });
    const again = await world.owner(
      'POST',
      `/api/v1/media/${id}/transcription`,
    );
    expect(again.statusCode).toBeLessThan(300);
    const job = await leaseTranscription(world.media, world.token);
    await sendTranscript(world.media, {
      token: world.token,
      job,
      raw: rawOf([{ at: 1, text: 'Palavra nova perambulando.' }]),
    });

    const old = await searchAs(world.owner, { q: 'burracheira' });
    const fresh = await searchAs(world.owner, { q: 'perambulando' });

    expect(old.body.media).toEqual([]);
    expect(titles(fresh.body.media)).toEqual(['Retranscrita']);
  });

  it('AC-9, FR-5: only audio without "Textos", both again with it, counts either way', async () => {
    const world = await startWorld();
    await spokenAudio(world, {
      title: 'Sobre a Hoasca',
      passages: [{ at: 1, text: 'A Hoasca.' }],
    });

    const audioOnly = await searchAs(world.owner, {
      q: 'hoasca',
      kinds: ['audio'],
    });
    const textOnly = await searchAs(world.owner, {
      q: 'hoasca',
      kinds: ['text'],
    });
    const both = await searchAs(world.owner, { q: 'hoasca' });
    const none = await searchAs(world.owner, { q: 'hoasca', kinds: [] });

    expect(audioOnly.body.items).toEqual([]);
    expect(audioOnly.body.total).toBe(0);
    expect(titles(audioOnly.body.media)).toEqual(['Sobre a Hoasca']);
    expect(audioOnly.body.kinds).toEqual({ text: 2, audio: 1 });
    expect(textOnly.body.media).toEqual([]);
    // Without audio chosen, the facet counts are the texts' only.
    expect(
      textOnly.body.facets.authorships.find(
        (one) => one.value === 'mestre-laercio',
      ),
    ).toBeUndefined();
    expect(textOnly.body.items.map((item) => item.title).sort()).toEqual([
      'História da Hoasca',
      'Sessão da Hoasca',
    ]);
    expect(both.body.items).toHaveLength(2);
    expect(both.body.media).toHaveLength(1);
    expect(none.status).toBe(400);
  });

  it('BR-4: a remembered "Áudios" only searches the texts where there is no audio for the person', async () => {
    const world = await startWorld();
    await spokenAudio(world, {
      title: 'No pai',
      passages: [{ at: 1, text: 'Hoasca no pai.' }],
    });
    const reader = await member(world, 'bia@example.com', {
      topics: ['udv'],
      features: ['search'],
    });
    const audioOnly = { q: 'hoasca', kinds: ['audio'] };

    const noListening = await searchAs(reader, audioOnly);
    const noAudioHere = await searchAs(
      world.owner,
      audioOnly,
      'udv/palavra-do-mestre',
    );
    const withAudio = await searchAs(world.owner, audioOnly);

    expect(noListening.body.items.map((item) => item.title).sort()).toEqual([
      'História da Hoasca',
      'Sessão da Hoasca',
    ]);
    expect(noListening.body.kinds.audio).toBeNull();
    expect(noAudioHere.body.items.map((item) => item.title)).toEqual([
      'Sessão da Hoasca',
    ]);
    expect(noAudioHere.body.kinds).toEqual({ text: 1, audio: null });
    // Where there is audio, the choice holds: passages only.
    expect(withAudio.body.items).toEqual([]);
    expect(titles(withAudio.body.media)).toEqual(['No pai']);
  });

  it('a collection without transcribed audio has no audio kind', async () => {
    const world = await startWorld();

    const { body } = await searchAs(world.owner, { q: 'hoasca' });

    expect(body.kinds).toEqual({ text: 2, audio: null });
    expect(body.media).toEqual([]);
  });

  it('pages after the first bring no passages again', async () => {
    const world = await startWorld();
    await spokenAudio(world, {
      title: 'Hoasca',
      passages: [{ at: 1, text: 'Hoasca.' }],
    });

    const { body } = await searchAs(world.owner, { q: 'hoasca', offset: 1 });

    expect(body.media).toEqual([]);
    expect(body.kinds.audio).toBe(1);
  });
});
