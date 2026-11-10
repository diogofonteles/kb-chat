import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  hasAcceptedAudioExtension,
  remapBookmark,
  type Author,
  type CreateMediaRequest,
  type MediaAuthor,
  type MediaItem,
  type TrackParent,
  type PreparationPlan,
  type RemappedBookmark,
  type UploadCheck,
  type UploadCheckRequest,
  type UploadElsewhere,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import {
  UploadRefusedError,
  type MediaFilesPort,
  type UploadProblem,
} from '../../ports/media-files.js';
import type {
  ListeningStorePort,
  SavedProgress,
} from '../../ports/listening-store.js';
import type { MediaRecord, MediaStorePort } from '../../ports/media-store.js';
import type { TrackItemStorePort } from '../../ports/track-item-store.js';
import type { TrackRevisionStorePort } from '../../ports/track-revision-store.js';
import {
  canEditMedia,
  estimatedBytesOf,
  legacyAuthorshipOf,
} from './media-policy.js';
import { mediaAuthorOf, toMediaItem, type ItemView } from './to-media-item.js';
import type { Presence } from './transcriber-service.js';

/** Who acts on the media library: their principal, the collections they see, the role. */
export interface MediaActor {
  readonly principal: string;
  readonly isMaster: boolean;
  /** Has `media-upload`, in the collections they see. */
  readonly canUpload: boolean;
  /** Their converted space in bytes; null: no quota, the owner (KBC-035 BR-1). */
  readonly quotaBytes?: number | null;
  /** Has `media-tracks`: track items exist for them (KBC-068 FR-5). */
  readonly seesTracks?: boolean;
  /** Has `media-subjects`: subjects reach the library (KBC-070 BR-3). */
  readonly seesSubjects?: boolean;
  /** Has `search`: the library may look inside transcripts for them (KBC-096 R4). */
  readonly searchesSpeech?: boolean;
  /** The person's name, for the history of a track (KBC-073 BR-8). */
  readonly displayName?: string;
  readonly canSee: (topic: string) => boolean;
}

/** What a plan's options depend on, on top of the actor (KBC-072 BR-3). */
export interface PlanActor extends MediaActor {
  /** Has `media-edit`. */
  readonly canEdit: boolean;
  /** Has `media-edit-ai`. */
  readonly canPropose: boolean;
}

/** Checks a plan before an upload exists and keeps it once it does (KBC-072 FR-1). */
export interface UploadPlans {
  assertAllowed(actor: PlanActor, plan: PreparationPlan): void;
  record(actor: PlanActor, mediaId: string, plan: PreparationPlan): void;
}

export interface MediaServiceDeps {
  /** A recording was deleted: its documents leave the vault (KBC-100 BR-2). */
  readonly onRemoved?: (mediaId: string) => void;
  readonly store: MediaStorePort;
  readonly files: MediaFilesPort;
  /** The collection exists in the vault (a master "sees" any slug, even a wrong one). */
  readonly hasTopic: (topic: string) => boolean;
  /** The collection and its sub-collections, listed like a folder (ADR 0028); default: itself. */
  readonly scopeOf?: (topic: string) => readonly string[];
  /** The collection a sub-collection belongs to (ADR 0028); default: itself. */
  readonly rootOf?: (topic: string) => string;
  /** Each person's position in each media (KBC-041). */
  readonly listening: ListeningStorePort;
  /** Whether a transcriber is on (KBC-036 FR-1); "none" when not given. */
  readonly presence?: () => Presence;
  /** Groq is on and has a key (KBC-037): masters see "Transcrever com Groq". */
  readonly groqReady?: () => boolean;
  /** Queues a new transcription; false when one is already waiting or running. */
  readonly requestTranscription?: (mediaId: string) => boolean;
  /** One author of the collection's list (KBC-049, a sub-collection uses its parent's). */
  readonly authorOf: (topic: string, slug: string) => Author | null;
  /** The track items of a recording (KBC-068): what a removal takes with it. */
  readonly tracks?: Pick<TrackItemStorePort, 'filesOf' | 'liveTitles'>;
  /** The cuts replaced, still served to who is on them (KBC-073 BR-3). */
  readonly oldCuts?: Pick<TrackRevisionStorePort, 'oldFile'>;
  readonly now?: () => Date;
}

/** What the stream route needs to answer a GET with or without Range. */
export interface PlayableFile {
  readonly path: string;
  readonly size: number;
  readonly modifiedMs: number;
  readonly mime: string;
}

const notFound = () => new AppError('MEDIA_NOT_FOUND', 'Unknown media');
const notWaiting = () =>
  new AppError('MEDIA_CONFLICT', 'This media is not waiting for this part');

/** An upload of this person that the janitor gave up (KBC-035 AC-6). */
const isOwnAbandoned = (media: MediaRecord, actor: MediaActor): boolean =>
  media.failure === 'upload-abandoned' &&
  media.ownerPrincipal === actor.principal;

function assertDeclaredSize(declared: number, expected: number): void {
  if (declared > expected)
    throw new AppError(
      'PAYLOAD_TOO_LARGE',
      'The file is larger than announced',
    );
  if (declared < expected)
    throw new AppError(
      'VALIDATION_FAILED',
      'The file is smaller than announced',
      {
        details: { field: 'file' },
      },
    );
}

/** What a whole file sent in one go was refused for. */
const SAVE_REFUSALS: Record<UploadProblem, () => AppError> = {
  'too-large': () =>
    new AppError('PAYLOAD_TOO_LARGE', 'The file is larger than announced'),
  incomplete: () =>
    new AppError(
      'VALIDATION_FAILED',
      'The file ended before the announced size',
      { details: { field: 'file' } },
    ),
  different: () =>
    new AppError('VALIDATION_FAILED', 'The file came out different', {
      details: { field: 'sha256' },
    }),
};

/**
 * The media library for people (KBC-034): upload in two steps, list a collection, play,
 * and the masters' "Tentar de novo" and "Remover". A media item in a collection the person
 * cannot see does not exist for them (404, BR-2).
 */
export class MediaService {
  private readonly now: () => Date;
  /** What is writing an item's upload now: a second write is refused, a HEAD waits. */
  private readonly receiving = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: MediaServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  create(
    actor: MediaActor,
    topic: string,
    request: Omit<CreateMediaRequest, 'plan'>,
  ): MediaItem {
    this.assertTopic(topic);
    this.assertMediaOpen(actor, topic);
    if (!hasAcceptedAudioExtension(request.fileName))
      throw new AppError('VALIDATION_FAILED', 'Not an accepted audio file', {
        details: { field: 'fileName' },
      });
    const author = this.requireAuthor(topic, request.author);
    // No await up to the insert: two uploads of one file cannot both pass (one writer).
    if (request.sha256) this.assertNotRepeated(topic, request.sha256);
    this.assertWithinQuota(actor, request);
    const record = this.deps.store.createMedia({
      id: randomUUID(),
      topic,
      title: request.title,
      author: author?.slug ?? null,
      legacyAuthorship: legacyAuthorshipOf(author?.slug ?? null),
      ownerPrincipal: actor.principal,
      fileName: request.fileName,
      uploadBytes: request.bytes,
      sourceSha256: request.sha256 ?? null,
      estimatedBytes: estimatedBytesOf(request),
      now: this.now(),
    });
    return this.itemOf(record, actor, this.view());
  }

  /** What a chosen file is, before anything is sent (KBC-035 FR-1, FR-3). */
  async check(
    actor: MediaActor,
    topic: string,
    request: UploadCheckRequest,
  ): Promise<UploadCheck> {
    this.assertTopic(topic);
    this.assertMediaOpen(actor, topic);
    const sent = this.deps.store.findBySource(topic, request.sha256);
    const live = sent.find((media) => media.status !== 'failed');
    if (live?.status === 'uploading' && live.ownerPrincipal === actor.principal)
      return {
        verdict: 'resume',
        media: { id: live.id, title: live.title },
        offset: await this.deps.files.uploadOffset(live.id),
      };
    if (live)
      return {
        verdict: 'duplicate',
        media: { id: live.id, title: live.title },
      };
    if (this.overQuota(actor, request))
      return { verdict: 'over-quota', quotaBytes: actor.quotaBytes ?? 0 };
    if (sent.some((media) => isOwnAbandoned(media, actor)))
      return { verdict: 'expired' };
    const elsewhere = this.elsewhere(actor, topic, request);
    return elsewhere.length > 0
      ? { verdict: 'new', elsewhere }
      : { verdict: 'new' };
  }

  /** The same file in another part of the collection, as far as the person sees (KBC-091). */
  private elsewhere(
    actor: MediaActor,
    topic: string,
    { sha256 }: UploadCheckRequest,
  ): UploadElsewhere[] {
    const rootOf = this.deps.rootOf ?? ((slug: string) => slug);
    const root = rootOf(topic);
    return this.deps.store
      .findEverywhere(sha256)
      .filter(
        (media) =>
          media.topic !== topic &&
          rootOf(media.topic) === root &&
          media.status !== 'failed' &&
          actor.canSee(media.topic) &&
          (media.status === 'ready' ||
            actor.isMaster ||
            media.ownerPrincipal === actor.principal),
      )
      .map(({ id, title, topic: where }) => ({ id, title, topic: where }));
  }

  /**
   * The route let the person into the collection; its media may still be closed to them
   * (KBC-103 BR-10: a collection with levels, until KBC-105). Then nothing is added or checked
   * there, and the answer names no item (QA-1, QA-4).
   */
  private assertMediaOpen(actor: MediaActor, topic: string): void {
    if (!actor.canSee(topic))
      throw new AppError('LEVELS_PENDING', 'Media waits for levels here');
  }

  private assertNotRepeated(topic: string, sha256: string): void {
    const live = this.deps.store
      .findBySource(topic, sha256)
      .find((media) => media.status !== 'failed');
    if (live)
      throw new AppError('MEDIA_DUPLICATE', 'This file is already here', {
        details: { media: { id: live.id, title: live.title } },
      });
  }

  private assertWithinQuota(
    actor: MediaActor,
    request: CreateMediaRequest,
  ): void {
    if (this.overQuota(actor, request))
      throw new AppError('MEDIA_QUOTA_EXCEEDED', 'Over the media quota', {
        details: { quotaBytes: actor.quotaBytes },
      });
  }

  private overQuota(
    actor: MediaActor,
    request: { readonly bytes: number; readonly durationMs?: number | null },
  ): boolean {
    const { quotaBytes } = actor;
    if (quotaBytes === undefined || quotaBytes === null) return false;
    const used = this.deps.store.usedBytes(actor.principal);
    return used + estimatedBytesOf(request) > quotaBytes;
  }

  /**
   * Where a resumable upload stands (tus HEAD, KBC-035 FR-2). A client takes a whole file
   * for a finished upload and sends nothing more, so a whole file is only answered as such
   * once it was finished: here, when nothing else is doing it (a restart in the middle).
   */
  async uploadStatus(
    actor: MediaActor,
    mediaId: string,
  ): Promise<{ readonly offset: number; readonly length: number }> {
    const media = this.ownItem(actor, mediaId);
    const length = media.uploadBytes;
    // The answer to the last part was lost: for the client, that is a finished upload.
    if (media.status !== 'uploading') return { offset: length, length };
    const offset = await this.deps.files.uploadOffset(mediaId);
    if (offset < length) return { offset, length };
    const running = this.receiving.get(mediaId);
    if (!running) {
      const finished = await this.hold(mediaId, () => this.finish(media));
      return { offset: finished ? length : 0, length };
    }
    await running.catch(() => undefined);
    return this.uploadStatus(actor, mediaId);
  }

  /** Runs what writes this item's upload, and marks it as running until it ends. */
  private async hold<T>(mediaId: string, write: () => Promise<T>): Promise<T> {
    const running = write();
    this.receiving.set(mediaId, running);
    try {
      return await running;
    } finally {
      this.receiving.delete(mediaId);
    }
  }

  /**
   * One part (tus PATCH): it must start where the last one ended. A part cut short keeps
   * what arrived. The last byte checks the announced hash and queues the conversion.
   */
  async receivePart(
    actor: MediaActor,
    mediaId: string,
    part: { readonly body: Readable; readonly offset: number },
  ): Promise<number> {
    const media = this.ownItem(actor, mediaId);
    if (media.status !== 'uploading' || this.receiving.has(mediaId))
      throw notWaiting();
    return this.hold(mediaId, () => this.appendPart(media, part));
  }

  private async appendPart(
    media: MediaRecord,
    part: { readonly body: Readable; readonly offset: number },
  ): Promise<number> {
    const { files, store } = this.deps;
    if ((await files.uploadOffset(media.id)) !== part.offset)
      throw notWaiting();
    store.touchUpload(media.id, this.now());
    const offset = await this.append(media, part.body);
    store.touchUpload(media.id, this.now());
    if (offset === media.uploadBytes && !(await this.finish(media)))
      throw new AppError('VALIDATION_FAILED', 'The file came out different', {
        details: { field: 'sha256' },
      });
    return offset;
  }

  private async append(media: MediaRecord, body: Readable): Promise<number> {
    try {
      return await this.deps.files.appendUpload({
        mediaId: media.id,
        body,
        expectedBytes: media.uploadBytes,
      });
    } catch (err) {
      if (err instanceof UploadRefusedError)
        throw new AppError(
          'PAYLOAD_TOO_LARGE',
          'The file is larger than announced',
        );
      throw err;
    }
  }

  /**
   * The whole file goes to the queue. Bytes that are not the announced file start over
   * (false): they would never be found again.
   */
  private async finish(media: MediaRecord): Promise<boolean> {
    const { files } = this.deps;
    if (
      media.sourceSha256 &&
      (await files.hashUpload(media.id)) !== media.sourceSha256
    ) {
      await files.discardUpload(media.id);
      return false;
    }
    await files.finishUpload(media.id);
    await this.queue(media.id);
    return true;
  }

  /** The uploader's own item; one whose upload expired says so. */
  private ownItem(actor: MediaActor, mediaId: string): MediaRecord {
    const media = this.visible(actor, mediaId);
    if (media.ownerPrincipal !== actor.principal) throw notFound();
    if (media.failure === 'upload-abandoned')
      throw new AppError('MEDIA_UPLOAD_EXPIRED', 'This upload expired');
    return media;
  }

  /** The file of an item created by this person; it goes to the queue when complete. */
  async receiveFile(
    actor: MediaActor,
    mediaId: string,
    upload: { readonly body: Readable; readonly declaredBytes?: number },
  ): Promise<MediaItem> {
    const { body, declaredBytes } = upload;
    const media = this.visible(actor, mediaId);
    if (media.ownerPrincipal !== actor.principal) throw notFound();
    if (media.status !== 'uploading' || this.receiving.has(mediaId))
      throw new AppError(
        'MEDIA_CONFLICT',
        'This media is not waiting for its file',
      );
    // A Content-Length that disagrees is refused before a byte is read.
    if (declaredBytes !== undefined)
      assertDeclaredSize(declaredBytes, media.uploadBytes);
    try {
      await this.hold(mediaId, () => this.save(media, body));
    } catch (err) {
      // Removed while its bytes were arriving: the file is gone, so is the item.
      if (!this.deps.store.getMedia(mediaId)) {
        await this.deps.files.discardUpload(mediaId);
        throw notFound();
      }
      throw err;
    }
    const queued = await this.queue(mediaId);
    return this.itemOf(queued, actor, this.view());
  }

  /** The file arrived: queue the conversion, unless the item was removed meanwhile. */
  private async queue(mediaId: string): Promise<MediaRecord> {
    try {
      return this.deps.store.markUploaded({
        mediaId,
        jobId: randomUUID(),
        now: this.now(),
      });
    } catch (err) {
      await this.deps.files.discardUpload(mediaId);
      if (!this.deps.store.getMedia(mediaId)) throw notFound();
      throw new AppError(
        'MEDIA_CONFLICT',
        'This media is not waiting for its file',
        {
          cause: err,
        },
      );
    }
  }

  list(actor: MediaActor, topic: string): MediaItem[] {
    this.assertTopic(topic);
    const scope = this.deps.scopeOf?.(topic) ?? [topic];
    const records = scope
      // A collection with levels keeps its media from members until KBC-105 (KBC-103 BR-10).
      .filter((slug) => actor.canSee(slug))
      .flatMap((slug) => this.deps.store.listMedia(slug))
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
      );
    const progress = this.deps.listening.progressOf(
      actor.principal,
      records.map((record) => record.id),
    );
    const presence = this.deps.presence?.();
    return records.map((record) =>
      this.itemOf(record, actor, {
        progress: progress.get(record.id),
        presence,
      }),
    );
  }

  get(actor: MediaActor, mediaId: string): MediaItem {
    const record = this.visible(actor, mediaId);
    const progress = this.deps.listening
      .progressOf(actor.principal, [mediaId])
      .get(mediaId);
    return this.itemOf(record, actor, this.view(progress));
  }

  /**
   * A recording the queue may show this person (KBC-090): as in the library, one not ready
   * yet only for who sent it and masters (KBC-051 BR-2); null for anything else.
   */
  followable(actor: MediaActor, mediaId: string): MediaItem | null {
    const media = this.deps.store.getMedia(mediaId);
    if (!media || media.track !== null || !actor.canSee(media.topic))
      return null;
    const mine = actor.isMaster || media.ownerPrincipal === actor.principal;
    return media.status === 'ready' || mine ? this.get(actor, mediaId) : null;
  }

  /** The item, for what only a recording has (proposals, voices, an edit). */
  getRecording(actor: MediaActor, mediaId: string): MediaItem {
    const item = this.get(actor, mediaId);
    if (item.parent)
      throw new AppError('MEDIA_CONFLICT', 'A track follows its recording', {
        details: { reason: 'track' },
      });
    return item;
  }

  /** Whether this item is a track; 404 when the person cannot see it. */
  isTrack(actor: MediaActor, mediaId: string): boolean {
    return this.visible(actor, mediaId).track !== null;
  }

  /**
   * `fileVersion`: the cut the player started on (KBC-073 BR-3). An old one is served while
   * it is kept, and once gone it is a 404: the new bytes at that offset would mix two cuts.
   */
  async playable(
    actor: MediaActor,
    mediaId: string,
    fileVersion?: number,
  ): Promise<PlayableFile> {
    const media = this.visible(actor, mediaId);
    if (media.archivedAt !== null) throw notFound();
    const rendition = this.renditionOf(media, fileVersion);
    if (media.status !== 'ready' || !rendition)
      throw new AppError('MEDIA_NOT_READY', 'This media cannot be played yet');
    const file = await this.deps.files.stat(rendition.path);
    if (!file)
      throw new AppError('MEDIA_NOT_READY', 'The converted file is missing');
    return { path: rendition.path, mime: rendition.mime, ...file };
  }

  private renditionOf(media: MediaRecord, fileVersion: number | undefined) {
    const current = media.track?.fileVersion;
    if (fileVersion === undefined || fileVersion === current)
      return this.deps.store.getRendition(media.id);
    const old = this.deps.oldCuts?.oldFile(media.id, fileVersion);
    if (!old) throw notFound();
    return old;
  }

  /**
   * A position read on an older cut, in the current one's time (KBC-073 BR-3); past the end
   * it is the end. With the old cut forgotten there is no way to know: the player's number
   * stays, as any other position.
   */
  currentPosition(
    item: MediaItem,
    position: { readonly positionMs: number; readonly fileVersion?: number },
  ): number {
    const { positionMs } = position;
    const { parent, durationMs } = item;
    const old = this.oldCutOf(item, position.fileVersion);
    if (!parent || !old) return positionMs;
    const moved = positionMs + old.startMs - parent.startMs;
    return Math.max(0, Math.min(moved, durationMs ?? moved));
  }

  /** A bookmark read on an older cut: the rule of one that was there when it changed (BR-4). */
  bookmarkLanding(
    item: MediaItem,
    position: { readonly positionMs: number; readonly fileVersion?: number },
  ): RemappedBookmark {
    const { positionMs } = position;
    const { parent, durationMs } = item;
    const old = this.oldCutOf(item, position.fileVersion);
    if (!parent || !old) return { inTrack: true, positionMs };
    return remapBookmark(positionMs, {
      oldStartMs: old.startMs,
      newStartMs: parent.startMs,
      durationMs: durationMs ?? parent.endMs - parent.startMs,
    });
  }

  private oldCutOf(item: MediaItem, fileVersion: number | undefined) {
    if (fileVersion === undefined || fileVersion === item.parent?.fileVersion)
      return null;
    return this.deps.oldCuts?.oldFile(item.id, fileVersion) ?? null;
  }

  /** The bytes `start..end` of a playable file. */
  openRange(path: string, range: { start: number; end: number }): Readable {
    return this.deps.files.read(path, range);
  }

  /**
   * The record, its jobs and every file go (FR-8). Masters remove any item; the uploader
   * may remove their own while it is still uploading (a cancelled upload).
   */
  async remove(
    actor: MediaActor,
    mediaId: string,
    options: { readonly cascade?: boolean } = {},
  ): Promise<void> {
    const media = this.visible(actor, mediaId);
    const cancelling =
      media.status === 'uploading' && media.ownerPrincipal === actor.principal;
    if (!actor.isMaster && !cancelling)
      throw new AppError('FORBIDDEN', 'Only a master may remove media');
    this.assertRemovable(media, options.cascade ?? false);
    const trackFiles = this.deps.tracks?.filesOf(mediaId) ?? [];
    const rendition = this.deps.store.getRendition(mediaId);
    this.deps.store.deleteMedia(mediaId);
    // Its documents and its tracks' leave the vault (KBC-100 BR-2).
    this.deps.onRemoved?.(mediaId);
    const { files } = this.deps;
    await files.discardUpload(mediaId);
    await files.remove([
      files.audioPath(mediaId),
      files.flacPath(mediaId),
      ...trackFiles,
      ...(rendition ? [rendition.path] : []),
    ]);
    await files.removeTranscripts(mediaId);
  }

  /** A track leaves through its edit; a recording's live tracks are named first (KBC-073 FR-8). */
  private assertRemovable(media: MediaRecord, cascade: boolean): void {
    if (media.track)
      throw new AppError('MEDIA_CONFLICT', 'A track leaves through its edit', {
        details: { reason: 'track' },
      });
    const titles = this.deps.tracks?.liveTitles(media.id) ?? [];
    if (titles.length > 0 && !cascade)
      throw new AppError('MEDIA_CONFLICT', 'This recording has tracks', {
        details: { reason: 'has-tracks', tracks: [...titles] },
      });
  }

  /**
   * Masters only (route access): transcribe a ready item again; the new transcript becomes
   * a new version and the current one (BR-3).
   */
  transcribeAgain(actor: MediaActor, mediaId: string): MediaItem {
    const media = this.visible(actor, mediaId);
    const queue = this.deps.requestTranscription;
    if (media.status !== 'ready' || media.track || !queue || !queue(mediaId))
      throw new AppError(
        'MEDIA_CONFLICT',
        'This media cannot be transcribed again now',
      );
    return this.get(actor, mediaId);
  }

  private view(progress?: SavedProgress): ItemView {
    return { progress, presence: this.deps.presence?.() };
  }

  /** Masters only (route access): a failure that a new conversion may fix (FR-7). */
  retry(actor: MediaActor, mediaId: string): MediaItem {
    const media = this.visible(actor, mediaId);
    if (!this.itemOf(media, { ...actor, isMaster: true }).canRetry)
      throw new AppError(
        'MEDIA_CONFLICT',
        'This media cannot be converted again',
      );
    return this.itemOf(
      this.deps.store.retryMedia({ mediaId, now: this.now() }),
      actor,
      this.view(),
    );
  }

  /** An upload names an author already in the collection's list (FR-1: registered first). */
  private requireAuthor(topic: string, slug: string | null): Author | null {
    if (slug === null) return null;
    const author = this.deps.authorOf(topic, slug);
    if (!author)
      throw new AppError('VALIDATION_FAILED', 'Unknown author', {
        details: { field: 'author' },
      });
    return author;
  }

  /** The contract view with the item's author as the collection names it (KBC-049). */
  private itemOf(
    record: MediaRecord,
    actor: MediaActor,
    view: ItemView = {},
  ): MediaItem {
    return toMediaItem(record, actor.isMaster, {
      ...view,
      author: this.authorOf(record),
      canEdit: canEditMedia(actor, record),
      parent: this.parentOf(record),
      groqReady: actor.isMaster && (this.deps.groqReady?.() ?? false),
    });
  }

  /** Where a track item comes from (FR-4); null for a recording. */
  private parentOf(record: MediaRecord): TrackParent | null {
    if (!record.track) return null;
    const { parentId, startMs, endMs, ordinal, version, fileVersion } =
      record.track;
    const parent = this.deps.store.getMedia(parentId);
    if (!parent) return null;
    return {
      id: parentId,
      title: parent.title,
      startMs,
      endMs,
      ordinal,
      total: this.deps.store.trackTotal(parentId),
      version,
      fileVersion,
    };
  }

  /** The stored author as the list now names it (still shown if no longer listed). */
  private authorOf(record: MediaRecord): MediaAuthor {
    return mediaAuthorOf(record, this.deps.authorOf);
  }

  private assertTopic(topic: string): void {
    if (!this.deps.hasTopic(topic))
      throw new AppError('TOPIC_NOT_FOUND', 'Unknown topic');
  }

  private visible(actor: MediaActor, mediaId: string): MediaRecord {
    const media = this.deps.store.getMedia(mediaId);
    if (!media || !actor.canSee(media.topic)) throw notFound();
    // A track exists for who has `media-tracks`, once published (FR-1, FR-5).
    if (media.track && (!actor.seesTracks || media.status !== 'ready'))
      throw notFound();
    return media;
  }

  private async save(media: MediaRecord, body: Readable): Promise<void> {
    try {
      await this.deps.files.saveUpload({
        mediaId: media.id,
        body,
        expectedBytes: media.uploadBytes,
        sha256: media.sourceSha256,
      });
    } catch (err) {
      if (!(err instanceof UploadRefusedError)) throw err;
      throw SAVE_REFUSALS[err.problem]();
    }
  }
}
