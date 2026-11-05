import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  draftTrackSourceSchema,
  proposalFailureSchema,
  proposalStatusSchema,
  trackKindSchema,
  type DraftTrack,
  type DraftTracks,
  type ProposalFailure,
  type ProposalRun,
  type VoiceSuggestion,
} from '@kb-chat/contracts';
import type {
  FailedAttempt,
  InterruptedRun,
  KeptRange,
  NewProposalRun,
  ProposedTrack,
  TrackExtension,
  TrackProposalStorePort,
} from '../../ports/track-proposal-store.js';
import { inTransaction } from './media-database.js';

type Row = Record<string, SQLOutputValue>;

const text = (row: Row, column: string): string => String(row[column]);
const textOrNull = (row: Row, column: string): string | null =>
  row[column] === null ? null : String(row[column]);
const numberOrNull = (row: Row, column: string): number | null =>
  row[column] === null ? null : Number(row[column]);

const RUN_COLUMNS = `r.id, r.media_id, r.status, r.model, r.windows_total, r.windows_done,
  r.estimate_usd, r.spent_usd, r.failure, r.created_at, r.finished_at,
  (SELECT count(*) FROM media_draft_tracks t WHERE t.run_id = r.id) AS tracks`;

function toRun(row: Row): ProposalRun {
  const failure = textOrNull(row, 'failure');
  return {
    id: text(row, 'id'),
    mediaId: text(row, 'media_id'),
    status: proposalStatusSchema.parse(row['status']),
    model: text(row, 'model'),
    windowsTotal: Number(row['windows_total']),
    windowsDone: Number(row['windows_done']),
    tracks: Number(row['tracks']),
    estimateUsd: Number(row['estimate_usd']),
    spentUsd: Number(row['spent_usd']),
    failure: failure === null ? null : proposalFailureSchema.parse(failure),
    createdAt: text(row, 'created_at'),
    finishedAt: textOrNull(row, 'finished_at'),
  };
}

function toTrack(row: Row): DraftTrack {
  return {
    id: text(row, 'id'),
    runId: textOrNull(row, 'run_id'),
    source: draftTrackSourceSchema.parse(row['source']),
    edited: row['edited'] === 1,
    firstSegment: numberOrNull(row, 'first_segment'),
    lastSegment: numberOrNull(row, 'last_segment'),
    startMs: Number(row['start_ms']),
    endMs: Number(row['end_ms']),
    kind: trackKindSchema.parse(row['kind']),
    title: textOrNull(row, 'title'),
    askerVoice: numberOrNull(row, 'asker_voice'),
    answererVoice: numberOrNull(row, 'answerer_voice'),
    askerSpeakerId: textOrNull(row, 'asker_speaker_id'),
    answererSpeakerId: textOrNull(row, 'answerer_speaker_id'),
  };
}

const toVoice = (row: Row): VoiceSuggestion => ({
  voice: Number(row['voice']),
  name: textOrNull(row, 'name'),
  audience: row['audience'] === 1,
  reason: text(row, 'reason'),
});

/** A person's tracks and the ones a person changed: no run replaces them (BR-6). */
const KEPT = `(source = 'manual' OR edited = 1)`;

/** The run a draft shows: the newest that did not fail, else the newest that wrote windows. */
const SHOWN_RUN = `r.media_id = ? AND r.id <> ? AND (r.status <> 'failed' OR r.windows_done > 0)
  ORDER BY r.status <> 'failed' DESC, r.created_at DESC, r.rowid DESC LIMIT 1`;

/** The AI's proposal runs and draft tracks in `media.db` (KBC-067, ADR 0029 §4). */
export class SqliteTrackProposalStore implements TrackProposalStorePort {
  constructor(private readonly db: DatabaseSync) {}

  startRun(run: NewProposalRun): ProposalRun | null {
    const running = this.db
      .prepare(
        `SELECT 1 FROM media_proposal_runs WHERE media_id = ? AND status = 'running'`,
      )
      .get(run.mediaId);
    if (running) return null;
    inTransaction(this.db, () => {
      this.insertRun(run);
      if (run.resumes) this.carryOutput(run.resumes.runId, run.id);
    });
    return this.getRun(run.id);
  }

  private insertRun(run: NewProposalRun): void {
    this.db
      .prepare(
        `INSERT INTO media_proposal_runs (id, media_id, transcript_id, principal, model,
           spend_id, status, windows_total, windows_done, estimate_usd, spent_usd, carried_usd,
           created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.mediaId,
        run.transcriptId,
        run.principal,
        run.model,
        run.spendId,
        run.windowsTotal,
        run.resumes?.windowsDone ?? 0,
        run.estimateUsd,
        run.carriedUsd,
        run.carriedUsd,
        run.now.toISOString(),
      );
  }

  /** The failed run's tracks and names become the new run's: nothing leaves the draft. */
  private carryOutput(fromRunId: string, toRunId: string): void {
    for (const table of ['media_draft_tracks', 'media_voice_suggestions'])
      this.db
        .prepare(`UPDATE ${table} SET run_id = ? WHERE run_id = ?`)
        .run(toRunId, fromRunId);
  }

  getRun(runId: string): ProposalRun | null {
    const row = this.db
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM media_proposal_runs r WHERE r.id = ?`,
      )
      .get(runId);
    return row ? toRun(row) : null;
  }

  newestRun(mediaId: string): ProposalRun | null {
    const row = this.db
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM media_proposal_runs r WHERE r.media_id = ?
         ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`,
      )
      .get(mediaId);
    return row ? toRun(row) : null;
  }

  failedAttempt(mediaId: string, transcriptId: string): FailedAttempt | null {
    const row = this.db
      .prepare(
        `SELECT r.id, r.status, r.transcript_id, r.windows_done, r.windows_total, r.spent_usd
         FROM media_proposal_runs r WHERE r.media_id = ?
         ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`,
      )
      .get(mediaId);
    if (row?.['status'] !== 'failed' || row['transcript_id'] !== transcriptId)
      return null;
    return {
      runId: text(row, 'id'),
      windowsDone: Number(row['windows_done']),
      windowsTotal: Number(row['windows_total']),
      spentUsd: Number(row['spent_usd']),
      outputGone: this.outputGone(mediaId, text(row, 'id')),
    };
  }

  /**
   * A save writes what is on screen, so it takes the tracks of a failed run out of sight. Going
   * on from there would replace the proposal on screen with nothing for those windows.
   */
  private outputGone(mediaId: string, runId: string): boolean {
    const shown = this.shownRun(mediaId);
    if (shown === null || shown.id === runId) return false;
    const count = (sql: string, id: string) =>
      Number(this.db.prepare(sql).get(id)?.['n']);
    const written = count(
      'SELECT count(*) AS n FROM media_draft_tracks WHERE run_id = ?',
      runId,
    );
    const untouched = count(
      `SELECT count(*) AS n FROM media_draft_tracks
       WHERE run_id = ? AND source = 'ai' AND edited = 0`,
      shown.id,
    );
    return written === 0 && untouched > 0;
  }

  private shownRun(mediaId: string, except = ''): ProposalRun | null {
    const row = this.db
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM media_proposal_runs r WHERE ${SHOWN_RUN}`,
      )
      .get(mediaId, except);
    return row ? toRun(row) : null;
  }

  runTracks(runId: string): DraftTrack[] {
    return this.db
      .prepare(
        'SELECT * FROM media_draft_tracks WHERE run_id = ? ORDER BY start_ms',
      )
      .all(runId)
      .map(toTrack);
  }

  saveWindow(input: {
    runId: string;
    extendLast: TrackExtension | null;
    tracks: readonly ProposedTrack[];
    voices: readonly VoiceSuggestion[];
    spentUsd: number;
  }): void {
    inTransaction(this.db, () => {
      if (input.extendLast) this.extendLast(input.runId, input.extendLast);
      const mediaId = this.mediaOf(input.runId);
      for (const track of input.tracks)
        this.insertTrack({ runId: input.runId, mediaId, track });
      for (const voice of input.voices) this.upsertVoice(input.runId, voice);
      this.bumpEdit(mediaId, input.runId);
      this.db
        .prepare(
          `UPDATE media_proposal_runs SET windows_done = windows_done + 1,
             spent_usd = carried_usd + ? WHERE id = ?`,
        )
        .run(input.spentUsd, input.runId);
      // The reservation shows what was really spent so far (the month counts the larger).
      this.db
        .prepare(
          `UPDATE media_spend SET spent_usd = ? WHERE status = 'reserved'
             AND id = (SELECT spend_id FROM media_proposal_runs WHERE id = ?)`,
        )
        .run(input.spentUsd, input.runId);
    });
  }

  finishRun(input: {
    runId: string;
    spendId: string;
    failure: ProposalFailure | null;
    spentUsd: number;
    now: Date;
  }): void {
    inTransaction(this.db, () => {
      this.closeRun(input);
      this.closeSpend(input);
    });
  }

  /** The run's row and draft; nothing when the recording (and its run) was deleted. */
  private closeRun(input: {
    runId: string;
    failure: ProposalFailure | null;
    spentUsd: number;
    now: Date;
  }): void {
    const mediaId = this.mediaOrNull(input.runId);
    if (mediaId === null) return;
    const before = this.shownRun(mediaId, input.runId);
    this.db
      .prepare(
        `UPDATE media_proposal_runs SET status = ?, failure = ?,
           spent_usd = carried_usd + ?, finished_at = ? WHERE id = ?`,
      )
      .run(
        input.failure === null ? 'done' : 'failed',
        input.failure,
        input.spentUsd,
        input.now.toISOString(),
        input.runId,
      );
    if (before && this.shownRun(mediaId)?.id === input.runId)
      this.keepUnreplaced(before.id, input.runId);
    if (input.failure === null) this.dropOlderProposals(mediaId, input.runId);
    this.bumpEdit(mediaId, input.runId);
  }

  /** What was on screen goes only for something in its place: the rest joins the new run. */
  private keepUnreplaced(fromRunId: string, toRunId: string): void {
    this.db
      .prepare(
        `UPDATE media_draft_tracks SET run_id = ?
         WHERE run_id = ? AND source = 'ai' AND edited = 0 AND NOT EXISTS (
           SELECT 1 FROM media_draft_tracks other
           WHERE other.media_id = media_draft_tracks.media_id
             AND other.id <> media_draft_tracks.id
             AND (other.run_id = ? OR other.source = 'manual' OR other.edited = 1)
             AND other.start_ms < media_draft_tracks.end_ms
             AND other.end_ms > media_draft_tracks.start_ms)`,
      )
      .run(toRunId, fromRunId, toRunId);
  }

  /** Done counts what was spent; failed gives back the rest of the reservation (FR-5). */
  private closeSpend(input: {
    spendId: string;
    failure: ProposalFailure | null;
    spentUsd: number;
    now: Date;
  }): void {
    this.db
      .prepare(
        `UPDATE media_spend SET status = ?, spent_usd = ?, settled_at = ?
         WHERE id = ? AND status = 'reserved'`,
      )
      .run(
        input.failure === null ? 'settled' : 'refunded',
        input.spentUsd,
        input.now.toISOString(),
        input.spendId,
      );
  }

  keptRanges(mediaId: string): KeptRange[] {
    return this.db
      .prepare(
        `SELECT start_ms, end_ms FROM media_draft_tracks WHERE media_id = ? AND ${KEPT}
         ORDER BY start_ms`,
      )
      .all(mediaId)
      .map((row) => ({
        startMs: Number(row['start_ms']),
        endMs: Number(row['end_ms']),
      }));
  }

  draft(mediaId: string): DraftTracks {
    const run = this.shownRun(mediaId);
    const tracks = this.db
      .prepare(
        `SELECT * FROM media_draft_tracks
         WHERE media_id = ? AND (${KEPT} OR run_id = ?) ORDER BY start_ms`,
      )
      .all(mediaId, run?.id ?? null)
      .map(toTrack);
    const voices = this.db
      .prepare(
        'SELECT * FROM media_voice_suggestions WHERE run_id = ? ORDER BY voice',
      )
      .all(run?.id ?? null)
      .map(toVoice);
    return { run, lastFailure: this.lastFailure(mediaId), tracks, voices };
  }

  /** The newest run, failed or not, decides: a later one clears the failure (FR-5). */
  private lastFailure(mediaId: string): ProposalFailure | null {
    const row = this.db
      .prepare(
        `SELECT r.status, r.failure FROM media_proposal_runs r WHERE r.media_id = ?
         ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`,
      )
      .get(mediaId);
    return row?.['status'] === 'failed'
      ? proposalFailureSchema.parse(row['failure'])
      : null;
  }

  isApproved(mediaId: string): boolean {
    const row = this.db
      .prepare('SELECT status FROM media_edits WHERE media_id = ?')
      .get(mediaId);
    return row?.['status'] === 'approved';
  }

  interruptRunning(now: Date): InterruptedRun[] {
    const rows = this.db
      .prepare(
        `SELECT id, spend_id, spent_usd - carried_usd AS own_usd, windows_done, windows_total
         FROM media_proposal_runs WHERE status = 'running'`,
      )
      .all();
    return rows.map((row) => {
      const run = {
        runId: text(row, 'id'),
        spendId: text(row, 'spend_id'),
        spentUsd: Math.max(0, Number(row['own_usd'])),
      };
      const finished =
        Number(row['windows_done']) >= Number(row['windows_total']);
      this.finishRun({ ...run, failure: finished ? null : 'interrupted', now });
      return run;
    });
  }

  /**
   * A proposal changed the draft: a person's older read must not overwrite it (KBC-066). A
   * draft born here is based on the transcript the run read (BR-10).
   */
  private bumpEdit(mediaId: string, runId: string): void {
    this.db
      .prepare(
        `INSERT INTO media_edits (media_id, version, status, step, transcript_version,
           updated_at)
         VALUES (?, 1, 'draft', 3, (
           SELECT t.version FROM transcripts t
           JOIN media_proposal_runs r ON r.transcript_id = t.id WHERE r.id = ?), ?)
         ON CONFLICT (media_id) DO UPDATE SET version = version + 1,
           transcript_version = coalesce(media_edits.transcript_version,
             excluded.transcript_version)`,
      )
      .run(mediaId, runId, new Date().toISOString());
  }

  private mediaOf(runId: string): string {
    const mediaId = this.mediaOrNull(runId);
    if (mediaId === null) throw new Error(`Unknown proposal run ${runId}`);
    return mediaId;
  }

  private mediaOrNull(runId: string): string | null {
    const row = this.db
      .prepare('SELECT media_id FROM media_proposal_runs WHERE id = ?')
      .get(runId);
    return row ? text(row, 'media_id') : null;
  }

  private extendLast(runId: string, extension: TrackExtension): void {
    this.db
      .prepare(
        `UPDATE media_draft_tracks SET last_segment = ?, end_ms = ?
         WHERE id = (SELECT id FROM media_draft_tracks WHERE run_id = ?
                     ORDER BY start_ms DESC LIMIT 1)`,
      )
      .run(extension.lastSegment, extension.endMs, runId);
  }

  private insertTrack(input: {
    runId: string;
    mediaId: string;
    track: ProposedTrack;
  }): void {
    const { track } = input;
    this.db
      .prepare(
        `INSERT INTO media_draft_tracks (id, media_id, run_id, source, first_segment,
           last_segment, start_ms, end_ms, kind, title, asker_voice, answerer_voice, created_at)
         VALUES (?, ?, ?, 'ai', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.mediaId,
        input.runId,
        track.firstSegment,
        track.lastSegment,
        track.startMs,
        track.endMs,
        track.kind,
        track.title,
        track.askerVoice,
        track.answererVoice,
        new Date().toISOString(),
      );
  }

  /**
   * A later window may name a voice an earlier one left unnamed; a name is never undone and
   * a voice once marked as the audience is never named (BR-5).
   */
  private upsertVoice(runId: string, voice: VoiceSuggestion): void {
    this.db
      .prepare(
        `INSERT INTO media_voice_suggestions (run_id, voice, name, audience, reason)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (run_id, voice) DO UPDATE SET
           name = excluded.name, audience = excluded.audience, reason = excluded.reason
         WHERE media_voice_suggestions.audience = 0
           AND media_voice_suggestions.name IS NULL AND excluded.name IS NOT NULL`,
      )
      .run(
        runId,
        voice.voice,
        voice.name,
        voice.audience ? 1 : 0,
        voice.reason,
      );
  }

  private dropOlderProposals(mediaId: string, runId: string): void {
    this.db
      .prepare(
        `DELETE FROM media_draft_tracks
         WHERE media_id = ? AND source = 'ai' AND edited = 0 AND run_id <> ?`,
      )
      .run(mediaId, runId);
  }
}
