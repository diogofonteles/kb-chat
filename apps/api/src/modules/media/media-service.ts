import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  hasAcceptedAudioExtension,
  type Author,
  type CreateMediaRequest,
  type MediaAuthor,
  type MediaItem,
  type TrackParent,
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
import { canEditMedia, legacyAuthorshipOf } from './media-policy.js';
import { mediaAuthorOf, toMediaItem, type ItemView } from './to-media-item.js';
import type { Presence } from './transcriber-service.js';

/** Who acts on the media library: their principal, the collections they see, the role. */
export interface MediaActor {
  readonly principal: string;
  readonly isMaster: boolean;
  /** Has `media-upload`, in the collections they see. */
  readonly canUpload: boolean;
  /** Has `media-tracks`: track items exist for them (KBC-068 FR-5). */
  readonly seesTracks?: boolean;
  readonly canSee: (topic: string) => boolean;
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
    request: CreateMediaRequest,
  ): MediaItem {
    this.assertTopic(topic);
    if (!hasAcceptedAudioExtension(request.fileName))
      throw new AppError('VALIDATION_FAILED', 'Not an accepted audio file', {
        details: { field: 'fileName' },
      });
    const author = this.requireAuthor(topic, request.author);
    const record = this.deps.store.createMedia({
      id: randomUUID(),
      topic,
      title: request.title,
      author: author?.slug ?? null,
      legacyAuthorship: legacyAuthorshipOf(author?.slug ?? null),
      ownerPrincipal: actor.principal,
      fileName: request.fileName,
      uploadBytes: request.bytes,
      now: this.now(),
    });
    return this.itemOf(record, actor, this.view());
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
