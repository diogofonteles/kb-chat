import {
  approvalProblems,
  timingProblems,
  type ApprovedTrack,
  type EditApproved,
  type EditSaved,
  type EditTrack,
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
import type { SpeakerStorePort } from '../../ports/speaker-store.js';
import type { TrackProposalStorePort } from '../../ports/track-proposal-store.js';
import type { TranscriptStorePort } from '../../ports/transcript-store.js';
import type { MediaActor } from '../media/index.js';

export interface MediaEditServiceDeps {
  readonly edits: MediaEditStorePort;
  readonly drafts: Pick<TrackProposalStorePort, 'draft'>;
  readonly transcripts: Pick<TranscriptStorePort, 'transcripts' | 'words'>;
  readonly speakers: Pick<SpeakerStorePort, 'list'>;
  /** The top-level collection whose speakers a recording uses (KBC-065 BR-1). */
  readonly rootOf: (topic: string) => string;
  /** The item as this person sees it; throws MEDIA_NOT_FOUND when they cannot. */
  readonly findMedia: (actor: MediaActor, mediaId: string) => MediaItem;
  readonly now?: () => Date;
}

/** A write to an edit: who, on what, from which version. */
export interface EditCall {
  readonly actor: MediaActor;
  readonly mediaId: string;
  readonly expectedVersion: number;
}

/** A save as validated: blank titles already read as none. */
export interface SaveEdit {
  readonly tracks: readonly EditTrack[];
  readonly step: EditStep;
}

const stale = () =>
  new AppError('EDIT_STALE', 'Someone else changed this edit');

const invalid = (problems: readonly TrackProblem[]) =>
  new AppError('TRACKS_INVALID', 'These tracks cannot be kept', {
    details: { problems },
  });

const speakerIdsOf = (track: EditTrack) =>
  [track.askerSpeakerId, track.answererSpeakerId].filter(
    (id): id is string => id !== null,
  );

/**
 * The draft a person validates and approves (KBC-066, ADR 0029 §4): nothing reaches
 * listeners but through `approve` (BR-1). The API checks again what the editor checks
 * (BR-3, BR-4), and a write on an old version is refused, never merged (FR-10).
 */
export class MediaEditService {
  private readonly now: () => Date;

  constructor(private readonly deps: MediaEditServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  get(actor: MediaActor, mediaId: string): MediaEdit {
    this.ready(actor, mediaId);
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
    };
  }

  save(call: EditCall, request: SaveEdit): EditSaved {
    const item = this.ready(call.actor, call.mediaId);
    this.assertEditable(call);
    this.assertOwnSpeakers(item, request.tracks);
    const problems = timingProblems(request.tracks, item.durationMs);
    if (problems.length > 0) throw invalid(problems);
    return this.written(
      this.deps.edits.save({
        ...this.writeOf(call),
        tracks: request.tracks,
        step: request.step,
        transcriptVersion: this.transcriptVersion(call.mediaId),
      }),
    );
  }

  /** The last check and the only way to listeners (BR-1). */
  approve(call: EditCall): EditApproved {
    const item = this.ready(call.actor, call.mediaId);
    this.assertEditable(call);
    const { tracks } = this.deps.drafts.draft(call.mediaId);
    if (tracks.length === 0)
      throw new AppError('TRACKS_INVALID', 'There are no tracks to approve', {
        details: { problems: [] },
      });
    const problems = approvalProblems(tracks, item.durationMs);
    if (problems.length > 0) throw invalid(problems);
    const { version } = this.written(
      this.deps.edits.approve({
        ...this.writeOf(call),
        transcriptVersion: this.transcriptVersion(call.mediaId),
      }),
    );
    return { version, tracks: tracks.length };
  }

  reopen(call: EditCall): EditSaved {
    this.ready(call.actor, call.mediaId);
    return this.written(this.deps.edits.reopen(this.writeOf(call)));
  }

  /** The current transcript's words: where a handle snaps (BR-2). */
  words(actor: MediaActor, mediaId: string): EditWords {
    this.ready(actor, mediaId);
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
    return { tracks: this.listenable(item) };
  }

  private listenable(item: MediaItem): ApprovedTrack[] {
    return this.deps.edits.approved(item.id);
  }

  private ready(actor: MediaActor, mediaId: string): MediaItem {
    const item = this.deps.findMedia(actor, mediaId);
    if (item.status !== 'ready')
      throw new AppError('MEDIA_NOT_READY', 'This media is not ready yet');
    return item;
  }

  /** A proposal is writing the draft, or an approval stands: no draft to change. */
  private assertEditable(call: EditCall): void {
    const { edits, drafts } = this.deps;
    if (edits.edit(call.mediaId)?.status === 'approved')
      throw new AppError('MEDIA_CONFLICT', 'Reopen this edit first', {
        details: { reason: 'approved' },
      });
    if (drafts.draft(call.mediaId).run?.status === 'running')
      throw new AppError('MEDIA_CONFLICT', 'A proposal is running', {
        details: { reason: 'proposal-running' },
      });
  }

  /** A speaker comes from the recording's own collection (KBC-065 BR-1). */
  private assertOwnSpeakers(
    item: MediaItem,
    tracks: readonly EditTrack[],
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
