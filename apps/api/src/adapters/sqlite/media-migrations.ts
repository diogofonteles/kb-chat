/**
 * The media database's schema (ADR 0022), as numbered migrations applied in order at API
 * start. A migration is never edited once released: a change is a new migration.
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
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
];
