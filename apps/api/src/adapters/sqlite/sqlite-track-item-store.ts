import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { TrackPreparation } from '@kb-chat/contracts';
import type {
  CutOrder,
  DetailsOf,
  RecordedCut,
  TrackDetails,
  TrackItemRow,
  TrackItemStorePort,
  TrackPlan,
} from '../../ports/track-item-store.js';
import { inTransaction } from './media-database.js';
import { closeLease } from './sqlite-leases.js';
import type { SqliteTranscriptStore } from './sqlite-transcript-store.js';

type Row = Record<string, SQLOutputValue>;

const TRACK_ROW = `SELECT t.id, t.ordinal, t.title, t.start_ms, t.end_ms, t.answerer_voice,
    t.answerer_speaker_id, t.derived_media_id, t.cut_status, t.cut_duration_ms,
    m.parent_start_ms, m.parent_end_ms
  FROM media_tracks t JOIN media m ON m.id = t.derived_media_id`;

const nullableText = (value: SQLOutputValue | undefined): string | null =>
  value === null || value === undefined ? null : String(value);
const nullableNumber = (value: SQLOutputValue | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);

function toTrackRow(row: Row): TrackItemRow {
  const cut = row['cut_status'] === 'cut';
  const realStartMs = Number(
    cut ? row['start_ms'] : (row['parent_start_ms'] ?? row['start_ms']),
  );
  return {
    trackId: String(row['id']),
    ordinal: Number(row['ordinal']),
    title: String(row['title']),
    startMs: Number(row['start_ms']),
    endMs: Number(row['end_ms']),
    answererVoice: nullableNumber(row['answerer_voice']),
    answererSpeakerId: nullableText(row['answerer_speaker_id']),
    mediaId: String(row['derived_media_id']),
    cut,
    realStartMs,
    realEndMs: cut
      ? realStartMs + Number(row['cut_duration_ms'])
      : Number(row['parent_end_ms'] ?? row['end_ms']),
  };
}

/** Where a kept item's listeners go when its bounds move (KBC-073 BR-4). */
interface Remap {
  readonly mediaId: string;
  readonly parentId: string;
  readonly oldStartMs: number;
  readonly newStartMs: number;
  readonly durationMs: number;
  readonly at: string;
}

/** Track items in `media.db` (KBC-068, ADR 0029 §5). */
export class SqliteTrackItemStore implements TrackItemStorePort {
  constructor(
    private readonly db: DatabaseSync,
    private readonly transcripts: SqliteTranscriptStore,
  ) {}

  published(parentId: string) {
    return this.db
      .prepare(
        `SELECT id, parent_start_ms, parent_end_ms FROM media
         WHERE parent_media_id = ? AND status = 'ready' AND archived_at IS NULL`,
      )
      .all(parentId)
      .map((row) => ({
        mediaId: String(row['id']),
        startMs: Number(row['parent_start_ms']),
        endMs: Number(row['parent_end_ms']),
      }));
  }

  plan(input: { parentId: string; plans: readonly TrackPlan[]; now: Date }) {
    inTransaction(this.db, () => {
      for (const plan of input.plans) this.applyPlan(input, plan);
    });
  }

  private applyPlan(
    input: { parentId: string; now: Date },
    plan: TrackPlan,
  ): void {
    const at = input.now.toISOString();
    const mediaId = plan.keptMediaId ?? plan.newMediaId;
    if (plan.keptMediaId === null) this.insertItem(input.parentId, plan, at);
    this.db
      .prepare(
        `UPDATE media_tracks SET derived_media_id = ?, cut_status = ? WHERE id = ?`,
      )
      .run(mediaId, plan.cutJobId ? 'pending' : 'published', plan.trackId);
    if (plan.cutJobId)
      this.db
        .prepare(
          `INSERT INTO jobs (id, media_id, kind, status, created_at, updated_at)
           VALUES (?, ?, 'cut', 'queued', ?, ?)`,
        )
        .run(plan.cutJobId, mediaId, at, at);
  }

  /** Waits as `queued`, seen by nobody, until the whole approval is published (FR-1). */
  private insertItem(parentId: string, plan: TrackPlan, at: string): void {
    this.db
      .prepare(
        `INSERT INTO media (id, topic, title, author, authorship, owner_principal, kind,
           file_name, upload_bytes, status, created_at, updated_at, parent_media_id)
         SELECT ?, p.topic, t.title, p.author, p.authorship, p.owner_principal, p.kind,
           t.id || '.m4a', 1, 'queued', ?, ?, p.id
         FROM media p JOIN media_tracks t ON t.media_id = p.id
         WHERE p.id = ? AND t.id = ?`,
      )
      .run(plan.newMediaId, at, at, parentId, plan.trackId);
  }

  hasPendingCuts(parentId: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM media_tracks WHERE media_id = ? AND cut_status = 'pending' LIMIT 1`,
        )
        .get(parentId) !== undefined
    );
  }

  cancelPreparation(parentId: string): readonly string[] {
    return inTransaction(this.db, () => {
      const candidates = this.db
        .prepare(
          `SELECT cut_path FROM media_tracks
           WHERE media_id = ? AND cut_status = 'cut' AND cut_path IS NOT NULL`,
        )
        .all(parentId)
        .map((row) => String(row['cut_path']));
      this.db
        .prepare(
          `DELETE FROM jobs WHERE kind = 'cut' AND media_id IN
             (SELECT id FROM media WHERE parent_media_id = ?)`,
        )
        .run(parentId);
      this.db
        .prepare(
          `DELETE FROM media WHERE parent_media_id = ? AND status <> 'ready'
             AND archived_at IS NULL`,
        )
        .run(parentId);
      this.db
        .prepare(
          `UPDATE media_tracks SET cut_status = 'none', cut_path = NULL, cut_bytes = NULL,
             cut_duration_ms = NULL
           WHERE media_id = ? AND cut_status IN ('pending', 'cut')`,
        )
        .run(parentId);
      return candidates;
    });
  }

  cutOrder(mediaId: string): CutOrder | null {
    const row = this.db
      .prepare(
        `SELECT f.path, t.start_ms, t.end_ms FROM media_tracks t
         JOIN media_files f ON f.media_id = t.media_id AND f.rendition = 'audio'
         WHERE t.derived_media_id = ?`,
      )
      .get(mediaId);
    if (!row) return null;
    return {
      sourcePath: String(row['path']),
      startMs: Number(row['start_ms']),
      endMs: Number(row['end_ms']),
    };
  }

  recordCut(
    cut: RecordedCut,
    detailsFor: (parentId: string) => DetailsOf,
  ): { readonly replaced: readonly string[] } | null {
    return inTransaction(this.db, () => {
      const closed = closeLease(this.db, cut.owner, {
        status: 'done',
        error: null,
        at: cut.now.toISOString(),
      });
      if (!closed) return null;
      const row = this.db
        .prepare(
          `UPDATE media_tracks SET cut_status = 'cut', cut_path = ?, cut_bytes = ?,
             cut_duration_ms = ?
           WHERE derived_media_id = ? RETURNING media_id`,
        )
        .get(cut.path, cut.bytes, cut.durationMs, cut.mediaId);
      if (!row) return null;
      const parentId = String(row['media_id']);
      if (this.hasPendingCuts(parentId)) return { replaced: [] };
      const replaced = this.publish({
        parentId,
        detailsOf: detailsFor(parentId),
        now: cut.now,
      });
      return { replaced };
    });
  }

  publish(input: {
    parentId: string;
    detailsOf: DetailsOf;
    now: Date;
  }): readonly string[] {
    return inTransaction(this.db, () => {
      const replaced: string[] = [];
      for (const track of this.tracksOf(input.parentId))
        replaced.push(...this.publishTrack(track, input));
      this.archiveLeft(input.parentId, input.now.toISOString());
      return replaced;
    });
  }

  private publishTrack(
    track: TrackItemRow,
    input: { parentId: string; detailsOf: DetailsOf; now: Date },
  ): readonly string[] {
    const at = input.now.toISOString();
    const replaced = track.cut
      ? this.swapFile(track, { parentId: input.parentId, at })
      : [];
    const details = input.detailsOf(track);
    this.writeDetails(track, details, at);
    if (track.cut && details.transcript)
      this.transcripts.replaceDerived(details.transcript, input.now);
    return replaced;
  }

  /** The candidate becomes the file, the old one goes after the commit; listeners follow. */
  private swapFile(
    track: TrackItemRow,
    input: { parentId: string; at: string },
  ): readonly string[] {
    const row = this.db
      .prepare(
        `SELECT t.cut_path, t.cut_bytes, t.cut_duration_ms, m.status, m.parent_start_ms,
           f.path AS old_path
         FROM media_tracks t JOIN media m ON m.id = t.derived_media_id
         LEFT JOIN media_files f ON f.media_id = m.id AND f.rendition = 'audio'
         WHERE t.id = ?`,
      )
      .get(track.trackId);
    if (!row) throw new Error(`track ${track.trackId} has no candidate`);
    const durationMs = Number(row['cut_duration_ms']);
    const bytes = Number(row['cut_bytes']);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO media_files (media_id, rendition, path, bytes, mime)
         VALUES (?, 'audio', ?, ?, 'audio/mp4')`,
      )
      .run(track.mediaId, String(row['cut_path']), bytes);
    this.db
      .prepare(
        `UPDATE media SET status = 'ready', progress = NULL, duration_ms = ?, bytes = ?,
           parent_start_ms = ?, parent_end_ms = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        durationMs,
        bytes,
        track.realStartMs,
        track.realEndMs,
        input.at,
        track.mediaId,
      );
    if (row['status'] === 'ready')
      this.remap({
        mediaId: track.mediaId,
        parentId: input.parentId,
        oldStartMs: Number(row['parent_start_ms']),
        newStartMs: track.realStartMs,
        durationMs,
        at: input.at,
      });
    const oldPath = nullableText(row['old_path']);
    return oldPath !== null && oldPath !== row['cut_path'] ? [oldPath] : [];
  }

  /** KBC-073 BR-4: through the absolute time. Past the end is heard; before the start is 0. */
  private remap(move: Remap): void {
    const delta = move.oldStartMs - move.newStartMs;
    if (delta === 0) {
      this.endPastTheEnd(move);
      return;
    }
    this.db
      .prepare(
        `UPDATE media_progress SET
           completed_at = CASE WHEN position_ms + ? >= ? THEN coalesce(completed_at, ?)
             ELSE completed_at END,
           position_ms = CASE WHEN position_ms + ? >= ? OR position_ms + ? < 0 THEN 0
             ELSE position_ms + ? END
         WHERE media_id = ? AND position_ms > 0`,
      )
      .run(
        delta,
        move.durationMs,
        move.at,
        delta,
        move.durationMs,
        delta,
        delta,
        move.mediaId,
      );
    this.moveBookmarks(move, delta);
  }

  private endPastTheEnd(move: Remap): void {
    this.db
      .prepare(
        `UPDATE media_progress SET completed_at = coalesce(completed_at, ?), position_ms = 0
         WHERE media_id = ? AND position_ms >= ?`,
      )
      .run(move.at, move.mediaId, move.durationMs);
    this.moveBookmarks(move, 0);
  }

  /** A bookmark outside the new bounds stays at its moment, now in the full recording. */
  private moveBookmarks(move: Remap, delta: number): void {
    this.db
      .prepare(
        `UPDATE media_bookmarks SET media_id = ?, position_ms = position_ms + ?, updated_at = ?
         WHERE media_id = ? AND (position_ms + ? < 0 OR position_ms + ? > ?)`,
      )
      .run(
        move.parentId,
        move.oldStartMs,
        move.at,
        move.mediaId,
        delta,
        delta,
        move.durationMs,
      );
    if (delta !== 0)
      this.db
        .prepare(
          `UPDATE media_bookmarks SET position_ms = position_ms + ?, updated_at = ?
           WHERE media_id = ?`,
        )
        .run(delta, move.at, move.mediaId);
  }

  private writeDetails(
    track: TrackItemRow,
    details: TrackDetails,
    at: string,
  ): void {
    this.db
      .prepare(
        `UPDATE media SET title = ?, track_ordinal = ?, author = ?, authorship = ?,
           updated_at = ? WHERE id = ?`,
      )
      .run(
        track.title,
        track.ordinal,
        details.author,
        details.legacyAuthorship,
        at,
        track.mediaId,
      );
    this.db
      .prepare(
        `UPDATE media_tracks SET cut_status = 'published', cut_path = NULL, cut_bytes = NULL,
           cut_duration_ms = NULL WHERE id = ?`,
      )
      .run(track.trackId);
  }

  /** Items with no track in the approval leave the library and search (BR-5). */
  private archiveLeft(parentId: string, at: string): void {
    const left = `SELECT id FROM media WHERE parent_media_id = ? AND archived_at IS NULL
      AND id NOT IN (SELECT derived_media_id FROM media_tracks
        WHERE media_id = ? AND derived_media_id IS NOT NULL)`;
    this.db
      .prepare(
        `DELETE FROM segments_fts WHERE rowid IN (
           SELECT s.rowid FROM segments s JOIN transcripts t ON t.id = s.transcript_id
           WHERE t.media_id IN (${left}))`,
      )
      .run(parentId, parentId);
    this.db
      .prepare(
        `UPDATE media SET archived_at = ?, track_ordinal = NULL, updated_at = ?
         WHERE id IN (${left})`,
      )
      .run(at, at, parentId, parentId);
  }

  tracksOf(parentId: string): readonly TrackItemRow[] {
    return this.db
      .prepare(`${TRACK_ROW} WHERE t.media_id = ? ORDER BY t.ordinal`)
      .all(parentId)
      .map(toTrackRow);
  }

  setAuthor(input: Parameters<TrackItemStorePort['setAuthor']>[0]): void {
    this.db
      .prepare(
        `UPDATE media SET author = ?, authorship = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        input.author,
        input.legacyAuthorship,
        input.now.toISOString(),
        input.mediaId,
      );
  }

  preparation(parentId: string): TrackPreparation | null {
    const row = this.db
      .prepare(
        `SELECT count(*) AS total,
           sum(t.cut_status IN ('cut', 'published')) AS done,
           sum(t.cut_status = 'pending' AND EXISTS (SELECT 1 FROM jobs j
             WHERE j.media_id = t.derived_media_id AND j.kind = 'cut'
               AND j.status IN ('failed', 'dead'))) AS failed
         FROM media_tracks t WHERE t.media_id = ? AND t.cut_status <> 'none'`,
      )
      .get(parentId);
    const total = Number(row?.['total'] ?? 0);
    const done = Number(row?.['done'] ?? 0);
    if (total === 0 || done === total) return null;
    return { total, done, failed: Number(row?.['failed'] ?? 0) };
  }

  retryCuts(parentId: string, now: Date): number {
    return this.db
      .prepare(
        `UPDATE jobs SET status = 'queued', attempts = 0, error = NULL, updated_at = ?
         WHERE kind = 'cut' AND status IN ('failed', 'dead') AND media_id IN
           (SELECT derived_media_id FROM media_tracks
            WHERE media_id = ? AND cut_status = 'pending')`,
      )
      .run(now.toISOString(), parentId).changes as number;
  }

  filesOf(parentId: string): readonly string[] {
    return this.db
      .prepare(
        `SELECT f.path FROM media_files f JOIN media m ON m.id = f.media_id
           WHERE m.parent_media_id = ?
         UNION SELECT cut_path FROM media_tracks
           WHERE media_id = ? AND cut_path IS NOT NULL`,
      )
      .all(parentId, parentId)
      .map((row) => String(row['path']));
  }

  liveTitles(parentId: string): readonly string[] {
    return this.db
      .prepare(
        `SELECT title FROM media
         WHERE parent_media_id = ? AND status = 'ready' AND archived_at IS NULL
         ORDER BY track_ordinal`,
      )
      .all(parentId)
      .map((row) => String(row['title']));
  }
}
