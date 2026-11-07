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
  /**
   * After a publication (KBC-099 FR-1): the recording's track documents follow. Called inside
   * the publishing transaction, so the documents are wanted with the tracks or not at all.
   */
  readonly onPublished?: (parentId: string) => void;
  /**
   * Anything else of a recording that its documents show changed (KBC-100 FR-1): a new
   * transcript, its details, a track's revision, an archive, a restore. Called inside the
   * change's transaction.
   */
  readonly onChanged?: (parentId: string) => void;
  readonly now?: () => Date;
}

/** An item and the real part of the recording its file holds. */
type LiveItem = ReturnType<TrackItemStorePort['published']>[number];

type Answerer = Pick<TrackItemRow, 'answererVoice' | 'answererSpeakerId'>;

const NO_ANSWERER: Answerer = { answererVoice: null, answererSpeakerId: null };

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
    if (items.hasPendingCuts(parentId)) return;
    items.publish({ parentId, detailsOf: this.detailsFor(parentId), now });
    this.deps.onPublished?.(parentId);
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
    const parentId = this.deps.store.getMedia(mediaId)?.track?.parentId;
    if (parentId && !items.hasPendingCuts(parentId))
      this.deps.onPublished?.(parentId);
  }

  /**
   * Inside the new transcript's transaction (BR-4): each live item gets its slice, by the file
   * it has now, even one a cancelled approval left with no track row. Every read of a track's
   * text is derived; nothing is transcribed again.
   */
  afterTranscript(parentId: string): void {
    const { items, transcripts } = this.deps;
    const now = this.now();
    const slice = this.slicerOf(parentId);
    for (const item of items.published(parentId)) {
      const transcript = slice(item);
      if (transcript) transcripts.replaceDerived(transcript, now);
    }
    this.deps.onChanged?.(parentId);
  }

  /**
   * Something else its documents show changed (a track's title or summary, KBC-073; who
   * speaks): the recording's documents follow.
   */
  afterChange(parentId: string): void {
    this.deps.onChanged?.(parentId);
  }

  /**
   * A recording's author or collection changed: who its tracks are by may too (BR-2). A live
   * item with no track row no longer has an answerer: it follows the recording until the next
   * approval takes it back or archives it.
   */
  afterRecordingEdit(parentId: string): void {
    const { items, store } = this.deps;
    const parent = store.getMedia(parentId);
    if (!parent) return;
    const authorOf = this.authorResolver(parent);
    const now = this.now();
    const tracks = items.tracksOf(parentId);
    const withRow = new Set(tracks.map((track) => track.mediaId));
    const leftBehind = items
      .published(parentId)
      .filter((item) => !withRow.has(item.mediaId))
      .map(({ mediaId }) => ({ mediaId, ...NO_ANSWERER }));
    for (const track of [...tracks, ...leftBehind])
      items.setAuthor({ mediaId: track.mediaId, now, ...authorOf(track) });
    this.deps.onChanged?.(parentId);
  }

  /**
   * A deleted track stops holding back the approval its dead cut waited on (KBC-073 FR-2):
   * titles and tracks left out wait too, with no candidate of their own.
   */
  afterArchive(parentId: string, cutFailed: boolean): void {
    const { items } = this.deps;
    // The archived track's document leaves (KBC-100 BR-2), whatever the cuts.
    this.deps.onChanged?.(parentId);
    if (!cutFailed || items.hasPendingCuts(parentId)) return;
    items.publish({
      parentId,
      detailsOf: this.detailsFor(parentId),
      now: this.now(),
    });
    this.deps.onPublished?.(parentId);
  }

  /** A track came back: its text, cut from the transcript of today, enters search again. */
  afterRestore(parentId: string, mediaId: string): void {
    const slice = this.slicerOf(parentId);
    const item = this.deps.items
      .published(parentId)
      .find((one) => one.mediaId === mediaId);
    const transcript = item ? slice(item) : null;
    if (transcript)
      this.deps.transcripts.replaceDerived(transcript, this.now());
    this.afterRecordingEdit(parentId);
  }

  private detailsFor(parentId: string): DetailsOf {
    const parent = this.deps.store.getMedia(parentId);
    if (!parent) throw new Error(`recording ${parentId} does not exist`);
    const slice = this.slicerOf(parentId);
    const authorOf = this.authorResolver(parent);
    const [current] = this.deps.transcripts.transcripts(parentId);
    return (track) => ({
      ...authorOf(track),
      transcript:
        track.cut || this.isBehind(track.mediaId, current)
          ? slice({
              mediaId: track.mediaId,
              startMs: track.realStartMs,
              endMs: track.realEndMs,
            })
          : null,
    });
  }

  /** Whether an item's text was not cut from the recording's current transcript (BR-4). */
  private isBehind(mediaId: string, current?: TranscriptSummary): boolean {
    const [derived] = this.deps.transcripts.transcripts(mediaId);
    return current !== undefined && derived?.model !== current.id;
  }

  /** Who answers, when they are an author of the collection; else the recording's (AC-1). */
  private authorResolver(parent: MediaRecord) {
    const labels = this.labelsOf(parent.id);
    return (
      track: Answerer,
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
    return ({ mediaId, startMs, endMs }: LiveItem): NewTranscript => {
      const window = { startMs, endMs };
      return toDerived(mediaId, {
        current,
        window,
        slice: sliceTranscript(source, window),
      });
    };
  }
}

/** What a transcription run has and a slice does not. */
const NO_RUN = {
  parametersVersion: 'track-slice-1',
  termsVersion: 0,
  speechRatio: 1,
  elapsedMs: 0,
  rawPath: '',
  removedWords: 0,
  lowWords: 0,
} as const;

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
    ...NO_RUN,
    vad: current.vad,
    filterVersion: current.filterVersion,
    confidenceVersion: current.confidenceVersion,
    confidence: current.confidence,
    wordCount: slice.words.length,
    segments: slice.segments,
    words: slice.words,
  };
}
