import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  preparationPlanSchema,
  stageStopSchema,
  type JobCuts,
  type TrackChoice,
} from '@kb-chat/contracts';
import type {
  MeasuredRates,
  PreparationRecord,
  PreparationStorePort,
} from '../../ports/preparation-store.js';

type Row = Record<string, SQLOutputValue>;

const textOrNull = (value: SQLOutputValue | undefined): string | null =>
  typeof value === 'string' ? value : null;

const numberOrNull = (value: SQLOutputValue | undefined): number | null =>
  typeof value === 'number' ? value : null;

function toRecord(row: Row): PreparationRecord {
  const stop = textOrNull(row['proposal_stop']);
  return {
    mediaId: String(row['media_id']),
    principal: String(row['principal']),
    plan: preparationPlanSchema.parse({
      transcribe: row['transcribe'] === 1,
      speakers: row['speakers'] === 1,
      tracks: row['tracks'],
      subjects: row['subjects'] === 1,
      acceptedUsd: numberOrNull(row['accepted_usd']),
    }),
    speakersAskedAt: textOrNull(row['speakers_asked_at']),
    proposalClaimedAt: textOrNull(row['proposal_claimed_at']),
    proposalStop: stop === null ? null : stageStopSchema.parse(stop),
    proposalStopUsd: numberOrNull(row['proposal_stop_usd']),
    validatingAt: textOrNull(row['validating_at']),
    finishedAt: textOrNull(row['finished_at']),
    createdAt: String(row['created_at']),
  };
}

const ratio = (row: Row | undefined): number | null => {
  const elapsed = numberOrNull(row?.['elapsed']);
  const audio = numberOrNull(row?.['audio']);
  return elapsed !== null && audio !== null && audio > 0
    ? elapsed / audio
    : null;
};

/** The plans in `media.db` (KBC-072, migration media-preparations). */
export class SqlitePreparationStore implements PreparationStorePort {
  constructor(private readonly db: DatabaseSync) {}

  get(mediaId: string): PreparationRecord | null {
    const row = this.db
      .prepare('SELECT * FROM media_preparations WHERE media_id = ?')
      .get(mediaId);
    return row ? toRecord(row) : null;
  }

  listOpen(): PreparationRecord[] {
    return this.db
      .prepare('SELECT * FROM media_preparations WHERE finished_at IS NULL')
      .all()
      .map(toRecord);
  }

  save(input: Parameters<PreparationStorePort['save']>[0]): void {
    const { plan } = input;
    const at = input.now.toISOString();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO media_preparations (media_id, principal, transcribe, speakers,
           tracks, subjects, accepted_usd, finished_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.mediaId,
        input.principal,
        plan.transcribe ? 1 : 0,
        plan.speakers ? 1 : 0,
        plan.tracks,
        plan.subjects ? 1 : 0,
        plan.acceptedUsd,
        input.finished ? at : null,
        at,
        at,
      );
  }

  private claim(
    column: 'speakers_asked_at' | 'proposal_claimed_at',
    mediaId: string,
    now: Date,
  ): boolean {
    const at = now.toISOString();
    return (
      this.db
        .prepare(
          `UPDATE media_preparations SET ${column} = ?, updated_at = ?
           WHERE media_id = ? AND ${column} IS NULL`,
        )
        .run(at, at, mediaId).changes === 1
    );
  }

  claimSpeakers(mediaId: string, now: Date): boolean {
    return this.claim('speakers_asked_at', mediaId, now);
  }

  claimProposal(mediaId: string, now: Date): boolean {
    return this.claim('proposal_claimed_at', mediaId, now);
  }

  stopProposal(
    input: Parameters<PreparationStorePort['stopProposal']>[0],
  ): void {
    this.db
      .prepare(
        `UPDATE media_preparations SET proposal_stop = ?, proposal_stop_usd = ?, updated_at = ?
         WHERE media_id = ?`,
      )
      .run(input.stop, input.usd, input.now.toISOString(), input.mediaId);
  }

  reclaimProposal(mediaId: string, at: Date): void {
    const moment = at.toISOString();
    this.db
      .prepare(
        `UPDATE media_preparations SET proposal_claimed_at = ?, proposal_stop = NULL,
           proposal_stop_usd = NULL, updated_at = ? WHERE media_id = ?`,
      )
      .run(moment, moment, mediaId);
  }

  chooseTracks(mediaId: string, tracks: TrackChoice, now: Date): void {
    this.db
      .prepare(
        `UPDATE media_preparations SET tracks = ?, proposal_stop = NULL,
           proposal_stop_usd = NULL, updated_at = ? WHERE media_id = ?`,
      )
      .run(tracks, now.toISOString(), mediaId);
  }

  startValidating(mediaId: string, now: Date): void {
    const at = now.toISOString();
    this.db
      .prepare(
        `UPDATE media_preparations SET validating_at = coalesce(validating_at, ?),
           updated_at = ? WHERE media_id = ?`,
      )
      .run(at, at, mediaId);
  }

  finish(mediaId: string, now: Date): void {
    const at = now.toISOString();
    this.db
      .prepare(
        `UPDATE media_preparations SET finished_at = coalesce(finished_at, ?),
           updated_at = ? WHERE media_id = ?`,
      )
      .run(at, at, mediaId);
  }

  runningCuts(mediaId: string): JobCuts | null {
    const row = this.db
      .prepare(
        `SELECT c.done, c.total FROM media_transcribe_cuts c
         JOIN jobs j ON j.id = c.job_id
         WHERE c.media_id = ? AND j.status = 'leased'`,
      )
      .get(mediaId);
    return row
      ? { done: Number(row['done']), total: Number(row['total']) }
      : null;
  }

  jobsAhead(mediaId: string, kind: 'transcribe' | 'diarize'): number {
    const row = this.db
      .prepare(
        `SELECT count(*) AS ahead FROM jobs j
         WHERE j.kind = ? AND j.status IN ('queued', 'leased') AND j.media_id <> ?
           AND j.created_at < (SELECT max(created_at) FROM jobs
             WHERE media_id = ? AND kind = ? AND status IN ('queued', 'leased'))`,
      )
      .get(kind, mediaId, mediaId, kind);
    return Number(row?.['ahead'] ?? 0);
  }

  measuredRates(): MeasuredRates {
    const of = (table: 'transcripts' | 'diarizations'): number | null =>
      ratio(
        this.db
          .prepare(
            `SELECT sum(t.elapsed_ms) AS elapsed, sum(m.duration_ms) AS audio
             FROM ${table} t JOIN media m ON m.id = t.media_id
             WHERE m.duration_ms > 0`,
          )
          .get(),
      );
    return { transcribe: of('transcripts'), speakers: of('diarizations') };
  }
}
