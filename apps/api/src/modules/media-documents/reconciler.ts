import { randomUUID } from 'node:crypto';
import type { MediaDocumentStorePort } from '../../ports/media-document-store.js';
import type { TrackDocumentSource } from './document-source.js';
import {
  renderTrackDocument,
  type RenderedDocument,
} from './track-document.js';

/** Recordings without tracks given a document per collection by each sweep (FR-7). */
export const BACKFILL_BATCH = 50;

/**
 * Documents one sweep renders again at most; the next sweep goes on after the last one
 * (a cursor), so a big library is covered over a few sweeps (KBC-100 review 6).
 */
export const SWEEP_LIMIT = 2_000;

/** Media rendered between two turns of the event loop while sweeping. */
export const SWEEP_SLICE = 20;

/** Lets the event loop run (requests, research streams) between two slices of a sweep. */
const nextTurn = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

export interface ReconcilerDeps {
  readonly source: Pick<TrackDocumentSource, 'inputOf' | 'tracksOf'>;
  readonly documents: Pick<
    MediaDocumentStorePort,
    | 'desire'
    | 'retire'
    | 'hasPending'
    | 'enqueue'
    | 'documented'
    | 'documentedUnder'
    | 'undocumentedRecordings'
    | 'statusOf'
  >;
  /**
   * Whether the app knows the collection (from the vault or made on the screen): every one
   * it knows gets documents, and the Mac creates a missing vault folder (KBC-114 BR-6).
   */
  readonly isCollection: (topic: string) => boolean;
  /** The recordings of a collection (and its sub-collections): their tracks follow (BR-1). */
  readonly mediaOf?: (topic: string) => readonly string[];
  /** A media whose document could not be rendered (logged; the sweep tries it again). */
  readonly onError?: (mediaId: string, err: unknown) => void;
  /** A collection's background render that stopped short (the store failed; logged). */
  readonly onTopicError?: (topic: string, err: unknown) => void;
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** The sweep's bounds (defaults SWEEP_LIMIT, SWEEP_SLICE) and its pause between slices. */
  readonly sweep?: {
    readonly limit?: number;
    readonly slice?: number;
    readonly pause?: () => Promise<void>;
  };
}

/** What one sweep did: media rendered again and the slices they were cut into. */
export interface SweepReport {
  readonly rendered: number;
  readonly slices: number;
}

/** A rendered document with the media and collection it belongs to. */
export interface TrackRender extends RenderedDocument {
  readonly mediaId: string;
  readonly topic: string;
}

/**
 * Keeps the vault's track documents fresh by reconciliation (ADR 0035 §4): whatever changed,
 * the media it touches are rendered again (cheap: text from media.db). A different render
 * is wanted (`write`), a media that stopped having a document leaves a removal at its old
 * place (`remove`), and each collection with anything for the Mac keeps one queued job.
 * Every entry point is synchronous, so a caller runs it inside its own transaction.
 */
export class MediaDocumentReconciler {
  private readonly now: () => Date;
  private readonly newId: () => string;
  /**
   * Media whose render threw: the sweep renders them again, since a first render that
   * failed left no `media_documents` row for it to find. Kept in memory: after a restart
   * such a media gets its document at its next change.
   */
  private readonly unrendered = new Set<string>();
  /** The last document the previous sweep rendered: the next one starts after it. */
  private cursor: string | null = null;
  /** A sweep still running when the next one is due: that one is skipped. */
  private sweeping = false;
  /**
   * Collections whose every recording is due a render (reconcileTopic), drained off the
   * request in slices (review 3). A collection asked again while it waits is drained once.
   */
  private readonly dueTopics = new Set<string>();
  /** The drain of `dueTopics` running, if any. */
  private draining: Promise<void> | null = null;
  /**
   * Media a collection's drain rendered since the last sweep began: that sweep does not
   * render them again (the fingerprint would only match).
   */
  private readonly freshFromTopics = new Set<string>();
  /** The sweep and the drains take turns: never two renders of a media side by side. */
  private turn: Promise<void> = Promise.resolve();
  /** The app is closing: no slice starts any more (its database is about to close). */
  private stopped = false;

  constructor(private readonly deps: ReconcilerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  /** The document of a media as it is now, without recording anything; null if none. */
  preview(mediaId: string): TrackRender | null {
    const input = this.deps.source.inputOf(mediaId);
    if (!input || !this.deps.isCollection(input.topic)) return null;
    return { ...renderTrackDocument(input), mediaId, topic: input.topic };
  }

  /** The document of a media as it is now, recorded as the one to publish; null if none. */
  render(mediaId: string): TrackRender | null {
    const rendered = this.preview(mediaId);
    if (!rendered) return null;
    this.deps.documents.desire({
      mediaId,
      topic: rendered.topic,
      path: rendered.path,
      fingerprint: rendered.fingerprint,
      now: this.now(),
    });
    return rendered;
  }

  /**
   * Something of a recording changed (a transcript, its details, a track's revision, an
   * archive, a restore, a publication, a deletion, subjects or a speaker's name): the
   * recording's own document and every track it has, or had, follow (FR-1).
   */
  reconcileRecording(recordingId: string): void {
    this.reconcile(this.familyOf(recordingId));
  }

  /** A recording, the tracks it has and the ones that still have a document under it. */
  private familyOf(recordingId: string): readonly string[] {
    return [
      recordingId,
      ...this.deps.source.tracksOf(recordingId),
      ...this.deps.documents.documentedUnder(recordingId),
    ];
  }

  /**
   * **The text of these media changed** (KBC-093's word correction, ADR 0034 §5 and its
   * amendment 8): only they are rendered again, and one job is queued per collection they
   * are in. Synchronous: call it inside the correction's transaction, after the tracks'
   * slices were replaced. A media whose text did not really change renders the same
   * fingerprint and queues nothing (BR-1).
   */
  reconcileTracks(mediaIds: readonly string[]): void {
    this.reconcile(mediaIds);
  }

  /**
   * Something of a whole collection changed (its main author, an author's or a speaker's
   * name): each of its recordings follows as one that changed, with every track it has or
   * had (a track's authorship and speakers are its recording's). A big collection holds
   * thousands of documents, so the request only marks it and returns; its recordings are
   * rendered after, in slices of SWEEP_SLICE with a turn of the event loop between them
   * (review 3). Only a render whose fingerprint changed queues a job (BR-1).
   */
  reconcileTopic(topic: string): void {
    if (this.stopped) return;
    this.dueTopics.add(topic);
    this.draining ??= this.exclusive(() => this.drainTopics())
      .catch((err: unknown) => this.deps.onTopicError?.(topic, err))
      .finally(() => {
        this.draining = null;
        // Marked between the drain's last look and now: drained by a new run.
        if (this.dueTopics.size > 0 && !this.stopped)
          this.reconcileTopic([...this.dueTopics][0] ?? topic);
      });
  }

  /** Resolves once no sweep nor collection drain is running or waiting (tests, measures, close). */
  async idle(): Promise<void> {
    while (this.draining || this.sweeping) {
      await (this.draining ?? this.turn);
    }
  }

  /** The app is closing: what runs stops at its next slice and nothing new starts. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.dueTopics.clear();
    await this.idle();
  }

  private async drainTopics(): Promise<void> {
    for (const topic of this.dueTopics) {
      this.dueTopics.delete(topic);
      if (this.stopped) return;
      try {
        await this.drainTopic(topic);
      } catch (err) {
        this.deps.onTopicError?.(topic, err);
      }
    }
  }

  /** A collection's recordings with their families, rendered a slice at a time. */
  private async drainTopic(topic: string): Promise<void> {
    const slice = this.deps.sweep?.slice ?? SWEEP_SLICE;
    const pause = this.deps.sweep?.pause ?? nextTurn;
    let batch: string[] = [];
    const flush = async () => {
      this.reconcile(batch);
      for (const mediaId of batch) this.freshFromTopics.add(mediaId);
      batch = [];
      await pause();
    };
    for (const recordingId of this.deps.mediaOf?.(topic) ?? []) {
      if (this.stopped) return;
      batch.push(...this.familyOf(recordingId));
      if (batch.length >= slice) await flush();
    }
    if (batch.length > 0 && !this.stopped) await flush();
  }

  /** Runs `work` after whatever sweep or drain is running ends. */
  private exclusive(work: () => Promise<void>): Promise<void> {
    const run = this.turn.then(work);
    this.turn = run.catch(() => undefined);
    return run;
  }

  /**
   * The backstop, every 10 minutes: the renders that failed, a batch of recordings without
   * tracks (FR-7) and the documents the app has (a missed callback, a removal), at most
   * SWEEP_LIMIT of them from where the last sweep stopped. Rendered in slices of SWEEP_SLICE
   * with a turn of the event loop between them: a render reads a whole transcript with its
   * speakers, so a big library would otherwise hold the API for seconds (review 6).
   */
  async reconcileAll(): Promise<SweepReport> {
    if (this.sweeping || this.stopped) return { rendered: 0, slices: 0 };
    this.sweeping = true;
    let report: SweepReport = { rendered: 0, slices: 0 };
    try {
      await this.exclusive(async () => {
        report = await this.sweep();
      });
      return report;
    } finally {
      this.sweeping = false;
    }
  }

  private async sweep(): Promise<SweepReport> {
    // What a collection's drain just rendered is not rendered again; a failed one is.
    const fresh = new Set(this.freshFromTopics);
    this.freshFromTopics.clear();
    const due = [
      ...new Set([
        ...this.unrendered,
        ...[...this.backfill(), ...this.nextDocumented()].filter(
          (mediaId) => !fresh.has(mediaId),
        ),
      ]),
    ];
    const slice = this.deps.sweep?.slice ?? SWEEP_SLICE;
    const pause = this.deps.sweep?.pause ?? nextTurn;
    let slices = 0;
    let rendered = 0;
    for (let at = 0; at < due.length && !this.stopped; at += slice) {
      const part = due.slice(at, at + slice);
      this.reconcile(part);
      rendered += part.length;
      slices += 1;
      await pause();
    }
    return { rendered, slices };
  }

  /**
   * Recordings without tracks that may get their whole text (FR-7), only in collections the
   * app still knows: the others would read a whole transcript for nothing every sweep.
   */
  private backfill(): readonly string[] {
    return this.deps.documents
      .undocumentedRecordings(BACKFILL_BATCH)
      .filter((one) => this.deps.isCollection(one.topic))
      .map((one) => one.mediaId);
  }

  /** The next SWEEP_LIMIT documents after the cursor, going round to the first ones. */
  private nextDocumented(): readonly string[] {
    const all = [...this.deps.documents.documented()].sort();
    const limit = this.deps.sweep?.limit ?? SWEEP_LIMIT;
    if (all.length <= limit) {
      this.cursor = null;
      return all;
    }
    const after = this.cursor;
    const start =
      after === null
        ? 0
        : Math.max(
            0,
            all.findIndex((id) => id > after),
          );
    const taken = all.slice(start, start + limit);
    taken.push(...all.slice(0, limit - taken.length));
    this.cursor = taken.at(-1) ?? null;
    return taken;
  }

  /**
   * Runs inside the caller's transaction: a media that cannot be rendered is logged and left
   * for the sweep, never thrown, so it never undoes what the person did.
   */
  private reconcile(mediaIds: readonly string[]): void {
    const topics = new Set<string>();
    for (const mediaId of new Set(mediaIds)) {
      for (const topic of this.follow(mediaId)) topics.add(topic);
    }
    for (const topic of topics) this.enqueueIfPending(topic);
  }

  /** The collections a media's document touched: where it is wanted, where it left. */
  private follow(mediaId: string): readonly string[] {
    // Where it was: a move leaves a removal there, whose collection needs its job too.
    const before = this.deps.documents.statusOf(mediaId)?.topic;
    const outcome = this.settle(mediaId);
    if (outcome === 'failed') return [];
    return [outcome.rendered?.topic, outcome.left, before].filter(
      (topic): topic is string => typeof topic === 'string',
    );
  }

  /** Rendered and wanted, or retired; `failed` when the render threw (logged). */
  private settle(
    mediaId: string,
  ): { rendered: TrackRender | null; left: string | null } | 'failed' {
    try {
      const rendered = this.render(mediaId);
      this.unrendered.delete(mediaId);
      const left = rendered
        ? null
        : this.deps.documents.retire(mediaId, this.now());
      return { rendered, left };
    } catch (err) {
      this.unrendered.add(mediaId);
      this.deps.onError?.(mediaId, err);
      return 'failed';
    }
  }

  /** A queued job's media, rendered again at lease: its current text, or its removal. */
  refresh(mediaId: string): TrackRender | null {
    const outcome = this.settle(mediaId);
    return outcome === 'failed' ? null : outcome.rendered;
  }

  /** One queued job per collection, only when something waits for the Mac. */
  enqueueIfPending(topic: string): void {
    if (!this.deps.documents.hasPending(topic)) return;
    this.deps.documents.enqueue({ topic, id: this.newId(), now: this.now() });
  }
}
