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
];
