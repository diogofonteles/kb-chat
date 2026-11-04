import type { DatabaseSync } from 'node:sqlite';

/**
 * The media database's schema (ADR 0022), as numbered migrations applied in order at API
 * start. A migration is never edited once released: a change is a new migration.
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  /** A function reads the database first: its SQL depends on what is already there. */
  readonly sql: string | ((db: DatabaseSync) => string);
}

const columnsOfJobs = (db: DatabaseSync): string =>
  db
    .prepare(`SELECT name FROM pragma_table_info('jobs')`)
    .all()
    .map((row) => String(row['name']))
    .join(', ');

const indexesOfJobs = (db: DatabaseSync): string[] =>
  db
    .prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'index' AND tbl_name = 'jobs' AND sql IS NOT NULL`,
    )
    .all()
    .map((row) => `${String(row['sql'])};`);

/**
 * Rebuilds `jobs` with `kind` in its CHECK from the table as it stands, every column, check and
 * index kept. Branches rebuild `jobs` in parallel (KBC-071's 15 adds a kind, a column and a
 * check): a fixed copy of the table here would drop what the other one added. Nothing to do
 * when the kind is already accepted. SQLite cannot change a CHECK in place.
 */
export function rebuildJobsAccepting(db: DatabaseSync, kind: string): string {
  const table = String(
    db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'`,
      )
      .get()?.['sql'],
  );
  const kinds = /kind\s+IN\s*\(([^)]*)\)/.exec(table);
  if (!kinds?.[1]) throw new Error('jobs has no kind check to extend');
  if (kinds[1].includes(`'${kind}'`)) return '';
  const rebuilt = table
    .replace(kinds[0], `kind IN (${kinds[1]}, '${kind}')`)
    .replace(/^CREATE TABLE\s+"?jobs"?/, 'CREATE TABLE jobs_rebuilt');
  const columns = columnsOfJobs(db);
  const indexes = indexesOfJobs(db);
  return [
    `${rebuilt};`,
    `INSERT INTO jobs_rebuilt (${columns}) SELECT ${columns} FROM jobs;`,
    'DROP TABLE jobs;',
    'ALTER TABLE jobs_rebuilt RENAME TO jobs;',
    ...indexes,
  ].join('\n');
}

export const MEDIA_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'media-and-jobs',
    sql: `
      CREATE TABLE media (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        title TEXT NOT NULL,
        authorship TEXT NOT NULL CHECK (authorship IN ('mestre-laercio', 'outros-autores')),
        owner_principal TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'audio' CHECK (kind IN ('audio', 'video')),
        file_name TEXT NOT NULL,
        upload_bytes INTEGER NOT NULL CHECK (upload_bytes > 0),
        status TEXT NOT NULL
          CHECK (status IN ('uploading', 'queued', 'processing', 'ready', 'failed')),
        progress INTEGER CHECK (progress BETWEEN 0 AND 100),
        failure TEXT CHECK (failure IN
          ('invalid-audio', 'conversion-failed', 'too-many-attempts', 'upload-abandoned')),
        duration_ms INTEGER CHECK (duration_ms >= 0),
        bytes INTEGER CHECK (bytes >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX media_by_topic ON media (topic, created_at DESC);
      CREATE INDEX media_uploading ON media (status, created_at) WHERE status = 'uploading';

      CREATE TABLE media_files (
        media_id TEXT NOT NULL REFERENCES media (id) ON DELETE CASCADE,
        rendition TEXT NOT NULL CHECK (rendition IN ('audio')),
        path TEXT NOT NULL,
        bytes INTEGER NOT NULL CHECK (bytes > 0),
        mime TEXT NOT NULL,
        PRIMARY KEY (media_id, rendition)
      ) STRICT;

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        media_id TEXT NOT NULL REFERENCES media (id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('transcode')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'done', 'failed', 'dead')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        lease_id TEXT,
        lease_until INTEGER,
        heartbeat_at INTEGER,
        worker TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX jobs_queued ON jobs (kind, created_at) WHERE status = 'queued';
      CREATE INDEX jobs_leased ON jobs (lease_until) WHERE status = 'leased';
      CREATE INDEX jobs_by_media ON jobs (media_id);
    `,
  },
  {
    version: 2,
    name: 'listening-preferences-and-progress',
    sql: `
      CREATE TABLE media_preferences (
        principal TEXT PRIMARY KEY,
        speed REAL NOT NULL CHECK (speed IN (0.75, 1, 1.25, 1.5, 1.75, 2)),
        show_remaining INTEGER NOT NULL CHECK (show_remaining IN (0, 1)),
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE media_progress (
        principal TEXT NOT NULL,
        media_id TEXT NOT NULL REFERENCES media (id) ON DELETE CASCADE,
        position_ms INTEGER NOT NULL CHECK (position_ms >= 0),
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (principal, media_id)
      ) STRICT;
      CREATE INDEX media_progress_by_media ON media_progress (media_id);
    `,
  },
  {
    version: 3,
    name: 'listening-skip-lengths',
    sql: `
      ALTER TABLE media_preferences ADD COLUMN skip_back_sec INTEGER NOT NULL DEFAULT 15
        CHECK (skip_back_sec IN (5, 10, 15, 30));
      ALTER TABLE media_preferences ADD COLUMN skip_forward_sec INTEGER NOT NULL DEFAULT 30
        CHECK (skip_forward_sec IN (10, 15, 30, 45, 60));
    `,
  },
  {
    version: 4,
    name: 'media-bookmarks',
    sql: `
      CREATE TABLE media_bookmarks (
        id TEXT PRIMARY KEY,
        principal TEXT NOT NULL,
        media_id TEXT NOT NULL REFERENCES media (id) ON DELETE CASCADE,
        position_ms INTEGER NOT NULL CHECK (position_ms >= 0),
        note TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX media_bookmarks_by_media
        ON media_bookmarks (principal, media_id, position_ms);
      CREATE INDEX media_bookmarks_by_time ON media_bookmarks (principal, created_at);
      CREATE INDEX media_bookmarks_cascade ON media_bookmarks (media_id);
    `,
  },
  {
    version: 5,
    name: 'transcription',
    sql: `
      -- Jobs gain the kind 'transcribe' (ADR 0023): SQLite cannot change a CHECK, so the
      -- table is rebuilt; nothing references jobs.
      CREATE TABLE jobs_v5 (
        id TEXT PRIMARY KEY,
        media_id TEXT NOT NULL REFERENCES media (id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('transcode', 'transcribe')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'done', 'failed', 'dead')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        lease_id TEXT,
        lease_until INTEGER,
        heartbeat_at INTEGER,
        worker TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO jobs_v5 SELECT id, media_id, kind, status, attempts, lease_id, lease_until,
        heartbeat_at, worker, error, created_at, updated_at FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_v5 RENAME TO jobs;
      CREATE INDEX jobs_queued ON jobs (kind, created_at) WHERE status = 'queued';
      CREATE INDEX jobs_leased ON jobs (lease_until) WHERE status = 'leased';
      CREATE INDEX jobs_by_media ON jobs (media_id, kind, created_at);
      CREATE INDEX jobs_by_worker ON jobs (worker) WHERE status = 'leased';

      -- Paired workers (the owner's Mac): only a keyed hash of the token is kept.
      CREATE TABLE transcribers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
        kinds TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at TEXT
      ) STRICT;
      -- Two active transcribers never share a name: the list says which one to revoke.
      CREATE UNIQUE INDEX transcribers_active_name ON transcribers (lower(name))
        WHERE revoked_at IS NULL;

      -- The term list put in every chunk's prompt, by version (KBC-040 edits it later).
      CREATE TABLE terms (
        version INTEGER NOT NULL CHECK (version >= 1),
        position INTEGER NOT NULL CHECK (position >= 1),
        term TEXT NOT NULL CHECK (length(term) BETWEEN 1 AND 100),
        PRIMARY KEY (version, position)
      ) STRICT;
      INSERT INTO terms (version, position, term) VALUES
        (1, 1, 'Mestre Gabriel'),
        (1, 2, 'UDV'),
        (1, 3, 'União do Vegetal'),
        (1, 4, 'Vegetal'),
        (1, 5, 'Hoasca'),
        (1, 6, 'Burracheira'),
        (1, 7, 'Caiano'),
        (1, 8, 'Minguarana'),
        (1, 9, 'Lupunamanta'),
        (1, 10, 'Supairunam'),
        (1, 11, 'Perambulando'),
        (1, 12, 'Caminho Firme'),
        (1, 13, 'Jardim das Flores'),
        (1, 14, 'Luz do Universo'),
        (1, 15, 'Conselheira do Rei'),
        (1, 16, 'Mestre Florêncio'),
        (1, 17, 'Mestre Paixão'),
        (1, 18, 'Mestre Bartolomeu'),
        (1, 19, 'Mestre Monteiro'),
        (1, 20, 'Mestre José Luiz'),
        (1, 21, 'Mestre Nonato'),
        (1, 22, 'Mestre Modesto'),
        (1, 23, 'chamada'),
        (1, 24, 'sessão'),
        (1, 25, 'estatutos'),
        (1, 26, 'Tiuaco'),
        (1, 27, 'Mariri'),
        (1, 28, 'Chacrona'),
        (1, 29, 'Rei Zinca'),
        (1, 30, 'Rei Salomão'),
        (1, 31, 'Associação Beneficente União do Vegetal'),
        (1, 32, 'diretoria');

      -- One row per transcription; the raw JSON file is the source of truth (BR-3).
      CREATE TABLE transcripts (
        id TEXT PRIMARY KEY,
        media_id TEXT NOT NULL REFERENCES media (id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version >= 1),
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        parameters TEXT NOT NULL,
        parameters_version TEXT NOT NULL,
        terms_version INTEGER NOT NULL,
        vad TEXT NOT NULL CHECK (vad IN ('applied', 'skipped')),
        speech_ratio REAL NOT NULL,
        elapsed_ms INTEGER NOT NULL,
        raw_path TEXT NOT NULL,
        filter_version INTEGER NOT NULL,
        confidence_version INTEGER NOT NULL,
        confidence TEXT NOT NULL CHECK (confidence IN ('normal', 'low')),
        word_count INTEGER NOT NULL,
        removed_words INTEGER NOT NULL,
        low_words INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (media_id, version)
      ) STRICT;

      -- Derived from the raw JSON; rebuilt when the filter changes.
      CREATE TABLE segments (
        transcript_id TEXT NOT NULL REFERENCES transcripts (id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        text TEXT NOT NULL,
        avg_logprob REAL,
        compression_ratio REAL,
        no_speech_prob REAL,
        PRIMARY KEY (transcript_id, position)
      ) STRICT;

      CREATE TABLE words (
        transcript_id TEXT NOT NULL REFERENCES transcripts (id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        segment_position INTEGER NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        text TEXT NOT NULL,
        probability REAL,
        PRIMARY KEY (transcript_id, position)
      ) STRICT;

      -- Media already playable get transcribed too (FR-1).
      INSERT INTO jobs (id, media_id, kind, status, created_at, updated_at)
        SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
                 substr(hex(randomblob(2)), 2) || '-' ||
                 substr('89ab', 1 + (abs(random()) % 4), 1) ||
                 substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
               id, 'transcribe', 'queued', updated_at, updated_at
        FROM media WHERE status = 'ready';
    `,
  },
  {
    // KBC-049 (ADR 0030): a media item names one of its collection's authors (null is
    // "Outros autores"). Expand only: `authorship` stays, still written, so the previous
    // image (the deploy's automatic rollback) reads the same rows.
    version: 6,
    name: 'media-author',
    sql: `
      ALTER TABLE media ADD COLUMN author TEXT
        CHECK (author IS NULL OR author GLOB '[a-z0-9]*');
      UPDATE media SET author = 'mestre-laercio' WHERE authorship = 'mestre-laercio';
      CREATE INDEX media_by_author ON media (author) WHERE author IS NOT NULL;
    `,
  },
  {
    // KBC-051 (the media library). Expand only: the previous image reads the same rows.
    version: 7,
    name: 'media-library',
    sql: `
      -- When the person's player last saved a position (BR-3, BR-4); marking as heard
      -- does not play a media. Older rows were all saved by a player.
      ALTER TABLE media_progress ADD COLUMN played_at TEXT;
      UPDATE media_progress SET played_at = updated_at;
      CREATE INDEX media_progress_by_play ON media_progress (principal, played_at DESC);
      CREATE INDEX media_by_topic_status ON media (topic, status, created_at DESC);

      -- The library's choices (BR-7); null is the default.
      ALTER TABLE media_preferences ADD COLUMN library_sort TEXT CHECK (library_sort IN
        ('recently-played', 'recently-added', 'title', 'duration', 'author'));
      ALTER TABLE media_preferences ADD COLUMN library_view TEXT
        CHECK (library_view IN ('list', 'grid'));
      ALTER TABLE media_preferences ADD COLUMN library_filters TEXT
        CHECK (library_filters IS NULL OR json_valid(library_filters));

      -- "Limpar recentes" (BR-4): plays before this instant leave "Ouvidas recentemente".
      CREATE TABLE media_library_state (
        principal TEXT PRIMARY KEY,
        recents_cleared_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    // KBC-064 (ADR 0029 §1): the voices of a recording, separated on the owner's Mac: its
    // own tables only. No table holds a voice print (BR-1). The `jobs` kind 'diarize' and
    // its hint come in version 11, after KBC-044's rebuild of `jobs` (10). Version 7 is
    // KBC-051's, 9 KBC-067's, 12 KBC-039's (all open in parallel, other tables).
    version: 8,
    name: 'diarization',
    sql: `
      -- One row per separation; the raw JSON file is the source of truth (re-derivable).
      CREATE TABLE diarizations (
        id TEXT PRIMARY KEY,
        media_id TEXT NOT NULL REFERENCES media (id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version >= 1),
        transcript_id TEXT NOT NULL REFERENCES transcripts (id) ON DELETE CASCADE,
        engine TEXT NOT NULL,
        model TEXT NOT NULL,
        parameters TEXT NOT NULL,
        parameters_version TEXT NOT NULL,
        requested_voices INTEGER CHECK (requested_voices IS NULL OR requested_voices BETWEEN 1 AND 10),
        voice_count INTEGER NOT NULL CHECK (voice_count BETWEEN 0 AND 10),
        elapsed_ms INTEGER NOT NULL,
        raw_path TEXT NOT NULL,
        derivation_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (media_id, version)
      ) STRICT;

      -- Derived from the raw JSON: who speaks when, one voice per instant.
      CREATE TABLE media_speaker_turns (
        diarization_id TEXT NOT NULL REFERENCES diarizations (id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        voice INTEGER NOT NULL CHECK (voice BETWEEN 1 AND 10),
        start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
        end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
        PRIMARY KEY (diarization_id, position)
      ) STRICT;

      -- The voice of each segment and word of the transcript the separation was made on.
      CREATE TABLE media_segment_voices (
        diarization_id TEXT NOT NULL REFERENCES diarizations (id) ON DELETE CASCADE,
        segment_position INTEGER NOT NULL,
        voice INTEGER CHECK (voice IS NULL OR voice BETWEEN 1 AND 10),
        PRIMARY KEY (diarization_id, segment_position)
      ) STRICT;
      CREATE TABLE media_word_voices (
        diarization_id TEXT NOT NULL REFERENCES diarizations (id) ON DELETE CASCADE,
        word_position INTEGER NOT NULL,
        voice INTEGER CHECK (voice IS NULL OR voice BETWEEN 1 AND 10),
        PRIMARY KEY (diarization_id, word_position)
      ) STRICT;
    `,
  },
  {
    // KBC-067 (ADR 0029 §4 and §7, ADR 0022 §7): the media monthly spend ledger, the AI's
    // proposal runs and the draft tracks they write, invisible to listeners until approved.
    // Versions 7 and 8 are KBC-051's and KBC-064's (open in parallel); only new tables here.
    version: 9,
    name: 'track-proposals',
    sql: `
      -- One row per paid media run: reserved first, then settled (spent) or refunded.
      CREATE TABLE media_spend (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('track-proposal')),
        media_id TEXT,
        principal TEXT NOT NULL,
        reserved_usd REAL NOT NULL CHECK (reserved_usd >= 0),
        spent_usd REAL NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
        status TEXT NOT NULL CHECK (status IN ('reserved', 'settled', 'refunded')),
        created_at TEXT NOT NULL,
        settled_at TEXT
      ) STRICT;
      CREATE INDEX media_spend_by_time ON media_spend (created_at);

      CREATE TABLE media_proposal_runs (
        id TEXT PRIMARY KEY,
        media_id TEXT NOT NULL REFERENCES media (id) ON DELETE CASCADE,
        transcript_id TEXT NOT NULL REFERENCES transcripts (id) ON DELETE CASCADE,
        principal TEXT NOT NULL,
        model TEXT NOT NULL,
        spend_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
        windows_total INTEGER NOT NULL CHECK (windows_total >= 1),
        windows_done INTEGER NOT NULL DEFAULT 0 CHECK (windows_done >= 0),
        estimate_usd REAL NOT NULL CHECK (estimate_usd >= 0),
        spent_usd REAL NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
        failure TEXT CHECK (failure IN ('provider', 'invalid-output', 'run-cap', 'interrupted')),
        created_at TEXT NOT NULL,
        finished_at TEXT
      ) STRICT;
      CREATE INDEX media_proposal_runs_by_media ON media_proposal_runs (media_id, created_at);
      -- One run at a time per recording.
      CREATE UNIQUE INDEX media_proposal_runs_running ON media_proposal_runs (media_id)
        WHERE status = 'running';

      CREATE TABLE media_draft_tracks (
        id TEXT PRIMARY KEY,
        media_id TEXT NOT NULL REFERENCES media (id) ON DELETE CASCADE,
        run_id TEXT REFERENCES media_proposal_runs (id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK (source IN ('ai', 'manual')),
        edited INTEGER NOT NULL DEFAULT 0 CHECK (edited IN (0, 1)),
        first_segment INTEGER NOT NULL CHECK (first_segment >= 1),
        last_segment INTEGER NOT NULL CHECK (last_segment >= first_segment),
        start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
        end_ms INTEGER NOT NULL CHECK (end_ms - start_ms >= 5000),
        kind TEXT NOT NULL CHECK (kind IN ('qa', 'talk')),
        title TEXT CHECK (title IS NULL OR length(title) BETWEEN 1 AND 80),
        asker_voice INTEGER CHECK (asker_voice IS NULL OR asker_voice BETWEEN 1 AND 10),
        answerer_voice INTEGER CHECK (answerer_voice IS NULL OR answerer_voice BETWEEN 1 AND 10),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX media_draft_tracks_by_media ON media_draft_tracks (media_id, start_ms);
      CREATE INDEX media_draft_tracks_by_run ON media_draft_tracks (run_id);

      -- Names suggested for the voices from context, never from the voice (KBC-067 BR-5).
      CREATE TABLE media_voice_suggestions (
        run_id TEXT NOT NULL REFERENCES media_proposal_runs (id) ON DELETE CASCADE,
        voice INTEGER NOT NULL CHECK (voice BETWEEN 1 AND 10),
        name TEXT CHECK (name IS NULL OR length(name) BETWEEN 1 AND 80),
        audience INTEGER NOT NULL CHECK (audience IN (0, 1)),
        reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
        PRIMARY KEY (run_id, voice)
      ) STRICT;
    `,
  },
  {
    // KBC-044 (ADR 0025 §3): each media item's silence map, measured by the VM worker in a
    // `silences` job. SQLite cannot change a CHECK, so jobs are rebuilt as in version 5.
    // Versions 7 and 8 are KBC-051's and KBC-064's (open in parallel): KBC-064 also
    // rebuilds jobs, so whichever lands later keeps every kind (and its `voices` column).
    version: 10,
    name: 'silence-maps',
    sql: `
      CREATE TABLE jobs_silences (
        id TEXT PRIMARY KEY,
        media_id TEXT NOT NULL REFERENCES media (id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('transcode', 'transcribe', 'silences')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'done', 'failed', 'dead')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        lease_id TEXT,
        lease_until INTEGER,
        heartbeat_at INTEGER,
        worker TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        -- The silencedetect parameter set a silences job measures with (a newer one
        -- measures again what an older one gave up on).
        detector_version INTEGER CHECK (detector_version IS NULL OR detector_version >= 1)
      ) STRICT;
      INSERT INTO jobs_silences (id, media_id, kind, status, attempts, lease_id, lease_until,
        heartbeat_at, worker, error, created_at, updated_at)
        SELECT id, media_id, kind, status, attempts, lease_id, lease_until, heartbeat_at,
          worker, error, created_at, updated_at FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_silences RENAME TO jobs;
      CREATE INDEX jobs_queued ON jobs (kind, created_at) WHERE status = 'queued';
      CREATE INDEX jobs_leased ON jobs (lease_until) WHERE status = 'leased';
      CREATE INDEX jobs_by_media ON jobs (media_id, kind, created_at);
      CREATE INDEX jobs_by_worker ON jobs (worker) WHERE status = 'leased';

      -- One current map per media item, measured on its audio rendition; the detector
      -- version says which parameters made it (an older one is measured again).
      CREATE TABLE media_silence_maps (
        media_id TEXT PRIMARY KEY REFERENCES media (id) ON DELETE CASCADE,
        rendition TEXT NOT NULL CHECK (rendition IN ('audio')),
        detector_version INTEGER NOT NULL CHECK (detector_version >= 1),
        noise_db REAL NOT NULL,
        min_silence_ms INTEGER NOT NULL CHECK (min_silence_ms > 0),
        interval_count INTEGER NOT NULL CHECK (interval_count >= 0),
        elapsed_ms INTEGER NOT NULL CHECK (elapsed_ms >= 0),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE media_silences (
        media_id TEXT NOT NULL REFERENCES media_silence_maps (media_id) ON DELETE CASCADE,
        start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
        end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
        PRIMARY KEY (media_id, start_ms)
      ) STRICT, WITHOUT ROWID;

      -- "Encurtar silêncios", off by default (BR-2).
      ALTER TABLE media_preferences ADD COLUMN skip_silences INTEGER NOT NULL DEFAULT 0
        CHECK (skip_silences IN (0, 1));
    `,
  },
  {
    // KBC-064 after KBC-044 (10): `jobs` takes the kind 'diarize' and its hint (`voices`),
    // keeping 'silences' and `detector_version`. SQLite cannot change a CHECK, so the
    // table is rebuilt as in 5 and 10, with every column and the same four indexes.
    version: 11,
    name: 'jobs-diarize',
    sql: `
      CREATE TABLE jobs_diarize (
        id TEXT PRIMARY KEY,
        media_id TEXT NOT NULL REFERENCES media (id) ON DELETE CASCADE,
        kind TEXT NOT NULL
          CHECK (kind IN ('transcode', 'transcribe', 'silences', 'diarize')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'done', 'failed', 'dead')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        lease_id TEXT,
        lease_until INTEGER,
        heartbeat_at INTEGER,
        worker TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        detector_version INTEGER CHECK (detector_version IS NULL OR detector_version >= 1),
        -- How many voices the person announced for a separation (KBC-064 BR-4).
        voices INTEGER CHECK (voices IS NULL OR voices BETWEEN 1 AND 10)
      ) STRICT;
      INSERT INTO jobs_diarize (id, media_id, kind, status, attempts, lease_id, lease_until,
        heartbeat_at, worker, error, created_at, updated_at, detector_version)
        SELECT id, media_id, kind, status, attempts, lease_id, lease_until, heartbeat_at,
          worker, error, created_at, updated_at, detector_version FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_diarize RENAME TO jobs;
      CREATE INDEX jobs_queued ON jobs (kind, created_at) WHERE status = 'queued';
      CREATE INDEX jobs_leased ON jobs (lease_until) WHERE status = 'leased';
      CREATE INDEX jobs_by_media ON jobs (media_id, kind, created_at);
      CREATE INDEX jobs_by_worker ON jobs (worker) WHERE status = 'leased';
    `,
  },
  {
    // KBC-039 (ADR 0024 §1): the spoken words of each media's current transcript, searchable
    // without accents or case. A row's rowid is its segment's, so the row joins back to the
    // segment, its transcript and its media (collection and author are read from there).
    // Only current versions are indexed: a new version replaces its media's rows in the
    // transaction that stores it (sqlite-transcript-store.ts).
    // `segments` has a composite key, so its rowid is implicit: SQLite keeps it across
    // VACUUM and VACUUM INTO (checked on Node 22.23's SQLite) but does not promise to. If
    // that ever changes, a later migration rebuilds this index from `segments` (one
    // INSERT … SELECT, as below) or keys it by an explicit column.
    // Version 12: 7 is KBC-051's, 9 KBC-067's, 10 KBC-044's, 11 KBC-064's (open in parallel).
    version: 12,
    name: 'transcript-segments-fts',
    sql: `
      CREATE VIRTUAL TABLE segments_fts USING fts5(
        text,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      INSERT INTO segments_fts (rowid, text)
        SELECT s.rowid, s.text FROM segments s
        JOIN transcripts t ON t.id = s.transcript_id
        WHERE t.version = (SELECT max(version) FROM transcripts c WHERE c.media_id = t.media_id);
      -- A removed media takes its transcripts (cascade) and, before them, their index rows.
      CREATE TRIGGER transcripts_unindex BEFORE DELETE ON transcripts BEGIN
        DELETE FROM segments_fts WHERE rowid IN
          (SELECT rowid FROM segments WHERE transcript_id = old.id);
      END;
    `,
  },
  {
    // KBC-065 (ADR 0029 §2): the people named in a collection's recordings and who each
    // voice of a separation is. A label belongs to one separation: voice numbers mean nothing
    // outside it. Version 13: 7 is KBC-051's (open in parallel); nothing here depends on it.
    version: 13,
    name: 'media-speakers',
    sql: `
      CREATE TABLE media_speakers (
        id TEXT PRIMARY KEY,
        -- The top-level collection: a sub-collection uses its parent's list (BR-1).
        collection TEXT NOT NULL,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
        name_key TEXT NOT NULL CHECK (name_key <> ''),
        author_slug TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (collection, name_key)
      ) STRICT;
      CREATE UNIQUE INDEX media_speakers_author ON media_speakers (collection, author_slug)
        WHERE author_slug IS NOT NULL;

      CREATE TABLE media_voice_labels (
        diarization_id TEXT NOT NULL REFERENCES diarizations (id) ON DELETE CASCADE,
        voice INTEGER NOT NULL CHECK (voice BETWEEN 1 AND 10),
        speaker_id TEXT REFERENCES media_speakers (id),
        audience INTEGER NOT NULL DEFAULT 0 CHECK (audience IN (0, 1)),
        -- Joined to that voice of the same separation; its own label is kept for the undo.
        merged_into INTEGER CHECK (merged_into IS NULL OR merged_into BETWEEN 1 AND 10),
        -- The name came from a voice joined to this one, not from a person: the undo takes it back.
        name_from_join INTEGER NOT NULL DEFAULT 0 CHECK (name_from_join IN (0, 1)),
        CHECK (audience = 0 OR speaker_id IS NULL),
        CHECK (merged_into IS NULL OR merged_into <> voice),
        PRIMARY KEY (diarization_id, voice)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX media_voice_labels_speaker ON media_voice_labels (speaker_id)
        WHERE speaker_id IS NOT NULL;

      -- A new separation's names wait for a person to confirm them (BR-5).
      ALTER TABLE diarizations ADD COLUMN names_pending INTEGER NOT NULL DEFAULT 0
        CHECK (names_pending IN (0, 1));
    `,
  },
  {
    // KBC-066 (ADR 0029 §4): the draft stays in KBC-067's table, rebuilt because a person's
    // title goes to 120 characters and a person's track has no segments, and `media_tracks`
    // holds what was approved, the only tracks listeners see. `jobs` takes the kind
    // 'waveform'; SQLite cannot change a CHECK, so both are rebuilt as in 5, 10 and 11.
    version: 14,
    name: 'media-edits',
    sql: `
      CREATE TABLE jobs_waveform (
        id TEXT PRIMARY KEY,
        media_id TEXT NOT NULL REFERENCES media (id) ON DELETE CASCADE,
        kind TEXT NOT NULL
          CHECK (kind IN ('transcode', 'transcribe', 'silences', 'diarize', 'waveform')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'done', 'failed', 'dead')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        lease_id TEXT,
        lease_until INTEGER,
        heartbeat_at INTEGER,
        worker TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        -- The parameter set of a silences or waveform job (a newer one measures again).
        detector_version INTEGER CHECK (detector_version IS NULL OR detector_version >= 1),
        voices INTEGER CHECK (voices IS NULL OR voices BETWEEN 1 AND 10)
      ) STRICT;
      INSERT INTO jobs_waveform (id, media_id, kind, status, attempts, lease_id, lease_until,
        heartbeat_at, worker, error, created_at, updated_at, detector_version, voices)
        SELECT id, media_id, kind, status, attempts, lease_id, lease_until, heartbeat_at,
          worker, error, created_at, updated_at, detector_version, voices FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_waveform RENAME TO jobs;
      CREATE INDEX jobs_queued ON jobs (kind, created_at) WHERE status = 'queued';
      CREATE INDEX jobs_leased ON jobs (lease_until) WHERE status = 'leased';
      CREATE INDEX jobs_by_media ON jobs (media_id, kind, created_at);
      CREATE INDEX jobs_by_worker ON jobs (worker) WHERE status = 'leased';

      -- One byte per peak, 10 per second: 2 h is 72 kB.
      CREATE TABLE media_waveforms (
        media_id TEXT PRIMARY KEY REFERENCES media (id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version >= 1),
        peaks BLOB NOT NULL,
        elapsed_ms INTEGER NOT NULL CHECK (elapsed_ms >= 0),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE media_draft_tracks_edit (
        id TEXT PRIMARY KEY,
        media_id TEXT NOT NULL REFERENCES media (id) ON DELETE CASCADE,
        run_id TEXT REFERENCES media_proposal_runs (id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK (source IN ('ai', 'manual')),
        edited INTEGER NOT NULL DEFAULT 0 CHECK (edited IN (0, 1)),
        first_segment INTEGER CHECK (first_segment IS NULL OR first_segment >= 1),
        last_segment INTEGER CHECK (last_segment IS NULL OR last_segment >= first_segment),
        start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
        end_ms INTEGER NOT NULL CHECK (end_ms - start_ms >= 5000),
        kind TEXT NOT NULL CHECK (kind IN ('qa', 'talk')),
        title TEXT CHECK (title IS NULL OR length(title) BETWEEN 1 AND 120),
        asker_voice INTEGER CHECK (asker_voice IS NULL OR asker_voice BETWEEN 1 AND 10),
        answerer_voice INTEGER CHECK (answerer_voice IS NULL OR answerer_voice BETWEEN 1 AND 10),
        asker_speaker_id TEXT REFERENCES media_speakers (id) ON DELETE SET NULL,
        answerer_speaker_id TEXT REFERENCES media_speakers (id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO media_draft_tracks_edit (id, media_id, run_id, source, edited, first_segment,
        last_segment, start_ms, end_ms, kind, title, asker_voice, answerer_voice, created_at)
        SELECT id, media_id, run_id, source, edited, first_segment, last_segment, start_ms,
          end_ms, kind, title, asker_voice, answerer_voice, created_at FROM media_draft_tracks;
      DROP TABLE media_draft_tracks;
      ALTER TABLE media_draft_tracks_edit RENAME TO media_draft_tracks;
      CREATE INDEX media_draft_tracks_by_media ON media_draft_tracks (media_id, start_ms);
      CREATE INDEX media_draft_tracks_by_run ON media_draft_tracks (run_id);

      -- One edit per recording. A proposal's windows change the draft too: they bump version.
      CREATE TABLE media_edits (
        media_id TEXT PRIMARY KEY REFERENCES media (id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version >= 1),
        status TEXT NOT NULL CHECK (status IN ('draft', 'approved')),
        step INTEGER NOT NULL CHECK (step IN (3, 4)),
        -- The transcript the edit began on or was last approved on (BR-10); null: none then.
        transcript_version INTEGER,
        updated_by TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE media_tracks (
        id TEXT PRIMARY KEY,
        media_id TEXT NOT NULL REFERENCES media (id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
        start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
        end_ms INTEGER NOT NULL CHECK (end_ms - start_ms >= 5000),
        kind TEXT NOT NULL CHECK (kind IN ('qa', 'talk')),
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
        source TEXT NOT NULL CHECK (source IN ('ai', 'manual')),
        asker_voice INTEGER CHECK (asker_voice IS NULL OR asker_voice BETWEEN 1 AND 10),
        answerer_voice INTEGER CHECK (answerer_voice IS NULL OR answerer_voice BETWEEN 1 AND 10),
        asker_speaker_id TEXT REFERENCES media_speakers (id) ON DELETE SET NULL,
        answerer_speaker_id TEXT REFERENCES media_speakers (id) ON DELETE SET NULL,
        approved_by TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        UNIQUE (media_id, ordinal)
      ) STRICT;

      -- A draft older than this table: without an edit it would read as version 0.
      INSERT INTO media_edits (media_id, version, status, step, transcript_version, updated_at)
        SELECT d.media_id, 1, 'draft', 3,
          (SELECT max(t.version) FROM transcripts t WHERE t.media_id = d.media_id),
          max(d.created_at)
        FROM media_draft_tracks d GROUP BY d.media_id;
    `,
  },
  {
    // KBC-071 (ADR 0032): consents, profiles without their print (a print is a sealed file
    // outside this database and its backup), their sources and the suggestions. `jobs` takes
    // the kind 'voice-profile' and the profile it calculates, and keeps KBC-066's
    // 'waveform' from version 14. A rebuild of `jobs` that lands after this one must keep this
    // kind and column.
    version: 15,
    name: 'voice-profiles',
    sql: `
      CREATE TABLE voice_consents (
        id TEXT PRIMARY KEY,
        -- Stays after the profile goes: a revocation the list missed is written at the next start.
        profile_id TEXT NOT NULL UNIQUE,
        collection TEXT NOT NULL,
        speaker_id TEXT NOT NULL REFERENCES media_speakers (id),
        -- The name authorised, as it was then: this row is the record of the consent.
        speaker_name TEXT NOT NULL,
        subject TEXT NOT NULL CHECK (subject IN ('living', 'deceased')),
        granted_by TEXT NOT NULL,
        granted_by_role TEXT,
        granted_on TEXT NOT NULL,
        method TEXT NOT NULL CHECK (method IN ('signed-paper', 'signed-digital', 'email')),
        purpose TEXT NOT NULL CHECK (purpose = 'suggest-names-when-editing'),
        text_version INTEGER NOT NULL CHECK (text_version >= 1),
        registered_by TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        revoked_at TEXT,
        revoked_by TEXT,
        -- Kept here because revoking deletes the suggestions (FR-5).
        suggestions_made INTEGER NOT NULL DEFAULT 0 CHECK (suggestions_made >= 0),
        suggestions_accepted INTEGER NOT NULL DEFAULT 0 CHECK (suggestions_accepted >= 0),
        suggestions_refused INTEGER NOT NULL DEFAULT 0 CHECK (suggestions_refused >= 0),
        CHECK (subject = 'living' OR granted_by_role IS NOT NULL),
        CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
      ) STRICT;
      CREATE INDEX voice_consents_by_date ON voice_consents (registered_at DESC);

      -- The text of the acceptance or the attached document, sealed (ADR 0017).
      CREATE TABLE voice_consent_evidence (
        consent_id TEXT PRIMARY KEY REFERENCES voice_consents (id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('text', 'attachment')),
        file_name TEXT,
        mime TEXT,
        sealed TEXT NOT NULL,
        CHECK (kind = 'text' OR (file_name IS NOT NULL AND mime IS NOT NULL))
      ) STRICT;

      -- No consent, no profile (BR-1).
      CREATE TABLE voice_profiles (
        id TEXT PRIMARY KEY,
        consent_id TEXT NOT NULL UNIQUE REFERENCES voice_consents (id),
        speaker_id TEXT NOT NULL UNIQUE REFERENCES media_speakers (id),
        -- The top-level collection: the profile holds there and in its sub-collections (BR-4).
        collection TEXT NOT NULL,
        -- Set when the print is stored; null while it is calculated, or when it failed.
        model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX voice_profiles_by_collection ON voice_profiles (collection);

      CREATE TABLE voice_profile_sources (
        profile_id TEXT NOT NULL REFERENCES voice_profiles (id) ON DELETE CASCADE,
        diarization_id TEXT NOT NULL REFERENCES diarizations (id) ON DELETE CASCADE,
        voice INTEGER NOT NULL CHECK (voice BETWEEN 1 AND 10),
        PRIMARY KEY (profile_id, diarization_id, voice)
      ) STRICT, WITHOUT ROWID;

      -- Above the threshold only (BR-3), and always waiting for a person (AC-2).
      CREATE TABLE voice_profile_suggestions (
        diarization_id TEXT NOT NULL REFERENCES diarizations (id) ON DELETE CASCADE,
        voice INTEGER NOT NULL CHECK (voice BETWEEN 1 AND 10),
        profile_id TEXT NOT NULL REFERENCES voice_profiles (id) ON DELETE CASCADE,
        similarity REAL NOT NULL CHECK (similarity BETWEEN -1 AND 1),
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'accepted', 'refused')),
        decided_by TEXT,
        decided_at TEXT,
        PRIMARY KEY (diarization_id, voice)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX voice_profile_suggestions_by_profile
        ON voice_profile_suggestions (profile_id);

      CREATE TABLE jobs_voice_profile (
        id TEXT PRIMARY KEY,
        media_id TEXT NOT NULL REFERENCES media (id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN
          ('transcode', 'transcribe', 'silences', 'diarize', 'waveform', 'voice-profile')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'done', 'failed', 'dead')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        lease_id TEXT,
        lease_until INTEGER,
        heartbeat_at INTEGER,
        worker TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        detector_version INTEGER CHECK (detector_version IS NULL OR detector_version >= 1),
        voices INTEGER CHECK (voices IS NULL OR voices BETWEEN 1 AND 10),
        -- Revoking takes the job with the profile (BR-2).
        voice_profile_id TEXT REFERENCES voice_profiles (id) ON DELETE CASCADE,
        CHECK ((kind = 'voice-profile') = (voice_profile_id IS NOT NULL))
      ) STRICT;
      INSERT INTO jobs_voice_profile (id, media_id, kind, status, attempts, lease_id,
        lease_until, heartbeat_at, worker, error, created_at, updated_at, detector_version,
        voices)
        SELECT id, media_id, kind, status, attempts, lease_id, lease_until, heartbeat_at,
          worker, error, created_at, updated_at, detector_version, voices FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_voice_profile RENAME TO jobs;
      CREATE INDEX jobs_queued ON jobs (kind, created_at) WHERE status = 'queued';
      CREATE INDEX jobs_leased ON jobs (lease_until) WHERE status = 'leased';
      CREATE INDEX jobs_by_media ON jobs (media_id, kind, created_at);
      CREATE INDEX jobs_by_worker ON jobs (worker) WHERE status = 'leased';
      CREATE INDEX jobs_by_voice_profile ON jobs (voice_profile_id)
        WHERE voice_profile_id IS NOT NULL;
    `,
  },
  {
    // KBC-072: the guided flow's plan per recording. Stage states are read from the jobs and
    // runs, so only what they cannot say is here. The cuts have their own table: migration 15
    // (KBC-071) rebuilds `jobs`, and a column added here would not survive it.
    version: 17,
    name: 'media-preparations',
    sql: `
      CREATE TABLE media_preparations (
        media_id TEXT PRIMARY KEY REFERENCES media (id) ON DELETE CASCADE,
        principal TEXT NOT NULL,
        transcribe INTEGER NOT NULL CHECK (transcribe IN (0, 1)),
        speakers INTEGER NOT NULL CHECK (speakers IN (0, 1)),
        tracks TEXT NOT NULL CHECK (tracks IN ('none', 'manual', 'ai')),
        subjects INTEGER NOT NULL CHECK (subjects IN (0, 1)),
        accepted_usd REAL CHECK (accepted_usd IS NULL OR accepted_usd >= 0),
        speakers_asked_at TEXT,
        proposal_claimed_at TEXT,
        proposal_stop TEXT,
        proposal_stop_usd REAL,
        validating_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX media_preparations_open ON media_preparations (media_id)
        WHERE finished_at IS NULL;

      CREATE TABLE media_transcribe_cuts (
        media_id TEXT PRIMARY KEY REFERENCES media (id) ON DELETE CASCADE,
        job_id TEXT NOT NULL,
        done INTEGER NOT NULL CHECK (done >= 0),
        total INTEGER NOT NULL CHECK (total >= 1 AND total >= done),
        updated_at TEXT NOT NULL
      ) STRICT;

      -- What the runs before this one spent, when it goes on from a failed one (BR-6): each
      -- reservation pays its own part, and the run's spent_usd is the analysis as a whole.
      ALTER TABLE media_proposal_runs
        ADD COLUMN carried_usd REAL NOT NULL DEFAULT 0 CHECK (carried_usd >= 0);
    `,
  },
  {
    // KBC-068 (ADR 0029 §5): an approved track becomes a media row of its own, cut from its
    // recording. The bounds on the media row are the real, published ones; the ones on
    // media_tracks are what was asked. Versions 16 and 17 are KBC-045's and KBC-072's (open in
    // parallel) and 19 may already be applied: `jobs` is rebuilt from what it is, see the helper.
    version: 18,
    name: 'track-items',
    sql: (db) => `
      ${rebuildJobsAccepting(db, 'cut')}

      ALTER TABLE media ADD COLUMN parent_media_id TEXT REFERENCES media (id) ON DELETE CASCADE;
      ALTER TABLE media ADD COLUMN parent_start_ms INTEGER CHECK (parent_start_ms >= 0);
      ALTER TABLE media ADD COLUMN parent_end_ms INTEGER CHECK (parent_end_ms >= 0);
      -- Its place among the published tracks; null while waiting and once it left.
      ALTER TABLE media ADD COLUMN track_ordinal INTEGER CHECK (track_ordinal >= 1);
      -- A track that left the edit: out of the library and search, kept for who saved it.
      ALTER TABLE media ADD COLUMN archived_at TEXT;
      CREATE INDEX media_tracks_of ON media (parent_media_id) WHERE parent_media_id IS NOT NULL;

      ALTER TABLE media_tracks ADD COLUMN derived_media_id TEXT
        REFERENCES media (id) ON DELETE SET NULL;
      -- none: approved before tracks became items; pending: its cut is on the way; cut: the
      -- candidate waits for the others; published: listeners have it.
      ALTER TABLE media_tracks ADD COLUMN cut_status TEXT NOT NULL DEFAULT 'none'
        CHECK (cut_status IN ('none', 'pending', 'cut', 'published'));
      ALTER TABLE media_tracks ADD COLUMN cut_path TEXT;
      ALTER TABLE media_tracks ADD COLUMN cut_bytes INTEGER CHECK (cut_bytes > 0);
      ALTER TABLE media_tracks ADD COLUMN cut_duration_ms INTEGER CHECK (cut_duration_ms > 0);
      CREATE INDEX media_tracks_by_derived ON media_tracks (derived_media_id)
        WHERE derived_media_id IS NOT NULL;
      -- Search asks, per matched segment, whether any of its words is outside the tracks (BR-6).
      -- KBC-045's migration 16 creates \`words_by_segment\` with these columns and may run before
      -- or after this one, so the name differs; with \`position\`, this index can replace that one.
      CREATE INDEX words_by_segment_position
        ON words (transcript_id, segment_position, position);
    `,
  },
  {
    // KBC-040: who saved each version of the term list and when (BR-1). The pilot's list has
    // no author. Numbered 19 because 16 to 18 are taken by items not merged yet; `jobs` stays.
    version: 19,
    name: 'term-versions',
    sql: `
      CREATE TABLE term_versions (
        version INTEGER PRIMARY KEY CHECK (version >= 1),
        created_at TEXT NOT NULL,
        author_principal TEXT,
        author_name TEXT
      ) STRICT;
      INSERT INTO term_versions (version, created_at)
        SELECT DISTINCT version, '2026-10-28T12:00:00.000Z' FROM terms;
    `,
  },
];
