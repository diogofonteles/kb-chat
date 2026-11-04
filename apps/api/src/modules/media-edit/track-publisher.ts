import { randomUUID } from 'node:crypto';
import type { Author, CompleteCutRequest } from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { DiarizationStorePort } from '../../ports/diarization-store.js';
import type { MediaEditStorePort } from '../../ports/media-edit-store.js';
import type { MediaFilesPort } from '../../ports/media-files.js';
import type {
  LeaseOwner,
  LegacyAuthorship,
  MediaRecord,
  MediaStorePort,
} from '../../ports/media-store.js';
import type {
  SpeakerStorePort,
  VoiceLabelStorePort,
} from '../../ports/speaker-store.js';
import type {
  DetailsOf,
  TrackItemRow,
  TrackItemStorePort,
  TrackPlan,
} from '../../ports/track-item-store.js';
import type {
  NewTranscript,
  TranscriptStorePort,
  TranscriptSummary,
} from '../../ports/transcript-store.js';
import { legacyAuthorshipOf } from '../media/index.js';
import { matchTracks } from './track-matching.js';
import { sliceTranscript, type TrackWindow } from './track-slice.js';

export interface TrackPublisherDeps {
  readonly items: TrackItemStorePort;
  readonly edits: Pick<MediaEditStorePort, 'approved'>;
  readonly store: Pick<MediaStorePort, 'getMedia'>;
  readonly transcripts: Pick<
    TranscriptStorePort,
    'transcripts' | 'segments' | 'words' | 'heldJob' | 'replaceDerived'
  >;
  readonly speakers: Pick<SpeakerStorePort, 'get'>;
  readonly voiceLabels: Pick<VoiceLabelStorePort, 'labels'>;
  readonly diarizations: Pick<DiarizationStorePort, 'latest'>;
  readonly files: MediaFilesPort;
  /** One author of the collection's list (KBC-049). */
  readonly authorOf: (topic: string, slug: string) => Author | null;
  readonly now?: () => Date;
}

/** Bounds this close are the same cut: stream copy never lands exactly on the asked time. */
const SAME_BOUNDS_MS = 50;

const leaseLost = () =>
  new AppError('MEDIA_CONFLICT', 'This lease is no longer yours');

const sameBounds = (
  a: { startMs: number; endMs: number },
  b: { startMs: number; endMs: number },
): boolean =>
  Math.abs(a.startMs - b.startMs) <= SAME_BOUNDS_MS &&
  Math.abs(a.endMs - b.endMs) <= SAME_BOUNDS_MS;

/**
 * Approved tracks become items beside their recording (KBC-068, ADR 0029 §5). Nothing here is
 * seen until `publish`, which writes the whole approval at once; the publication in force
 * stays until then, whatever happens to the cuts.
 */
export class TrackPublisher {
  private readonly now: () => Date;

  constructor(private readonly deps: TrackPublisherDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Inside the approval's transaction: keeps the id of what overlaps enough (BR-5), queues
   * a cut for what is new or moved (FR-1), publishes at once when there is nothing to cut.
   */
  afterApproval(parentId: string): void {
    const { items } = this.deps;
    const tracks = this.approvedTracks(parentId);
    const previous = items.published(parentId);
    const kept = matchTracks(previous, tracks);
    const now = this.now();
    const plans = tracks.map((track): TrackPlan => {
      const mediaId = kept.get(track.id) ?? null;
      const old = previous.find((one) => one.mediaId === mediaId);
      return {
        trackId: track.id,
        keptMediaId: mediaId,
        newMediaId: randomUUID(),
        cutJobId: old && sameBounds(old, track) ? null : randomUUID(),
      };
    });
    items.plan({ parentId, plans, now });
    if (!items.hasPendingCuts(parentId))
      items.publish({ parentId, detailsOf: this.detailsFor(parentId), now });
  }

  private approvedTracks(parentId: string) {
    return this.deps.edits
      .approved(parentId)
      .map(({ id, startMs, endMs }) => ({ id, startMs, endMs }));
  }

  /** Reopening stops what the last approval started; what is published stays (BR-1). */
  cancel(parentId: string): readonly string[] {
    return this.deps.items.cancelPreparation(parentId);
  }

  async removeFiles(paths: readonly string[]): Promise<void> {
    await this.deps.files.remove(paths);
  }

  retryCuts(parentId: string): number {
    return this.deps.items.retryCuts(parentId, this.now());
  }

  /** A cut landed: the candidate is kept apart, and the last one publishes them all. */
  async completeCut(
    owner: LeaseOwner,
    done: Pick<CompleteCutRequest, 'bytes' | 'durationMs'>,
  ): Promise<void> {
    const { files, items, transcripts } = this.deps;
    const job = transcripts.heldJob(owner);
    if (job?.kind !== 'cut') throw leaseLost();
    const { mediaId } = job;
    const file = await files.stat(files.workPath(mediaId, owner.leaseId));
    if (file?.size !== done.bytes)
      throw new AppError('VALIDATION_FAILED', 'The cut is not on disk', {
        details: { field: 'bytes' },
      });
    const path = files.trackPath(mediaId, owner.leaseId);
    await files.promote(files.workPath(mediaId, owner.leaseId), path);
    const recorded = items.recordCut(
      { ...done, owner, mediaId, path, now: this.now() },
      (parentId) => this.detailsFor(parentId),
    );
    if (!recorded) {
      await files.remove([path]);
      throw leaseLost();
    }
    await files.remove(recorded.replaced);
  }

  /**
   * Inside the new transcript's transaction (BR-4): each live track gets its slice. Every
   * read of a track's text is derived; nothing is transcribed again.
   */
  afterTranscript(parentId: string): void {
    const { items, transcripts } = this.deps;
    const now = this.now();
    const slice = this.slicerOf(parentId);
    const live = new Set(items.published(parentId).map((one) => one.mediaId));
    for (const track of items.tracksOf(parentId)) {
      if (!live.has(track.mediaId)) continue;
      const transcript = slice(track);
      if (transcript) transcripts.replaceDerived(transcript, now);
    }
  }

  /** A recording's author or collection changed: who its tracks are by may too (BR-2). */
  afterRecordingEdit(parentId: string): void {
    const parent = this.deps.store.getMedia(parentId);
    if (!parent) return;
    const authorOf = this.authorResolver(parent);
    const now = this.now();
    for (const track of this.deps.items.tracksOf(parentId))
      this.deps.items.setAuthor({
        mediaId: track.mediaId,
        now,
        ...authorOf(track),
      });
  }

  private detailsFor(parentId: string): DetailsOf {
    const parent = this.deps.store.getMedia(parentId);
    if (!parent) throw new Error(`recording ${parentId} does not exist`);
    const slice = this.slicerOf(parentId);
    const authorOf = this.authorResolver(parent);
    return (track) => ({
      ...authorOf(track),
      transcript: track.cut ? slice(track) : null,
    });
  }

  /** Who answers, when they are an author of the collection; else the recording's (AC-1). */
  private authorResolver(parent: MediaRecord) {
    const labels = this.labelsOf(parent.id);
    return (
      track: TrackItemRow,
    ): { author: string | null; legacyAuthorship: LegacyAuthorship } => {
      const speakerId =
        track.answererSpeakerId ??
        (track.answererVoice === null
          ? null
          : (labels.get(track.answererVoice) ?? null));
      const slug = speakerId
        ? (this.deps.speakers.get(speakerId)?.authorSlug ?? null)
        : null;
      const answerer =
        slug !== null && this.deps.authorOf(parent.topic, slug) ? slug : null;
      const author = answerer ?? parent.author;
      return { author, legacyAuthorship: legacyAuthorshipOf(author) };
    };
  }

  /** The speaker each voice of the newest separation names. */
  private labelsOf(parentId: string): ReadonlyMap<number, string> {
    const { diarizations, voiceLabels } = this.deps;
    const latest = diarizations.latest(parentId);
    if (!latest) return new Map();
    return new Map(
      voiceLabels
        .labels(latest.id)
        .flatMap((label) =>
          label.speaker ? [[label.voice, label.speaker.id] as const] : [],
        ),
    );
  }

  /** The recording's current transcript, read once, cut per track. */
  private slicerOf(parentId: string) {
    const { transcripts } = this.deps;
    const [current] = transcripts.transcripts(parentId);
    if (!current) return () => null;
    const source = {
      segments: transcripts.segments(current.id),
      words: transcripts.words(current.id),
    };
    return (track: TrackItemRow): NewTranscript => {
      const window = { startMs: track.realStartMs, endMs: track.realEndMs };
      return toDerived(track.mediaId, {
        current,
        window,
        slice: sliceTranscript(source, window),
      });
    };
  }
}

/** A version as any other for the player and search (ADR 0029 §5), with no file behind it. */
function toDerived(
  mediaId: string,
  input: {
    readonly current: TranscriptSummary;
    readonly window: TrackWindow;
    readonly slice: ReturnType<typeof sliceTranscript>;
  },
): NewTranscript {
  const { current, window, slice } = input;
  return {
    id: randomUUID(),
    mediaId,
    provider: 'derived',
    model: current.id,
    parameters: JSON.stringify(window),
    parametersVersion: 'track-slice-1',
    termsVersion: 0,
    vad: current.vad,
    speechRatio: 1,
    elapsedMs: 0,
    rawPath: '',
    filterVersion: current.filterVersion,
    confidenceVersion: current.confidenceVersion,
    confidence: current.confidence,
    wordCount: slice.words.length,
    removedWords: 0,
    lowWords: 0,
    segments: slice.segments,
    words: slice.words,
  };
}
