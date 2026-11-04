import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  trackChangeFieldSchema,
  type TrackChange,
  type TrackCutState,
  type TrackImpact,
} from '@kb-chat/contracts';
import type {
  ArchivedTrackRow,
  ChangeAuthor,
  NewChange,
  OldTrackFile,
  RevisableTrack,
  TrackRevisionStorePort,
  TrackRole,
} from '../../ports/track-revision-store.js';
import { inTransaction } from './media-database.js';

type Row = Record<string, SQLOutputValue>;

const HISTORY_LIMIT = 200;
/** Above any ordinal: renumbering must not cross UNIQUE (media_id, ordinal) on its way. */
const ORDINAL_OFFSET = 1_000_000;

const TRACK = `SELECT t.id, t.derived_media_id, t.media_id, t.ordinal, t.title, t.start_ms,
    t.end_ms, t.asker_voice, t.answerer_voice, t.asker_speaker_id, t.answerer_speaker_id,
    t.cut_status,
    (SELECT j.status FROM jobs j WHERE j.media_id = t.derived_media_id AND j.kind = 'cut'
     ORDER BY j.created_at DESC, j.rowid DESC LIMIT 1) AS job_status
  FROM media_tracks t`;

const nullableNumber = (value: SQLOutputValue | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);
const nullableText = (value: SQLOutputValue | undefined): string | null =>
  value === null || value === undefined ? null : String(value);

function cutStateOf(row: Row): TrackCutState {
  if (row['cut_status'] !== 'pending' && row['cut_status'] !== 'cut')
    return 'none';
  const job = row['job_status'];
  return job === 'failed' || job === 'dead' ? 'failed' : 'running';
}

function toTrack(row: Row): RevisableTrack {
  return {
    trackId: String(row['id']),
    mediaId: String(row['derived_media_id']),
    parentId: String(row['media_id']),
    ordinal: Number(row['ordinal']),
    title: String(row['title']),
    startMs: Number(row['start_ms']),
    endMs: Number(row['end_ms']),
    askerVoice: nullableNumber(row['asker_voice']),
    answererVoice: nullableNumber(row['answerer_voice']),
    askerSpeakerId: nullableText(row['asker_speaker_id']),
    answererSpeakerId: nullableText(row['answerer_speaker_id']),
    cut: cutStateOf(row),
  };
}

function toChange(row: Row): TrackChange {
  return {
    id: String(row['id']),
    at: String(row['at']),
    by: String(row['person_name']),
    field: trackChangeFieldSchema.parse(row['field']),
    before: nullableText(row['before_value']),
    after: nullableText(row['after_value']),
  };
}

/** A track's rows after its approval (KBC-073), in `media.db`. */
export class SqliteTrackRevisionStore implements TrackRevisionStorePort {
  constructor(private readonly db: DatabaseSync) {}

  atomically<T>(work: () => T): T {
    return inTransaction(this.db, work);
  }

  track(mediaId: string): RevisableTrack | null {
    const row = this.db
      .prepare(`${TRACK} WHERE t.derived_media_id = ?`)
      .get(mediaId);
    return row ? toTrack(row) : null;
  }

  tracks(parentId: string): readonly RevisableTrack[] {
    return this.db
      .prepare(
        `${TRACK} WHERE t.media_id = ? AND t.derived_media_id IS NOT NULL
         ORDER BY t.ordinal`,
      )
      .all(parentId)
      .map(toTrack);
  }

  bump(mediaId: string, expectedVersion: number): boolean {
    const { changes } = this.db
      .prepare(
        `UPDATE media SET track_version = track_version + 1
         WHERE id = ? AND track_version = ?`,
      )
      .run(mediaId, expectedVersion);
    return changes === 1;
  }

  touch(mediaId: string): void {
    this.db
      .prepare(
        'UPDATE media SET track_version = track_version + 1 WHERE id = ?',
      )
      .run(mediaId);
  }

  rename(track: RevisableTrack, title: string, now: Date): void {
    this.db
      .prepare('UPDATE media SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, now.toISOString(), track.mediaId);
    for (const table of ['media_tracks', 'media_draft_tracks'])
      this.db
        .prepare(`UPDATE ${table} SET title = ? WHERE id = ?`)
        .run(title, track.trackId);
  }

  setSpeaker(
    track: RevisableTrack,
    change: { role: TrackRole; speakerId: string | null },
  ): void {
    const column = `${change.role}_speaker_id`;
    for (const table of ['media_tracks', 'media_draft_tracks'])
      this.db
        .prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`)
        .run(change.speakerId, track.trackId);
  }

  followVoice(input: {
    parentId: string;
    voice: number;
    former: string | null;
  }): void {
    const { parentId, voice, former } = input;
    if (former === null) return;
    for (const table of ['media_tracks', 'media_draft_tracks'])
      for (const role of ['asker', 'answerer'])
        this.db
          .prepare(
            `UPDATE ${table} SET ${role}_speaker_id = NULL
             WHERE media_id = ? AND ${role}_voice = ? AND ${role}_speaker_id = ?`,
          )
          .run(parentId, voice, former);
  }

  moveBounds(input: {
    track: RevisableTrack;
    startMs: number;
    endMs: number;
    jobId: string;
    now: Date;
  }): void {
    const { track, startMs, endMs } = input;
    this.db
      .prepare(
        `UPDATE media_tracks SET start_ms = ?, end_ms = ?, cut_status = 'pending'
         WHERE id = ?`,
      )
      .run(startMs, endMs, track.trackId);
    this.db
      .prepare(
        'UPDATE media_draft_tracks SET start_ms = ?, end_ms = ?, edited = 1 WHERE id = ?',
      )
      .run(startMs, endMs, track.trackId);
    this.queueCut(track.mediaId, input.jobId, input.now.toISOString());
  }

  private queueCut(mediaId: string, jobId: string, at: string): void {
    this.db
      .prepare(
        `DELETE FROM jobs WHERE media_id = ? AND kind = 'cut'
           AND status IN ('failed', 'dead')`,
      )
      .run(mediaId);
    this.db
      .prepare(
        `INSERT INTO jobs (id, media_id, kind, status, created_at, updated_at)
         VALUES (?, ?, 'cut', 'queued', ?, ?)`,
      )
      .run(jobId, mediaId, at, at);
  }

  archive(track: RevisableTrack, now: Date): void {
    const at = now.toISOString();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO media_track_archive (media_id, track_id, kind, source,
           asker_voice, answerer_voice, asker_speaker_id, answerer_speaker_id)
         SELECT derived_media_id, id, kind, source, asker_voice, answerer_voice,
           asker_speaker_id, answerer_speaker_id
         FROM media_tracks WHERE id = ?`,
      )
      .run(track.trackId);
    this.db
      .prepare(
        `DELETE FROM segments_fts WHERE rowid IN (
           SELECT s.rowid FROM segments s JOIN transcripts t ON t.id = s.transcript_id
           WHERE t.media_id = ?)`,
      )
      .run(track.mediaId);
    this.db
      .prepare(
        `UPDATE media SET archived_at = ?, track_ordinal = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(at, at, track.mediaId);
    for (const table of ['media_tracks', 'media_draft_tracks'])
      this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(track.trackId);
    this.renumber(track.parentId);
  }

  /** Places by start time, as the screen numbers them. */
  private renumber(parentId: string): void {
    this.db
      .prepare(
        'UPDATE media_tracks SET ordinal = ordinal + ? WHERE media_id = ?',
      )
      .run(ORDINAL_OFFSET, parentId);
    this.db
      .prepare(
        `UPDATE media_tracks SET ordinal = (SELECT count(*) FROM media_tracks o
           WHERE o.media_id = media_tracks.media_id
             AND o.start_ms <= media_tracks.start_ms)
         WHERE media_id = ?`,
      )
      .run(parentId);
    this.db
      .prepare(
        `UPDATE media SET track_ordinal = (SELECT t.ordinal FROM media_tracks t
           WHERE t.derived_media_id = media.id)
         WHERE parent_media_id = ? AND archived_at IS NULL AND status = 'ready'`,
      )
      .run(parentId);
  }

  restore(input: {
    mediaId: string;
    trackId: string;
    principal: string;
    now: Date;
  }): void {
    const { mediaId, principal } = input;
    const at = input.now.toISOString();
    const values = this.keptValues(mediaId, input.trackId);
    const parentId = String(values[1]);
    this.db
      .prepare(
        `INSERT INTO media_tracks (id, media_id, start_ms, end_ms, kind, title, source,
           asker_voice, answerer_voice, asker_speaker_id, answerer_speaker_id,
           ordinal, approved_by, approved_at, derived_media_id, cut_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           (SELECT coalesce(max(ordinal), 0) + 1 FROM media_tracks WHERE media_id = ?),
           ?, ?, ?, 'published')`,
      )
      .run(...values, parentId, principal, at, mediaId);
    this.db
      .prepare(
        `INSERT INTO media_draft_tracks (id, media_id, start_ms, end_ms, kind, title, source,
           asker_voice, answerer_voice, asker_speaker_id, answerer_speaker_id, edited, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(...values, at);
    this.db
      .prepare(
        'UPDATE media SET archived_at = NULL, updated_at = ? WHERE id = ?',
      )
      .run(at, mediaId);
    this.db
      .prepare('DELETE FROM media_track_archive WHERE media_id = ?')
      .run(mediaId);
    this.renumber(parentId);
  }

  /** The row as it was; one that left by an approval keeps only what its item says. */
  private keptValues(mediaId: string, trackId: string) {
    const kept = this.db
      .prepare('SELECT * FROM media_track_archive WHERE media_id = ?')
      .get(mediaId);
    const row = this.mediaRow(mediaId);
    return [
      kept ? String(kept['track_id']) : trackId,
      String(row['parent_media_id']),
      row['parent_start_ms'] ?? 0,
      row['parent_end_ms'] ?? 0,
      kept?.['kind'] ?? 'qa',
      row['title'] ?? '',
      kept?.['source'] ?? 'manual',
      kept?.['asker_voice'] ?? null,
      kept?.['answerer_voice'] ?? null,
      kept?.['asker_speaker_id'] ?? null,
      kept?.['answerer_speaker_id'] ?? null,
    ] as const;
  }

  private mediaRow(mediaId: string): Row {
    const row = this.db
      .prepare(
        `SELECT title, parent_media_id, parent_start_ms, parent_end_ms FROM media
         WHERE id = ?`,
      )
      .get(mediaId);
    if (!row) throw new Error(`track ${mediaId} does not exist`);
    return row;
  }

  archived(parentId: string, since: Date): readonly ArchivedTrackRow[] {
    return this.db
      .prepare(
        `SELECT m.id, m.title, m.parent_start_ms, m.parent_end_ms, m.archived_at FROM media m
         WHERE m.parent_media_id = ? AND m.status = 'ready' AND m.archived_at >= ?
         ORDER BY m.archived_at DESC`,
      )
      .all(parentId, since.toISOString())
      .map((row) => ({
        mediaId: String(row['id']),
        title: String(row['title']),
        startMs: Number(row['parent_start_ms']),
        endMs: Number(row['parent_end_ms']),
        archivedAt: String(row['archived_at']),
      }));
  }

  impact(mediaId: string): TrackImpact {
    const row = this.db
      .prepare(
        `SELECT (SELECT count(*) FROM media_progress
             WHERE media_id = ? AND (position_ms > 0 OR completed_at IS NOT NULL)) AS listeners,
           (SELECT count(*) FROM media_bookmarks WHERE media_id = ?) AS bookmarks`,
      )
      .get(mediaId, mediaId);
    return {
      listeners: Number(row?.['listeners'] ?? 0),
      bookmarks: Number(row?.['bookmarks'] ?? 0),
    };
  }

  record(
    mediaId: string,
    changes: readonly NewChange[],
    author: ChangeAuthor,
  ): void {
    const insert = this.db.prepare(
      `INSERT INTO media_track_changes (id, media_id, at, principal, person_name, field,
         before_value, after_value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const change of changes)
      insert.run(
        randomUUID(),
        mediaId,
        author.now.toISOString(),
        author.principal,
        author.name,
        change.field,
        change.before,
        change.after,
      );
  }

  history(mediaId: string): TrackChange[] {
    return this.db
      .prepare(
        `SELECT * FROM media_track_changes WHERE media_id = ?
         ORDER BY at DESC, rowid DESC LIMIT ?`,
      )
      .all(mediaId, HISTORY_LIMIT)
      .map(toChange);
  }

  oldFile(mediaId: string, fileVersion: number): OldTrackFile | null {
    const row = this.db
      .prepare(
        `SELECT path, mime, start_ms FROM media_track_old_files
         WHERE media_id = ? AND file_version = ?`,
      )
      .get(mediaId, fileVersion);
    if (!row) return null;
    return {
      path: String(row['path']),
      mime: String(row['mime']),
      startMs: Number(row['start_ms']),
    };
  }

  takeOldFiles(before: Date): readonly string[] {
    return this.db
      .prepare(
        'DELETE FROM media_track_old_files WHERE replaced_at < ? RETURNING path',
      )
      .all(before.toISOString())
      .map((row) => String(row['path']));
  }

  takeArchivedFiles(before: Date): readonly string[] {
    return this.db
      .prepare(
        `DELETE FROM media_files WHERE rendition = 'audio' AND media_id IN (
           SELECT id FROM media WHERE archived_at IS NOT NULL AND archived_at < ?)
         RETURNING path`,
      )
      .all(before.toISOString())
      .map((row) => String(row['path']));
  }

  movedBookmarks(principal: string) {
    return this.db
      .prepare(
        `SELECT media_id, recording_id, title, count(*) AS n FROM media_moved_bookmarks
         WHERE principal = ? GROUP BY media_id, recording_id, title
         ORDER BY max(moved_at) DESC`,
      )
      .all(principal)
      .map((row) => ({
        mediaId: String(row['media_id']),
        recordingId: String(row['recording_id']),
        title: String(row['title']),
        count: Number(row['n']),
      }));
  }

  acknowledgeMoved(principal: string): void {
    this.db
      .prepare('DELETE FROM media_moved_bookmarks WHERE principal = ?')
      .run(principal);
  }
}
