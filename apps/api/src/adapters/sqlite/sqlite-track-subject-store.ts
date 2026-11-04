import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  proposalFailureSchema,
  proposalStatusSchema,
  subjectKey,
  type FreeSubject,
  type SubjectRun,
} from '@kb-chat/contracts';
import type {
  LinkTarget,
  NewFreeSubject,
  NewSubjectRun,
  StoredFreeSubject,
  StoredLink,
  StoredTrackSubjects,
  SubjectDecision,
  SubjectRunEnd,
  SubjectWrite,
  TrackSubjectStorePort,
  TrackSuggestions,
} from '../../ports/track-subject-store.js';
import { inTransaction } from './media-database.js';

type Row = Record<string, SQLOutputValue>;

const textOrNull = (value: SQLOutputValue | undefined): string | null =>
  value === null || value === undefined ? null : String(value);

function toRun(row: Row): SubjectRun {
  const failure = textOrNull(row['failure']);
  return {
    id: String(row['id']),
    mediaId: String(row['media_id']),
    status: proposalStatusSchema.parse(row['status']),
    model: String(row['model']),
    estimateUsd: Number(row['estimate_usd']),
    spentUsd: Number(row['spent_usd']),
    failure: failure === null ? null : proposalFailureSchema.parse(failure),
    createdAt: String(row['created_at']),
    finishedAt: textOrNull(row['finished_at']),
  };
}

const keyOfTarget = (target: LinkTarget): string => {
  if (target.kind === 'free') return `free:${target.id}`;
  return `${target.kind}:${subjectKey(target.name)}`;
};

const LINKS = `SELECT l.id, l.media_id, l.kind, l.status, l.concept_name, l.new_name,
    l.subject_id, s.name AS free_name, s.collection
  FROM media_subject_links l LEFT JOIN media_subjects s ON s.id = l.subject_id
  WHERE l.media_id IN (SELECT value FROM json_each(?)) AND l.status <> 'refused'
  ORDER BY l.created_at, l.rowid`;

function toLink(row: Row): StoredLink {
  const kind = String(row['kind']) as StoredLink['kind'];
  const names = {
    concept: row['concept_name'],
    free: row['free_name'],
    new: row['new_name'],
  };
  return {
    id: String(row['id']),
    mediaId: String(row['media_id']),
    kind,
    status: row['status'] === 'accepted' ? 'accepted' : 'suggested',
    name: String(names[kind]),
    freeId: textOrNull(row['subject_id']),
    collection: textOrNull(row['collection']),
  };
}

/** Free subjects, links, summaries and the AI's runs (KBC-069, ADR 0029 §6). */
export class SqliteTrackSubjectStore implements TrackSubjectStorePort {
  constructor(private readonly db: DatabaseSync) {}

  freeSubjects(collection: string): FreeSubject[] {
    return this.db
      .prepare(
        'SELECT id, name FROM media_subjects WHERE collection = ? ORDER BY name_key',
      )
      .all(collection)
      .map((row) => ({ id: String(row['id']), name: String(row['name']) }));
  }

  freeSubject(id: string): StoredFreeSubject | null {
    const row = this.db
      .prepare('SELECT id, name, collection FROM media_subjects WHERE id = ?')
      .get(id);
    return row
      ? {
          id: String(row['id']),
          name: String(row['name']),
          collection: String(row['collection']),
        }
      : null;
  }

  createFree(input: NewFreeSubject & { by: string; now: Date }): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO media_subjects (id, collection, name, name_key, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (collection, name_key) DO NOTHING`,
      )
      .run(
        input.id,
        input.collection,
        input.name,
        input.key,
        input.by,
        input.now.toISOString(),
      );
    return Number(result.changes) === 1;
  }

  read(mediaIds: readonly string[]): StoredTrackSubjects[] {
    const ids = JSON.stringify(mediaIds);
    const rows = new Map(
      this.db
        .prepare(
          `SELECT * FROM media_track_subjects
           WHERE media_id IN (SELECT value FROM json_each(?))`,
        )
        .all(ids)
        .map((row) => [String(row['media_id']), row]),
    );
    const links = new Map<string, StoredLink[]>();
    for (const row of this.db.prepare(LINKS).all(ids)) {
      const link = toLink(row);
      links.set(link.mediaId, [...(links.get(link.mediaId) ?? []), link]);
    }
    return mediaIds.map((mediaId) => {
      const row = rows.get(mediaId);
      return {
        mediaId,
        version: Number(row?.['version'] ?? 0),
        summary: textOrNull(row?.['summary']),
        suggestedSummary: textOrNull(row?.['suggested_summary']),
        links: links.get(mediaId) ?? [],
      };
    });
  }

  save(
    write: SubjectWrite & {
      readonly accepted: readonly LinkTarget[];
      readonly summary: string | null;
    },
  ): number | null {
    return inTransaction(this.db, () => {
      if (this.versionOf(write.mediaId) !== write.expectedVersion) return null;
      const keys = write.accepted.map(keyOfTarget);
      this.refuseLeft(write, keys);
      for (const target of write.accepted) this.acceptTarget(write, target);
      this.touch(write, { summary: write.summary });
      return write.expectedVersion + 1;
    });
  }

  decide(
    write: SubjectWrite & {
      readonly accept: readonly SubjectDecision[];
      readonly refuse: readonly string[];
      readonly summary: 'accept' | 'refuse' | null;
    },
  ): number | null {
    return inTransaction(this.db, () => {
      if (this.versionOf(write.mediaId) !== write.expectedVersion) return null;
      for (const decision of write.accept) this.acceptLink(write, decision);
      for (const linkId of write.refuse) this.close(write, linkId, 'refused');
      const summary = this.decidedSummary(write);
      this.touch(write, summary);
      return write.expectedVersion + 1;
    });
  }

  acceptedLinks(subject: string): string[] {
    return this.db
      .prepare(
        `SELECT media_id FROM media_subject_links
         WHERE subject_key = ? AND status = 'accepted' ORDER BY media_id`,
      )
      .all(subject)
      .map((row) => String(row['media_id']));
  }

  startRun(run: NewSubjectRun): SubjectRun | null {
    const result = this.db
      .prepare(
        `INSERT INTO media_subject_runs (id, media_id, edit_version, principal, model, spend_id,
           status, estimate_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)
         ON CONFLICT (media_id) WHERE status = 'running' DO NOTHING`,
      )
      .run(
        run.id,
        run.mediaId,
        run.editVersion,
        run.principal,
        run.model,
        run.spendId,
        run.estimateUsd,
        run.now.toISOString(),
      );
    return Number(result.changes) === 1 ? this.run(run.id) : null;
  }

  run(runId: string): SubjectRun | null {
    const row = this.db
      .prepare('SELECT * FROM media_subject_runs WHERE id = ?')
      .get(runId);
    return row ? toRun(row) : null;
  }

  latestRun(mediaId: string): SubjectRun | null {
    const row = this.db
      .prepare(
        `SELECT * FROM media_subject_runs WHERE media_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(mediaId);
    return row ? toRun(row) : null;
  }

  hasDoneRun(mediaId: string, editVersion: number): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM media_subject_runs
         WHERE media_id = ? AND edit_version = ? AND status = 'done'`,
      )
      .get(mediaId, editVersion);
    return row !== undefined;
  }

  finishRun(end: SubjectRunEnd): void {
    inTransaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE media_subject_runs SET status = ?, failure = ?, spent_usd = ?,
             finished_at = ? WHERE id = ?`,
        )
        .run(
          end.failure === null ? 'done' : 'failed',
          end.failure,
          end.spentUsd,
          end.now.toISOString(),
          end.runId,
        );
      this.closeSpend(end);
      if (end.failure === null)
        for (const track of end.suggestions) this.suggest(end, track);
    });
  }

  interruptRunning(now: Date): number {
    const rows = this.db
      .prepare(
        `SELECT id, spend_id, spent_usd FROM media_subject_runs WHERE status = 'running'`,
      )
      .all();
    for (const row of rows)
      this.finishRun({
        runId: String(row['id']),
        spendId: String(row['spend_id']),
        failure: 'interrupted',
        spentUsd: Number(row['spent_usd']),
        suggestions: [],
        now,
      });
    return rows.length;
  }

  /** Done counts what was spent; failed gives back the rest (KBC-067 FR-5). */
  private closeSpend(end: SubjectRunEnd): void {
    this.db
      .prepare(
        `UPDATE media_spend SET status = ?, spent_usd = ?, settled_at = ?
         WHERE id = ? AND status = 'reserved'`,
      )
      .run(
        end.failure === null ? 'settled' : 'refunded',
        end.spentUsd,
        end.now.toISOString(),
        end.spendId,
      );
  }

  /** A new run's chips replace what waited; a track gone meanwhile is skipped. */
  private suggest(end: SubjectRunEnd, track: TrackSuggestions): void {
    const exists = this.db
      .prepare('SELECT 1 FROM media WHERE id = ?')
      .get(track.mediaId);
    if (!exists) return;
    this.db
      .prepare(
        `DELETE FROM media_subject_links WHERE media_id = ? AND status = 'suggested'`,
      )
      .run(track.mediaId);
    for (const target of track.subjects)
      this.insertLink({
        mediaId: track.mediaId,
        target,
        source: 'ai',
        status: 'suggested',
        runId: end.runId,
        at: end.now,
      });
    this.ensureRow(track.mediaId, end.now);
    this.db
      .prepare(
        'UPDATE media_track_subjects SET suggested_summary = ? WHERE media_id = ?',
      )
      .run(track.summary, track.mediaId);
  }

  private versionOf(mediaId: string): number {
    const row = this.db
      .prepare('SELECT version FROM media_track_subjects WHERE media_id = ?')
      .get(mediaId);
    return Number(row?.['version'] ?? 0);
  }

  private ensureRow(mediaId: string, now: Date): void {
    this.db
      .prepare(
        `INSERT INTO media_track_subjects (media_id, updated_at) VALUES (?, ?)
         ON CONFLICT (media_id) DO NOTHING`,
      )
      .run(mediaId, now.toISOString());
  }

  private touch(
    write: SubjectWrite,
    change: { readonly summary?: string | null; readonly clears?: boolean },
  ): void {
    this.ensureRow(write.mediaId, write.now);
    const keepsSummary = change.summary === undefined;
    this.db
      .prepare(
        `UPDATE media_track_subjects SET version = version + 1, updated_by = ?, updated_at = ?,
           summary = CASE WHEN ? THEN summary ELSE ? END,
           suggested_summary = CASE WHEN ? THEN NULL ELSE suggested_summary END
         WHERE media_id = ?`,
      )
      .run(
        write.principal,
        write.now.toISOString(),
        keepsSummary ? 1 : 0,
        change.summary ?? null,
        change.clears ? 1 : 0,
        write.mediaId,
      );
  }

  /** What "Aceitar" or "Recusar" does to the suggested summary. */
  private decidedSummary(write: {
    readonly mediaId: string;
    readonly summary: 'accept' | 'refuse' | null;
  }): { readonly summary?: string | null; readonly clears?: boolean } {
    if (write.summary === null) return {};
    if (write.summary === 'refuse') return { clears: true };
    const suggested = this.db
      .prepare(
        'SELECT suggested_summary FROM media_track_subjects WHERE media_id = ?',
      )
      .get(write.mediaId)?.['suggested_summary'];
    const summary = textOrNull(suggested);
    return summary === null ? {} : { summary, clears: true };
  }

  private refuseLeft(write: SubjectWrite, keys: readonly string[]): void {
    this.db
      .prepare(
        `UPDATE media_subject_links SET status = 'refused', decided_by = ?, decided_at = ?
         WHERE media_id = ? AND status = 'accepted'
           AND subject_key NOT IN (SELECT value FROM json_each(?))`,
      )
      .run(
        write.principal,
        write.now.toISOString(),
        write.mediaId,
        JSON.stringify(keys),
      );
  }

  private acceptTarget(write: SubjectWrite, target: LinkTarget): void {
    const key = keyOfTarget(target);
    const decided = this.db
      .prepare(
        `UPDATE media_subject_links SET status = 'accepted', decided_by = ?, decided_at = ?
         WHERE media_id = ? AND subject_key = ?`,
      )
      .run(write.principal, write.now.toISOString(), write.mediaId, key);
    if (Number(decided.changes) === 0)
      this.insertLink({
        mediaId: write.mediaId,
        target,
        source: 'manual',
        status: 'accepted',
        by: write.principal,
        at: write.now,
      });
    if (target.kind === 'free') this.dropNewTwin(write.mediaId, target.id);
  }

  /** "Novo assunto: «x»" waits no more once a person picked the free subject x. */
  private dropNewTwin(mediaId: string, freeId: string): void {
    this.db
      .prepare(
        `DELETE FROM media_subject_links
         WHERE media_id = ? AND status = 'suggested'
           AND subject_key = 'new:' || (SELECT name_key FROM media_subjects WHERE id = ?)`,
      )
      .run(mediaId, freeId);
  }

  private acceptLink(write: SubjectWrite, decision: SubjectDecision): void {
    if (decision.creates === null) {
      this.close(write, decision.linkId, 'accepted');
      return;
    }
    const { creates } = decision;
    this.createFree({ ...creates, by: write.principal, now: write.now });
    const row = this.db
      .prepare(
        'SELECT id FROM media_subjects WHERE collection = ? AND name_key = ?',
      )
      .get(creates.collection, creates.key);
    // The row of the name gives way to the free subject's: a new link can never be accepted.
    this.db
      .prepare('DELETE FROM media_subject_links WHERE id = ?')
      .run(decision.linkId);
    this.acceptTarget(write, { kind: 'free', id: String(row?.['id']) });
  }

  private close(
    write: SubjectWrite,
    linkId: string,
    status: 'accepted' | 'refused',
  ): void {
    this.db
      .prepare(
        `UPDATE media_subject_links SET status = ?, decided_by = ?, decided_at = ?
         WHERE id = ? AND media_id = ?`,
      )
      .run(
        status,
        write.principal,
        write.now.toISOString(),
        linkId,
        write.mediaId,
      );
  }

  private insertLink(link: {
    readonly mediaId: string;
    readonly target: LinkTarget;
    readonly source: 'manual' | 'ai';
    readonly status: 'suggested' | 'accepted';
    readonly runId?: string;
    readonly by?: string;
    readonly at: Date;
  }): void {
    const { target } = link;
    const at = link.at.toISOString();
    // A subject already on the track, even refused, is not offered again (FR-4).
    this.db
      .prepare(
        `INSERT INTO media_subject_links (id, media_id, kind, subject_key, concept_name,
           subject_id, new_name, source, status, run_id, decided_by, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (media_id, subject_key) DO NOTHING`,
      )
      .run(
        randomUUID(),
        link.mediaId,
        target.kind,
        keyOfTarget(target),
        target.kind === 'concept' ? target.name : null,
        target.kind === 'free' ? target.id : null,
        target.kind === 'new' ? target.name : null,
        link.source,
        link.status,
        link.runId ?? null,
        link.by ?? null,
        at,
        link.status === 'accepted' ? at : null,
      );
  }
}
