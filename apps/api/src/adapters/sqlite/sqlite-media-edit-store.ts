import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  TRACK_SUMMARY_MAX,
  TRACK_TITLE_MAX,
  editStatusSchema,
  editStepSchema,
  inTimeOrder,
  trackKindSchema,
  type ApprovedTrack,
  type EditStep,
  type EditTrack,
} from '@kb-chat/contracts';
import type {
  EditWrite,
  MediaEditRecord,
  MediaEditStorePort,
} from '../../ports/media-edit-store.js';
import { inTransaction } from './media-database.js';

type Row = Record<string, SQLOutputValue>;

/** The fields of a draft row a person can change. */
const sameTrack = (row: Row, track: EditTrack): boolean =>
  row['start_ms'] === track.startMs &&
  row['end_ms'] === track.endMs &&
  row['kind'] === track.kind &&
  row['title'] === track.title &&
  row['asker_voice'] === track.askerVoice &&
  row['answerer_voice'] === track.answererVoice &&
  row['asker_speaker_id'] === track.askerSpeakerId &&
  row['answerer_speaker_id'] === track.answererSpeakerId &&
  row['level'] === track.level;

const toApproved = (row: Row): ApprovedTrack => ({
  id: String(row['id']),
  ordinal: Number(row['ordinal']),
  startMs: Number(row['start_ms']),
  endMs: Number(row['end_ms']),
  kind: trackKindSchema.parse(row['kind']),
  title: String(row['title']),
});

const trackValues = (track: EditTrack) =>
  [
    track.startMs,
    track.endMs,
    track.kind,
    track.title,
    track.askerVoice,
    track.answererVoice,
    track.askerSpeakerId,
    track.answererSpeakerId,
    track.level,
  ] as const;

/** The edits and approved tracks in `media.db` (KBC-066, migration media-edits). */
export class SqliteMediaEditStore implements MediaEditStorePort {
  constructor(private readonly db: DatabaseSync) {}

  edit(mediaId: string): MediaEditRecord | null {
    const row = this.db
      .prepare('SELECT * FROM media_edits WHERE media_id = ?')
      .get(mediaId);
    if (!row) return null;
    const version = row['transcript_version'];
    return {
      mediaId,
      version: Number(row['version']),
      status: editStatusSchema.parse(row['status']),
      step: editStepSchema.parse(Number(row['step'])),
      transcriptVersion: version === null ? null : Number(version),
    };
  }

  save(
    write: EditWrite & {
      tracks: readonly EditTrack[];
      shownIds: readonly string[];
      step: EditStep;
      transcriptVersion: number | null;
    },
  ): number | null {
    return inTransaction(this.db, () => {
      const current = this.edit(write.mediaId);
      if ((current?.version ?? 0) !== write.expectedVersion) return null;
      this.replaceDraft(write);
      this.writeEdit({ ...write, version: write.expectedVersion + 1 });
      return write.expectedVersion + 1;
    });
  }

  private writeEdit(
    input: EditWrite & {
      version: number;
      step: EditStep;
      transcriptVersion: number | null;
    },
  ): void {
    this.db
      .prepare(
        `INSERT INTO media_edits (media_id, version, status, step, transcript_version,
           updated_by, updated_at)
         VALUES (?, ?, 'draft', ?, ?, ?, ?)
         ON CONFLICT (media_id) DO UPDATE SET version = excluded.version,
           step = excluded.step, updated_by = excluded.updated_by,
           updated_at = excluded.updated_at,
           transcript_version = coalesce(media_edits.transcript_version,
             excluded.transcript_version)`,
      )
      .run(
        input.mediaId,
        input.version,
        input.step,
        input.transcriptVersion,
        input.principal,
        input.now.toISOString(),
      );
  }

  /** Only what changed is written: an untouched proposal stays one. */
  private replaceDraft(input: {
    mediaId: string;
    tracks: readonly EditTrack[];
    shownIds: readonly string[];
    now: Date;
  }): void {
    const { mediaId, tracks, shownIds, now } = input;
    const rows = new Map(
      this.draftRows(mediaId).map((row) => [String(row['id']), row]),
    );
    const kept = new Set(tracks.map((track) => track.id));
    for (const id of shownIds)
      if (!kept.has(id))
        this.db
          .prepare(
            'DELETE FROM media_draft_tracks WHERE id = ? AND media_id = ?',
          )
          .run(id, mediaId);
    for (const track of tracks) {
      const row = rows.get(track.id);
      if (!row) this.insertDraft({ mediaId, track, now });
      else if (!sameTrack(row, track)) this.updateDraft(mediaId, track);
    }
  }

  foreignIds(mediaId: string, ids: readonly string[]): string[] {
    const list = JSON.stringify(ids);
    return this.db
      .prepare(
        `SELECT id FROM media_draft_tracks
           WHERE media_id <> ? AND id IN (SELECT value FROM json_each(?))
         UNION SELECT id FROM media_tracks
           WHERE media_id <> ? AND id IN (SELECT value FROM json_each(?))`,
      )
      .all(mediaId, list, mediaId, list)
      .map((row) => String(row['id']));
  }

  private draftRows(mediaId: string): Row[] {
    return this.db
      .prepare('SELECT * FROM media_draft_tracks WHERE media_id = ?')
      .all(mediaId);
  }

  private insertDraft(input: {
    mediaId: string;
    track: EditTrack;
    now: Date;
  }): void {
    const { track } = input;
    this.db
      .prepare(
        `INSERT INTO media_draft_tracks (start_ms, end_ms, kind, title, asker_voice,
           answerer_voice, asker_speaker_id, answerer_speaker_id, level, id, media_id, source,
           edited, person_edited, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ...trackValues(track),
        track.id,
        input.mediaId,
        track.source,
        // A proposal coming back with "Desfazer" is a person's choice now (BR-6).
        track.source === 'ai' ? 1 : 0,
        track.source === 'ai' ? 1 : 0,
        input.now.toISOString(),
      );
  }

  private updateDraft(mediaId: string, track: EditTrack): void {
    this.db
      .prepare(
        `UPDATE media_draft_tracks SET start_ms = ?, end_ms = ?, kind = ?, title = ?,
           asker_voice = ?, answerer_voice = ?, asker_speaker_id = ?, answerer_speaker_id = ?,
           level = ?, edited = 1, person_edited = CASE WHEN title IS ? THEN person_edited ELSE 1 END
         WHERE id = ? AND media_id = ?`,
      )
      .run(...trackValues(track), track.title, track.id, mediaId);
  }

  approve(
    write: EditWrite & {
      trackIds: readonly string[];
      transcriptVersion: number | null;
      alongside?: () => void;
    },
  ): number | null {
    return inTransaction(this.db, () => {
      const current = this.edit(write.mediaId);
      if (!current || current.version !== write.expectedVersion) return null;
      this.forgetDroppedWindows(write.mediaId, write.trackIds);
      this.keepOnly(write.mediaId, write.trackIds);
      this.replaceApproved(write);
      write.alongside?.();
      // Approved proposals are no longer proposals (KBC-067 AC-11): a new run keeps them.
      this.db
        .prepare('UPDATE media_draft_tracks SET edited = 1 WHERE media_id = ?')
        .run(write.mediaId);
      return this.markApproved(write);
    });
  }

  private markApproved(
    write: EditWrite & { transcriptVersion: number | null },
  ): number {
    const next = write.expectedVersion + 1;
    this.db
      .prepare(
        `UPDATE media_edits SET version = ?, status = 'approved', step = 4,
           transcript_version = ?, updated_by = ?, updated_at = ? WHERE media_id = ?`,
      )
      .run(
        next,
        write.transcriptVersion,
        write.principal,
        write.now.toISOString(),
        write.mediaId,
      );
    return next;
  }

  /** A failed run whose tracks an approval drops has no windows left to go on from. */
  private forgetDroppedWindows(
    mediaId: string,
    trackIds: readonly string[],
  ): void {
    this.db
      .prepare(
        `UPDATE media_proposal_runs SET windows_done = 0
         WHERE media_id = ? AND status = 'failed' AND id IN (
           SELECT run_id FROM media_draft_tracks WHERE media_id = ?
             AND id NOT IN (SELECT value FROM json_each(?)))`,
      )
      .run(mediaId, mediaId, JSON.stringify(trackIds));
  }

  private keepOnly(mediaId: string, trackIds: readonly string[]): void {
    this.db
      .prepare(
        `DELETE FROM media_draft_tracks WHERE media_id = ?
           AND id NOT IN (SELECT value FROM json_each(?))`,
      )
      .run(mediaId, JSON.stringify(trackIds));
  }

  private replaceApproved(write: EditWrite): void {
    const { mediaId } = write;
    this.db.prepare('DELETE FROM media_tracks WHERE media_id = ?').run(mediaId);
    const insert = this.db.prepare(
      `INSERT INTO media_tracks (id, media_id, ordinal, start_ms, end_ms, kind, title, source,
         asker_voice, answerer_voice, asker_speaker_id, answerer_speaker_id, approved_by,
         approved_at)
       SELECT id, media_id, ?, start_ms, end_ms, kind, title, source, asker_voice,
         answerer_voice, asker_speaker_id, answerer_speaker_id, ?, ?
       FROM media_draft_tracks WHERE id = ?`,
    );
    const ordered = inTimeOrder(
      this.draftRows(mediaId).map((row) => ({
        id: String(row['id']),
        startMs: Number(row['start_ms']),
      })),
    );
    ordered.forEach(({ id }, index) =>
      insert.run(index + 1, write.principal, write.now.toISOString(), id),
    );
  }

  reopen(write: EditWrite & { alongside?: () => void }): number | null {
    return inTransaction(this.db, () => {
      const current = this.edit(write.mediaId);
      if (!current || current.version !== write.expectedVersion) return null;
      write.alongside?.();
      const next = write.expectedVersion + 1;
      this.db
        .prepare(
          `UPDATE media_edits SET version = ?, status = 'draft', step = 3, updated_by = ?,
             updated_at = ? WHERE media_id = ?`,
        )
        .run(next, write.principal, write.now.toISOString(), write.mediaId);
      return next;
    });
  }

  proposedTrackIds(mediaId: string): ReadonlySet<string> {
    return new Set(this.proposedRows(mediaId).map((row) => String(row['id'])));
  }

  /** What the AI wrote and no person touched. */
  private proposedRows(mediaId: string): Row[] {
    return this.db
      .prepare(
        `SELECT id, title FROM media_draft_tracks
         WHERE media_id = ? AND source = 'ai' AND person_edited = 0
           AND title IS NOT NULL`,
      )
      .all(mediaId);
  }

  rewriteProposedDraft(
    input: Parameters<MediaEditStorePort['rewriteProposedDraft']>[0],
  ): void {
    const { mediaId, rewrite, now } = input;
    inTransaction(this.db, () => {
      const changed = this.proposedRows(mediaId).flatMap((row) => {
        const title = String(row['title']);
        const next = rewrite(title, TRACK_TITLE_MAX);
        return next === title ? [] : [{ id: String(row['id']), next }];
      });
      for (const { id, next } of changed)
        this.db
          .prepare('UPDATE media_draft_tracks SET title = ? WHERE id = ?')
          .run(next, id);
      if (changed.length === 0) return;
      // A screen still holding the old words cannot save them back.
      this.db
        .prepare(
          `UPDATE media_edits SET version = version + 1, updated_at = ?
           WHERE media_id = ?`,
        )
        .run(now.toISOString(), mediaId);
    });
  }

  /** A summary waiting for a person is the AI's alone; one in force passed through a person. */
  rewriteSuggestedSummaries(
    mediaId: string,
    rewrite: (text: string, max: number) => string,
  ): void {
    const rows = this.db
      .prepare(
        `SELECT s.media_id, s.suggested_summary FROM media_track_subjects s
         JOIN media m ON m.id = s.media_id
         WHERE m.parent_media_id = ? AND s.suggested_summary IS NOT NULL`,
      )
      .all(mediaId);
    for (const row of rows) {
      const text = String(row['suggested_summary']);
      const next = rewrite(text, TRACK_SUMMARY_MAX);
      if (next !== text)
        this.db
          .prepare(
            `UPDATE media_track_subjects SET suggested_summary = ?
             WHERE media_id = ?`,
          )
          .run(next, String(row['media_id']));
    }
  }

  approvedLevels(mediaId: string): ReadonlyMap<string, string | null> {
    const rows = this.db
      .prepare(
        `SELECT t.id, d.level FROM media_tracks t JOIN media d ON d.id = t.derived_media_id
         WHERE t.media_id = ?`,
      )
      .all(mediaId);
    return new Map(
      rows.map((row) => [
        String(row['id']),
        row['level'] === null ? null : String(row['level']),
      ]),
    );
  }

  approved(mediaId: string): ApprovedTrack[] {
    return this.db
      .prepare('SELECT * FROM media_tracks WHERE media_id = ? ORDER BY ordinal')
      .all(mediaId)
      .map(toApproved);
  }
}
