import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  hasAcceptedAudioExtension,
  type Author,
  type CreateMediaRequest,
  type MediaAuthor,
  type MediaItem,
  type TrackParent,
  type PreparationPlan,
  type UploadCheck,
  type UploadCheckRequest,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import {
  UploadRefusedError,
  type MediaFilesPort,
} from '../../ports/media-files.js';
import type {
  ListeningStorePort,
  SavedProgress,
} from '../../ports/listening-store.js';
import type { MediaRecord, MediaStorePort } from '../../ports/media-store.js';
import type { TrackItemStorePort } from '../../ports/track-item-store.js';
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
  readonly store: MediaStorePort;
  readonly files: MediaFilesPort;
  /** The collection exists in the vault (a master "sees" any slug, even a wrong one). */
  readonly hasTopic: (topic: string) => boolean;
  /** The collection and its sub-collections, listed like a folder (ADR 0028); default: itself. */
  readonly scopeOf?: (topic: string) => readonly string[];
  /** Each person's position in each media (KBC-041). */
  readonly listening: ListeningStorePort;
  /** Whether a transcriber is on (KBC-036 FR-1); "none" when not given. */
  readonly presence?: () => Presence;
  /** Queues a new transcription; false when one is already waiting or running. */
  readonly requestTranscription?: (mediaId: string) => boolean;
  /** One author of the collection's list (KBC-049, a sub-collection uses its parent's). */
  readonly authorOf: (topic: string, slug: string) => Author | null;
  /** The track items of a recording (KBC-068): what a removal takes with it. */
  readonly tracks?: Pick<TrackItemStorePort, 'filesOf' | 'liveTitles'>;
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

/**
 * The media library for people (KBC-034): upload in two steps, list a collection, play,
 * and the masters' "Tentar de novo" and "Remover". A media item in a collection the person
 * cannot see does not exist for them (404, BR-2).
 */
export class MediaService {
  private readonly now: () => Date;
  /** Uploads streaming in now: a second request for the same item is refused. */
  private readonly receiving = new Set<string>();

  constructor(private readonly deps: MediaServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  create(
    actor: MediaActor,
    topic: string,
    request: Omit<CreateMediaRequest, 'plan'>,
  ): MediaItem {
    this.assertTopic(topic);
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
    return sent.some((media) => isOwnAbandoned(media, actor))
      ? { verdict: 'expired' }
      : { verdict: 'new' };
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

  /** Where a resumable upload stands (tus HEAD, KBC-035 FR-2). */
  async uploadStatus(
    actor: MediaActor,
    mediaId: string,
  ): Promise<{ readonly offset: number; readonly length: number }> {
    const media = this.ownItem(actor, mediaId);
    // The answer to the last part was lost: for the client, that is a finished upload.
    if (media.status !== 'uploading')
      return { offset: media.uploadBytes, length: media.uploadBytes };
    return {
      offset: await this.deps.files.uploadOffset(mediaId),
      length: media.uploadBytes,
    };
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
    this.receiving.add(mediaId);
    try {
      return await this.appendPart(media, part);
    } finally {
      this.receiving.delete(mediaId);
    }
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
    if (offset === media.uploadBytes) await this.complete(media);
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

  /** Bytes that are not the announced file start over: they would never be found again. */
  private async complete(media: MediaRecord): Promise<void> {
    const { files } = this.deps;
    if (
      media.sourceSha256 &&
      (await files.hashUpload(media.id)) !== media.sourceSha256
    ) {
      await files.discardUpload(media.id);
      throw new AppError('VALIDATION_FAILED', 'The file came out different', {
        details: { field: 'sha256' },
      });
    }
    await files.finishUpload(media.id);
    await this.queue(media.id);
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
    this.receiving.add(mediaId);
    try {
      await this.save(media, body);
    } catch (err) {
      // Removed while its bytes were arriving: the file is gone, so is the item.
      if (!this.deps.store.getMedia(mediaId)) {
        await this.deps.files.discardUpload(mediaId);
        throw notFound();
      }
      throw err;
    } finally {
      this.receiving.delete(mediaId);
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

  /** The item, for what only a recording has (proposals, voices, an edit). */
  getRecording(actor: MediaActor, mediaId: string): MediaItem {
    const item = this.get(actor, mediaId);
    if (item.parent)
      throw new AppError('MEDIA_CONFLICT', 'A track follows its recording', {
        details: { reason: 'track' },
      });
    return item;
  }

  async playable(actor: MediaActor, mediaId: string): Promise<PlayableFile> {
    const media = this.visible(actor, mediaId);
    const rendition = this.deps.store.getRendition(mediaId);
    if (media.archivedAt !== null) throw notFound();
    if (media.status !== 'ready' || !rendition)
      throw new AppError('MEDIA_NOT_READY', 'This media cannot be played yet');
    const file = await this.deps.files.stat(rendition.path);
    if (!file)
      throw new AppError('MEDIA_NOT_READY', 'The converted file is missing');
    return { path: rendition.path, mime: rendition.mime, ...file };
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
    });
  }

  /** Where a track item comes from (FR-4); null for a recording. */
  private parentOf(record: MediaRecord): TrackParent | null {
    if (!record.track) return null;
    const { parentId, startMs, endMs, ordinal } = record.track;
    const parent = this.deps.store.getMedia(parentId);
    if (!parent) return null;
    return {
      id: parentId,
      title: parent.title,
      startMs,
      endMs,
      ordinal,
      total: this.deps.store.trackTotal(parentId),
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
      });
    } catch (err) {
      if (!(err instanceof UploadRefusedError)) throw err;
      throw err.problem === 'too-large'
        ? new AppError('PAYLOAD_TOO_LARGE', 'The file is larger than announced')
        : new AppError(
            'VALIDATION_FAILED',
            'The file ended before the announced size',
            {
              details: { field: 'file' },
            },
          );
    }
  }
}
