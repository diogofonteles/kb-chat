import {
  approvalProblems,
  timingProblems,
  type ApprovedTrack,
  type EditApproved,
  type EditSaved,
  type EditStatus,
  type EditTrack,
  type LevelAuditEntry,
  type EditWords,
  type MediaEdit,
  type MediaItem,
  type MediaTracks,
  type EditStep,
  type TrackProblem,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type {
  EditWrite,
  MediaEditStorePort,
} from '../../ports/media-edit-store.js';
import type { PreparationStorePort } from '../../ports/preparation-store.js';
import type { SpeakerStorePort } from '../../ports/speaker-store.js';
import type { TrackProposalStorePort } from '../../ports/track-proposal-store.js';
import type { TranscriptStorePort } from '../../ports/transcript-store.js';
import type { TrackItemStorePort } from '../../ports/track-item-store.js';
import type { LevelAuditPort } from '../../ports/level-audit.js';
import type { MediaStorePort } from '../../ports/media-store.js';
import {
  NO_LEVELS,
  approvedLevelOf,
  hearsLevel,
  ownLevelOf,
  trackLevelChoices,
  type EditAuthor,
  type MediaActor,
  type MediaLevels,
} from '../media/index.js';
import type { TrackPublisher } from './track-publisher.js';

export interface TrackEditServiceDeps {
  readonly edits: MediaEditStorePort;
  readonly drafts: Pick<TrackProposalStorePort, 'draft'>;
  readonly transcripts: Pick<TranscriptStorePort, 'transcripts' | 'words'>;
  readonly speakers: Pick<SpeakerStorePort, 'list'>;
  /** The guided flow's plans (KBC-072). */
  readonly plans: Pick<PreparationStorePort, 'get'>;
  /** The top-level collection whose speakers a recording uses (KBC-065 BR-1). */
  readonly rootOf: (topic: string) => string;
  /** The item as this person sees it; throws MEDIA_NOT_FOUND when they cannot. */
  readonly findMedia: (actor: MediaActor, mediaId: string) => MediaItem;
  /**
   * The item for its edit: also throws EDIT_ABOVE_YOUR_LEVEL below a track of the recording
   * (KBC-106 decision); without it, `findMedia`.
   */
  readonly editable?: (actor: MediaActor, mediaId: string) => MediaItem;
  /** What an approval turns into (KBC-068); absent, tracks stay chapters. */
  readonly publisher?: TrackPublisher;
  readonly preparation?: Pick<TrackItemStorePort, 'preparation'>;
  /** The collections' scales (KBC-106); none: no collection has levels. */
  readonly levels?: MediaLevels;
  /** The levels media.db holds: a recording's, and its live tracks' (KBC-106). */
  readonly store?: Pick<MediaStorePort, 'levelOf' | 'liveTrackLevels'>;
  /** Where an approval that changes a track's level is recorded (ADR 0036 §11). */
  readonly audit?: LevelAuditPort;
  readonly log?: { error(fields: object, message: string): void };
  readonly now?: () => Date;
}

/** A write to an edit: who, on what, from which version. */
export interface EditCall {
  readonly actor: MediaActor;
  readonly mediaId: string;
  readonly expectedVersion: number;
  /** Who the levels audit names (KBC-106 BR-4). */
  readonly by?: EditAuthor;
}

/** A save as validated: blank titles already read as none. */
export interface SaveEdit {
  /** Without a level, a track follows its recording (KBC-106). */
  readonly tracks: readonly (Omit<EditTrack, 'level'> & {
    readonly level?: string | null;
  })[];
  readonly step: EditStep;
}

/**
 * One `item.level` line per track whose level the approval changed (KBC-106 BR-4): a track
 * kept with another level, and a new one approved with its own (review m3), from the
 * recording's level it would otherwise have had.
 */
function trackLevelLines(change: {
  readonly at: string;
  readonly by: EditAuthor;
  readonly topic: string;
  readonly recording: string | null;
  readonly before: ReadonlyMap<string, string | null>;
  readonly after: ReadonlyMap<string, string | null>;
}): LevelAuditEntry[] {
  const { at, by, topic } = change;
  return [...change.after].flatMap(([mediaId, after]) => {
    const known = change.before.get(mediaId);
    const before = known === undefined ? change.recording : known;
    if (before === after) return [];
    return [
      {
        at,
        by: by.by,
        ...(by.actingAs && { actingAs: by.actingAs }),
        kind: 'item.level' as const,
        collection: topic,
        target: mediaId,
        before,
        after,
        count: { recordings: 0, tracks: 1 },
      },
    ];
  });
}

/** A track as a save sends it. */
type SentTrack = SaveEdit['tracks'][number];

const stale = () =>
  new AppError('EDIT_STALE', 'Someone else changed this edit');

const invalid = (problems: readonly TrackProblem[]) =>
  new AppError('TRACKS_INVALID', 'These tracks cannot be kept', {
    details: { problems },
  });

const speakerIdsOf = (track: SentTrack) =>
  [track.askerSpeakerId, track.answererSpeakerId].filter(
    (id): id is string => id !== null,
  );

/**
 * The draft a person validates and approves (KBC-066, ADR 0029 §4): nothing reaches
 * listeners but through `approve` (BR-1). The API checks again what the editor checks
 * (BR-3, BR-4), and a write on an old version is refused, never merged (FR-10).
 */
export class TrackEditService {
  private readonly now: () => Date;

  constructor(private readonly deps: TrackEditServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  get(actor: MediaActor, mediaId: string): MediaEdit {
    const item = this.recording(actor, mediaId);
    const { edits, drafts } = this.deps;
    const edit = edits.edit(mediaId);
    const transcript = this.transcriptVersion(mediaId);
    return {
      mediaId,
      version: edit?.version ?? 0,
      started: edit !== null,
      status: edit?.status ?? 'draft',
      step: edit?.step ?? 3,
      ...drafts.draft(mediaId),
      approvedTracks: edits.approved(mediaId).length,
      transcriptChanged:
        edit?.transcriptVersion != null &&
        transcript !== null &&
        edit.transcriptVersion !== transcript,
      preparation:
        edit?.status === 'approved'
          ? (this.deps.preparation?.preparation(mediaId) ?? null)
          : null,
      preparationStep: this.preparationStep(mediaId, edit?.status),
      levels: trackLevelChoices(this.levelContext(actor, item)),
    };
  }

  /** The scale a track of this recording is placed in, and what this person may choose. */
  private levelContext(actor: MediaActor, item: MediaItem) {
    return {
      scale: (this.deps.levels ?? NO_LEVELS).scaleOf(item.topic),
      recording: this.deps.store?.levelOf(item.id) ?? null,
      allowed: actor.levelsIn(item.topic),
    };
  }

  /** Where an open plan stands: before "Validar faixas" it is still processing (BR-5). */
  private preparationStep(
    mediaId: string,
    status: EditStatus | undefined,
  ): 2 | 3 | null {
    const plan = this.deps.plans.get(mediaId);
    if (!plan || plan.finishedAt || status === 'approved') return null;
    return plan.validatingAt ? 3 : 2;
  }

  save(call: EditCall, request: SaveEdit): EditSaved {
    const item = this.recording(call.actor, call.mediaId);
    this.assertWritable(call);
    this.assertOwnTracks(call.mediaId, request.tracks);
    this.assertOwnSpeakers(item, request.tracks);
    const problems = timingProblems(request.tracks, item.durationMs);
    if (problems.length > 0) throw invalid(problems);
    const tracks = this.levelled(call, item, request.tracks);
    return this.written(
      this.deps.edits.save({
        ...this.writeOf(call),
        tracks,
        shownIds: this.deps.drafts
          .draft(call.mediaId)
          .tracks.map((track) => track.id),
        step: request.step,
        transcriptVersion: this.transcriptVersion(call.mediaId),
      }),
    );
  }

  /**
   * FR-1: never below the recording, never above the person; its own level, or null. A track
   * sent without a level keeps the one the draft holds (review B1, QA BUG-2).
   */
  private levelled(
    call: EditCall,
    item: MediaItem,
    sent: SaveEdit['tracks'],
  ): EditTrack[] {
    const context = this.levelContext(call.actor, item);
    const held = new Map(
      this.deps.drafts
        .draft(call.mediaId)
        .tracks.map((track) => [track.id, track.level]),
    );
    return sent.map((track) => ({
      ...track,
      level:
        track.level === undefined
          ? (held.get(track.id) ?? null)
          : ownLevelOf(context, track.level),
    }));
  }

  /** The last check and the only way to listeners (BR-1). */
  async approve(call: EditCall): Promise<EditApproved> {
    const item = this.recording(call.actor, call.mediaId);
    this.assertWritable(call);
    const tracks = this.approvable(item);
    const context = this.levelContext(call.actor, item);
    // KBC-106: each track's own level, as the draft holds it, goes to its item at once.
    const levels = new Map(
      tracks.map((track) => [track.id, approvedLevelOf(context, track.level)]),
    );
    const before = this.liveLevels(call.mediaId);
    const { version } = this.written(
      this.deps.edits.approve({
        ...this.writeOf(call),
        trackIds: tracks.map((track) => track.id),
        transcriptVersion: this.transcriptVersion(call.mediaId),
        alongside: () =>
          this.deps.publisher?.afterApproval(call.mediaId, levels),
      }),
    );
    await this.recordLevels(call, {
      topic: item.topic,
      recording: context.recording,
      before,
      after: this.liveLevels(call.mediaId),
    });
    return { version, tracks: tracks.length };
  }

  /** The draft's tracks, when an approval may take them (BR-5). */
  private approvable(item: MediaItem) {
    const { tracks } = this.deps.drafts.draft(item.id);
    if (tracks.length === 0)
      throw new AppError('TRACKS_INVALID', 'There are no tracks to approve', {
        details: { problems: [] },
      });
    const problems = approvalProblems(tracks, item.durationMs);
    if (problems.length > 0) throw invalid(problems);
    return tracks;
  }

  private liveLevels(mediaId: string): ReadonlyMap<string, string | null> {
    const live = this.deps.store?.liveTrackLevels(mediaId) ?? [];
    return new Map(live.map((one) => [one.mediaId, one.level]));
  }

  /**
   * BR-4: one `item.level` line per live track whose level the approval changed, written
   * after media.db (the audit cannot join its transaction); a failure is logged and fails.
   */
  private async recordLevels(
    call: EditCall,
    change: {
      readonly topic: string;
      readonly recording: string | null;
      readonly before: ReadonlyMap<string, string | null>;
      readonly after: ReadonlyMap<string, string | null>;
    },
  ): Promise<void> {
    const by = call.by ?? { by: call.actor.principal };
    const entries = trackLevelLines({
      at: this.now().toISOString(),
      by,
      ...change,
    });
    if (entries.length === 0) return;
    const { audit } = this.deps;
    if (!audit) throw new Error('A level changed with no audit to record it');
    try {
      await audit.appendMany(entries);
    } catch (err) {
      this.deps.log?.error(
        { err, by: by.by, mediaId: call.mediaId, tracks: entries.length },
        'media level changed but not audited',
      );
      throw err;
    }
  }

  /** Stops the cuts of the last approval; the items published stay (FR-1). */
  async reopen(call: EditCall): Promise<EditSaved> {
    this.recording(call.actor, call.mediaId);
    const { publisher } = this.deps;
    const candidates: string[] = [];
    const saved = this.written(
      this.deps.edits.reopen({
        ...this.writeOf(call),
        alongside: () => {
          candidates.push(...(publisher?.cancel(call.mediaId) ?? []));
        },
      }),
    );
    await publisher?.removeFiles(candidates);
    return saved;
  }

  /** "Tentar de novo" for the cuts given up: the approval stands (FR-1). */
  retryCuts(call: EditCall): EditSaved {
    this.recording(call.actor, call.mediaId);
    const edit = this.deps.edits.edit(call.mediaId);
    if (edit?.version !== call.expectedVersion) throw stale();
    if (!this.deps.publisher?.retryCuts(call.mediaId))
      throw new AppError('MEDIA_CONFLICT', 'No cut failed', {
        details: { reason: 'no-failed-cuts' },
      });
    return { version: edit.version };
  }

  /** The current transcript's words: where a handle snaps (BR-2). */
  words(actor: MediaActor, mediaId: string): EditWords {
    this.recording(actor, mediaId);
    const transcript = this.deps.transcripts.transcripts(mediaId)[0];
    if (!transcript)
      throw new AppError('MEDIA_NOT_READY', 'This media has no transcript yet');
    return {
      version: transcript.version,
      words: this.deps.transcripts
        .words(transcript.id)
        .map((word) => [word.startMs, word.endMs, word.text.trim()]),
    };
  }

  /** Approved tracks only, whatever the draft holds (BR-1, AC-1). */
  tracks(actor: MediaActor, mediaId: string): MediaTracks {
    const item = this.ready(actor, mediaId);
    return { tracks: this.listenable(actor, item) };
  }

  /**
   * KBC-106: a track above the person's level is not listed (its title is content too); the
   * others keep their numbers. Whoever sees level badges gets each track's.
   */
  private listenable(actor: MediaActor, item: MediaItem): ApprovedTrack[] {
    const { edits } = this.deps;
    const approved = edits.approved(item.id);
    const scale = (this.deps.levels ?? NO_LEVELS).scaleOf(item.topic);
    if (scale.length === 0) return approved;
    const recording = this.deps.store?.levelOf(item.id) ?? null;
    const levels = edits.approvedLevels(item.id);
    const levelOf = (track: ApprovedTrack) =>
      levels.has(track.id) ? (levels.get(track.id) ?? null) : recording;
    const badge = actor.isMaster || item.level !== undefined;
    return approved
      .filter((track) => hearsLevel(actor, item.topic, levelOf(track)))
      .map((track) => {
        if (!badge) return track;
        const found = scale.find((one) => one.id === levelOf(track));
        return found
          ? { ...track, level: { id: found.id, code: found.code } }
          : { ...track, level: null };
      });
  }

  /** Only a recording is edited: a track is changed through its recording's edit. */
  private recording(actor: MediaActor, mediaId: string): MediaItem {
    const item = this.ready(
      actor,
      mediaId,
      this.deps.editable ?? this.deps.findMedia,
    );
    if (item.parent)
      throw new AppError('MEDIA_CONFLICT', 'A track has no edit of its own', {
        details: { reason: 'track' },
      });
    return item;
  }

  private ready(
    actor: MediaActor,
    mediaId: string,
    find: TrackEditServiceDeps['findMedia'] = this.deps.findMedia,
  ): MediaItem {
    const item = find(actor, mediaId);
    if (item.status !== 'ready')
      throw new AppError('MEDIA_NOT_READY', 'This media is not ready yet');
    return item;
  }

  /**
   * The version first: who is late hears "someone changed this" whatever happened since, and
   * keeps their change to copy (FR-10). Then a proposal writing the draft, an approval standing
   * or a plan still before "Validar faixas" (KBC-072 BR-5) leaves no draft to change.
   */
  private assertWritable(call: EditCall): void {
    const { edits, drafts } = this.deps;
    const edit = edits.edit(call.mediaId);
    if ((edit?.version ?? 0) !== call.expectedVersion) throw stale();
    if (edit?.status === 'approved')
      throw new AppError('MEDIA_CONFLICT', 'Reopen this edit first', {
        details: { reason: 'approved' },
      });
    if (drafts.draft(call.mediaId).run?.status === 'running')
      throw new AppError('MEDIA_CONFLICT', 'A proposal is running', {
        details: { reason: 'proposal-running' },
      });
    if (this.preparationStep(call.mediaId, edit?.status) === 2)
      throw new AppError('MEDIA_CONFLICT', 'Still at step 2 of its plan', {
        details: { reason: 'preparation' },
      });
  }

  /** `media_tracks.id` is global: an id of another recording would fail on approval (FR-1). */
  private assertOwnTracks(mediaId: string, tracks: readonly SentTrack[]): void {
    const ids = tracks.map((track) => track.id);
    if (this.deps.edits.foreignIds(mediaId, ids).length > 0)
      throw new AppError('VALIDATION_FAILED', 'Unknown track', {
        details: { field: 'track' },
      });
  }

  /** A speaker comes from the recording's own collection (KBC-065 BR-1). */
  private assertOwnSpeakers(
    item: MediaItem,
    tracks: readonly SentTrack[],
  ): void {
    const chosen = tracks.flatMap(speakerIdsOf);
    if (chosen.length === 0) return;
    const collection = this.deps.rootOf(item.topic);
    const known = new Set(
      this.deps.speakers.list(collection).map((speaker) => speaker.id),
    );
    if (chosen.some((id) => !known.has(id)))
      throw new AppError('VALIDATION_FAILED', 'Unknown speaker', {
        details: { field: 'speaker' },
      });
  }

  private transcriptVersion(mediaId: string): number | null {
    return this.deps.transcripts.transcripts(mediaId)[0]?.version ?? null;
  }

  private writeOf(call: EditCall): EditWrite {
    return {
      mediaId: call.mediaId,
      expectedVersion: call.expectedVersion,
      principal: call.actor.principal,
      now: this.now(),
    };
  }

  private written(version: number | null): EditSaved {
    if (version === null) throw stale();
    return { version };
  }
}
