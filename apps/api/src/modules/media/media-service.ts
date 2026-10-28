import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  hasAcceptedAudioExtension,
  type CreateMediaRequest,
  type MediaItem,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import {
  UploadRefusedError,
  type MediaFilesPort,
} from '../../ports/media-files.js';
import type { MediaRecord, MediaStorePort } from '../../ports/media-store.js';
import { toMediaItem } from './to-media-item.js';

/** Who acts on the media library: their principal, the collections they see, the role. */
export interface MediaActor {
  readonly principal: string;
  readonly isMaster: boolean;
  readonly canSee: (topic: string) => boolean;
}

export interface MediaServiceDeps {
  readonly store: MediaStorePort;
  readonly files: MediaFilesPort;
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
    if (!hasAcceptedAudioExtension(request.fileName))
      throw new AppError('VALIDATION_FAILED', 'Not an accepted audio file', {
        details: { field: 'fileName' },
      });
    const record = this.deps.store.createMedia({
      id: randomUUID(),
      topic,
      title: request.title,
      authorship: request.authorship,
      ownerPrincipal: actor.principal,
      fileName: request.fileName,
      uploadBytes: request.bytes,
      now: this.now(),
    });
    return toMediaItem(record, actor.isMaster);
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
    } finally {
      this.receiving.delete(mediaId);
    }
    const queued = this.deps.store.markUploaded({
      mediaId,
      jobId: randomUUID(),
      now: this.now(),
    });
    return toMediaItem(queued, actor.isMaster);
  }

  list(actor: MediaActor, topic: string): MediaItem[] {
    return this.deps.store
      .listMedia(topic)
      .map((record) => toMediaItem(record, actor.isMaster));
  }

  get(actor: MediaActor, mediaId: string): MediaItem {
    return toMediaItem(this.visible(actor, mediaId), actor.isMaster);
  }

  async playable(actor: MediaActor, mediaId: string): Promise<PlayableFile> {
    const media = this.visible(actor, mediaId);
    const rendition = this.deps.store.getRendition(mediaId);
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

  /** Masters only (route access): the record, its jobs and every file go (FR-8). */
  async remove(actor: MediaActor, mediaId: string): Promise<void> {
    this.visible(actor, mediaId);
    const rendition = this.deps.store.getRendition(mediaId);
    this.deps.store.deleteMedia(mediaId);
    const { files } = this.deps;
    await files.discardUpload(mediaId);
    await files.remove([
      files.audioPath(mediaId),
      ...(rendition ? [rendition.path] : []),
    ]);
  }

  /** Masters only (route access): a failure that a new conversion may fix (FR-7). */
  retry(actor: MediaActor, mediaId: string): MediaItem {
    const media = this.visible(actor, mediaId);
    if (!toMediaItem(media, true).canRetry)
      throw new AppError(
        'MEDIA_CONFLICT',
        'This media cannot be converted again',
      );
    return toMediaItem(
      this.deps.store.retryMedia({ mediaId, now: this.now() }),
      actor.isMaster,
    );
  }

  private visible(actor: MediaActor, mediaId: string): MediaRecord {
    const media = this.deps.store.getMedia(mediaId);
    if (!media || !actor.canSee(media.topic)) throw notFound();
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
