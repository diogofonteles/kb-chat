import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MediaSearchQuery } from '../../ports/media-search.js';
import type {
  DerivedSegment,
  NewTranscript,
} from '../../ports/transcript-store.js';
import { applyMigrations, openMediaDatabase } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';
import { SqliteMediaSearch, toMatchExpression } from './sqlite-media-search.js';
import { SqliteMediaStore } from './sqlite-media-store.js';
import { SqliteTranscriptStore } from './sqlite-transcript-store.js';

const T0 = new Date('2026-11-03T12:00:00.000Z');
let db: DatabaseSync;
let store: SqliteMediaStore;
let transcripts: SqliteTranscriptStore;
let search: SqliteMediaSearch;
let sequence = 0;

const segment = (startMs: number, text: string): DerivedSegment => ({
  startMs,
  endMs: startMs + 4_000,
  text,
  avgLogprob: null,
  compressionRatio: null,
  noSpeechProb: null,
});

/** A ready media item in `topic`. */
function aMedia(
  input: { topic?: string; author?: string | null; title?: string } = {},
): string {
  sequence++;
  const id = `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
  store.createMedia({
    id,
    topic: input.topic ?? 'udv',
    title: input.title ?? `Palestra ${sequence}`,
    author: input.author ?? null,
    legacyAuthorship: 'outros-autores',
    ownerPrincipal: 'owner',
    fileName: 'a.mp3',
    uploadBytes: 3,
    now: T0,
  });
  db.prepare("UPDATE media SET status = 'ready' WHERE id = ?").run(id);
  return id;
}

/** Stores a new transcript version of `mediaId` through a leased transcribe job. */
function transcribe(
  mediaId: string,
  segments: readonly DerivedSegment[],
  confidence: NewTranscript['confidence'] = 'normal',
): void {
  transcripts.requestTranscription({
    mediaId,
    jobId: crypto.randomUUID(),
    now: T0,
  });
  const job = store.leaseJob({
    kinds: ['transcribe'],
    worker: 'mac',
    now: T0,
    leaseMs: 60_000,
  });
  if (!job) throw new Error('nothing to lease');
  const stored = transcripts.completeTranscribe({
    owner: { jobId: job.id, leaseId: job.leaseId, worker: 'mac' },
    now: T0,
    transcript: {
      id: crypto.randomUUID(),
      mediaId,
      provider: 'mlx-whisper',
      model: 'turbo',
      parameters: '{}',
      parametersVersion: '1',
      termsVersion: 1,
      vad: 'applied',
      speechRatio: 1,
      elapsedMs: 1,
      rawPath: `transcripts/${mediaId}.json`,
      filterVersion: 1,
      confidenceVersion: 1,
      confidence,
      wordCount: 1,
      removedWords: 0,
      lowWords: 0,
      segments,
      words: [],
    },
  });
  expect(stored).toBe(true);
}

const query = (
  terms: readonly string[],
  overrides: Partial<MediaSearchQuery> = {},
): MediaSearchQuery => ({
  terms,
  topics: ['udv'],
  authors: { kind: 'any' },
  limit: 5,
  ...overrides,
});

beforeEach(() => {
  db = openMediaDatabase(':memory:', MEDIA_MIGRATIONS);
  store = new SqliteMediaStore(db);
  transcripts = new SqliteTranscriptStore(db);
  search = new SqliteMediaSearch(db);
});
afterEach(() => store.close());

describe('SqliteMediaSearch', () => {
  it('finds a segment at its time with the matched words marked (AC-1)', () => {
    const id = aMedia({ title: 'Palestra sobre a Hoasca' });
    transcribe(id, [
      segment(0, 'Bom dia a todos.'),
      segment(495_000, 'Tiuaco é Mariri, disse o Mestre.'),
    ]);
    const found = search.search(query(['tiuaco', 'mariri']));
    expect(found.total).toBe(1);
    expect(found.matches).toEqual([
      expect.objectContaining({
        mediaId: id,
        topic: 'udv',
        title: 'Palestra sobre a Hoasca',
        author: null,
        marked: '\u0002Tiuaco\u0003 é \u0002Mariri\u0003, disse o Mestre.',
        startMs: 495_000,
        endMs: 499_000,
        confidence: 'normal',
      }),
    ]);
  });

  it('matches without accents and case, both ways (AC-2)', () => {
    const id = aMedia();
    transcribe(id, [segment(1_000, 'A Hoasca é a conselheira.')]);
    for (const term of ['hoasca', 'HOASCA', 'hóasca'])
      expect(search.search(query([term])).total, term).toBe(1);
    const accented = aMedia();
    transcribe(accented, [segment(2_000, 'Uma sessão longa.')]);
    expect(search.search(query(['sessao'])).matches[0]?.mediaId).toBe(accented);
  });

  it('requires every word and reads none of them as syntax', () => {
    const id = aMedia();
    transcribe(id, [segment(0, 'Tiuaco disse.')]);
    expect(search.search(query(['tiuaco', 'mariri'])).total).toBe(0);
    expect(toMatchExpression(['near', 'or'])).toBe('"near" "or"');
    expect(search.search(query(['or'])).total).toBe(0);
  });

  it('puts normal confidence before low for the same words (AC-5)', () => {
    const low = aMedia({ title: 'Ruidosa' });
    transcribe(low, [segment(0, 'Mariri e Chacrona.')], 'low');
    const normal = aMedia({ title: 'Limpa' });
    transcribe(normal, [segment(0, 'Mariri e Chacrona.')], 'normal');
    const found = search.search(query(['mariri']));
    expect(found.matches.map((m) => [m.title, m.confidence])).toEqual([
      ['Limpa', 'normal'],
      ['Ruidosa', 'low'],
    ]);
  });

  it('forgets the words of a replaced transcript version (AC-6)', () => {
    const id = aMedia();
    transcribe(id, [segment(0, 'Uma palavra antiga: burracheira.')]);
    expect(search.search(query(['burracheira'])).total).toBe(1);
    transcribe(id, [segment(0, 'Uma palavra nova: perambulando.')]);
    expect(search.search(query(['burracheira'])).total).toBe(0);
    expect(search.search(query(['perambulando'])).total).toBe(1);
  });

  it('forgets a removed media', () => {
    const id = aMedia();
    transcribe(id, [segment(0, 'Caiano.')]);
    expect(store.deleteMedia(id)).toBe(true);
    expect(search.search(query(['caiano'])).total).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM segments_fts').get()).toEqual({
      n: 0,
    });
  });

  it('looks only in the collections asked (BR-1)', () => {
    aMedia({ topic: 'udv' });
    const other = aMedia({ topic: 'hermetismo' });
    transcribe(other, [segment(0, 'Minguarana.')]);
    expect(search.search(query(['minguarana'])).total).toBe(0);
    expect(
      search.search(query(['minguarana'], { topics: ['udv', 'hermetismo'] }))
        .total,
    ).toBe(1);
    expect(search.search(query(['minguarana'], { topics: [] })).total).toBe(0);
  });

  it("narrows to the collection's main author or to everyone else (BR-2)", () => {
    const mainOf = new Map<string, string | null>([['udv', 'mestre-gabriel']]);
    const gabriel = aMedia({ author: 'mestre-gabriel', title: 'Do Mestre' });
    transcribe(gabriel, [segment(0, 'Lupunamanta.')]);
    const other = aMedia({ author: 'outro', title: 'De outro' });
    transcribe(other, [segment(0, 'Lupunamanta.')]);
    const anonymous = aMedia({ author: null, title: 'Sem autor' });
    transcribe(anonymous, [segment(0, 'Lupunamanta.')]);
    const titles = (authors: MediaSearchQuery['authors']) =>
      search
        .search(query(['lupunamanta'], { authors }))
        .matches.map((m) => m.title)
        .sort();
    expect(titles({ kind: 'main', mainOf })).toEqual(['Do Mestre']);
    expect(
      search.tally({ terms: ['lupunamanta'], topics: ['udv'], mainOf }),
    ).toEqual({ main: 1, others: 2 });
    expect(
      search.tally({
        terms: ['lupunamanta'],
        topics: ['udv'],
        mainOf: new Map([['udv', null]]),
      }),
    ).toEqual({ main: 0, others: 3 });
    expect(search.tally({ terms: [], topics: ['udv'], mainOf })).toEqual({
      main: 0,
      others: 0,
    });
    expect(search.search(query(['lupunamanta'], { count: false })).total).toBe(
      0,
    );
    expect(titles({ kind: 'others', mainOf })).toEqual([
      'De outro',
      'Sem autor',
    ]);
    const none = new Map<string, string | null>([['udv', null]]);
    expect(titles({ kind: 'main', mainOf: none })).toEqual([]);
    expect(titles({ kind: 'others', mainOf: none })).toHaveLength(3);
  });

  it('reads the legacy authorship of rows the previous image wrote (ADR 0030 §4)', () => {
    const id = aMedia();
    db.prepare(
      "UPDATE media SET author = NULL, authorship = 'mestre-laercio' WHERE id = ?",
    ).run(id);
    transcribe(id, [segment(0, 'Supairunam.')]);
    const found = search.search(query(['supairunam']));
    expect(found.matches[0]?.author).toBe('mestre-laercio');
  });

  it('returns at most the limit and counts up to the cap', () => {
    const id = aMedia();
    transcribe(
      id,
      Array.from({ length: 8 }, (_, i) => segment(i * 5_000, `Vegetal ${i}.`)),
    );
    const found = search.search(query(['vegetal'], { limit: 5 }));
    expect(found.matches).toHaveLength(5);
    expect(found.total).toBe(8);
  });

  it('takes a very common word unranked, normal confidence still first (NFR-1)', () => {
    const low = aMedia({ title: 'Ruidosa' });
    transcribe(low, [segment(0, 'Vegetal.')], 'low');
    const many = aMedia({ title: 'Longa' });
    transcribe(
      many,
      Array.from({ length: 10_001 }, (_, i) => segment(i * 10, 'Vegetal.')),
    );
    const found = search.search(query(['vegetal'], { limit: 5 }));
    expect(found.matches).toHaveLength(5);
    expect(found.matches.every((m) => m.confidence === 'normal')).toBe(true);
    expect(found.total).toBe(1_000);
  });

  it('counts each authorship group with its own limit (2,500 by the main author + 50)', () => {
    const mainOf = new Map<string, string | null>([['udv', 'mestre-gabriel']]);
    const gabriel = aMedia({ author: 'mestre-gabriel' });
    transcribe(
      gabriel,
      Array.from({ length: 2_500 }, (_, i) => segment(i * 10, 'Vegetal.')),
    );
    const other = aMedia({ author: 'outro' });
    transcribe(
      other,
      Array.from({ length: 50 }, (_, i) => segment(i * 10, 'Vegetal.')),
    );
    expect(
      search.tally({ terms: ['vegetal'], topics: ['udv'], mainOf }),
    ).toEqual({ main: 1_000, others: 50 });
  });

  it('has nothing for no words', () => {
    expect(search.search(query([]))).toEqual({ matches: [], total: 0 });
  });

  it('tells whether collections have a transcribed media', () => {
    const id = aMedia({ topic: 'udv' });
    expect(search.hasTranscripts(['udv'])).toBe(false);
    transcribe(id, [segment(0, 'Olá.')]);
    expect(search.hasTranscripts(['udv'])).toBe(true);
    expect(search.hasTranscripts(['hermetismo'])).toBe(false);
    expect(search.hasTranscripts([])).toBe(false);
  });
});

/** Found by name: parallel branches renumber migrations at rebase. */
const FTS_VERSION =
  MEDIA_MIGRATIONS.find((one) => one.name === 'transcript-segments-fts')
    ?.version ?? Number.NaN;

describe('the transcript-segments-fts migration (KBC-039)', () => {
  it('indexes only the current version of transcripts stored before it', () => {
    const before = MEDIA_MIGRATIONS.filter((one) => one.version < FTS_VERSION);
    db = openMediaDatabase(':memory:', before);
    // That schema, not the store's: later migrations add columns the store reads.
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
         upload_bytes, status, created_at, updated_at)
       VALUES (?, 'hermetismo', 'Palestra', 'outros-autores', 'owner', 'a.mp3', 3, 'ready', ?, ?)`,
    ).run(id, T0.toISOString(), T0.toISOString());
    const insert = (version: number, text: string) => {
      const transcriptId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO transcripts (id, media_id, version, provider, model, parameters,
           parameters_version, terms_version, vad, speech_ratio, elapsed_ms, raw_path,
           filter_version, confidence_version, confidence, word_count, removed_words,
           low_words, created_at)
         VALUES (?, ?, ?, 'mlx-whisper', 'm', '{}', '1', 1, 'applied', 1, 1, 'r.json',
           1, 1, 'normal', 1, 0, 0, ?)`,
      ).run(transcriptId, id, version, T0.toISOString());
      db.prepare(
        `INSERT INTO segments (transcript_id, position, start_ms, end_ms, text)
         VALUES (?, 0, 0, 1000, ?)`,
      ).run(transcriptId, text);
    };
    insert(1, 'Palavra antiga.');
    insert(2, 'Palavra nova.');
    expect(applyMigrations(db, MEDIA_MIGRATIONS)).toContain(FTS_VERSION);
    search = new SqliteMediaSearch(db);
    expect(search.search(query(['nova'])).total).toBe(1);
    expect(search.search(query(['antiga'])).total).toBe(0);
  });
});
