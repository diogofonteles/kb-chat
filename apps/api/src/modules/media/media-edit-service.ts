import { randomUUID } from 'node:crypto';
import {
  speakerKeyOf,
  type Author,
  type UpdateMediaRequest,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { MediaRecord, MediaStorePort } from '../../ports/media-store.js';
import type {
  SpeakerMove,
  SpeakerStorePort,
  StoredSpeaker,
} from '../../ports/speaker-store.js';
import type { MediaActor } from './media-service.js';
import { canEditMedia, legacyAuthorshipOf } from './media-policy.js';
import { toCollectionSpeaker } from './voice-labels.js';

export interface MediaEditServiceDeps {
  readonly store: Pick<MediaStorePort, 'getMedia' | 'editMedia'>;
  readonly speakers: Pick<SpeakerStorePort, 'labelled' | 'rehome'>;
  /** The collection exists in the vault (a master "sees" any slug, even a wrong one). */
  readonly hasTopic: (topic: string) => boolean;
  /** The top-level collection whose author and speaker lists a collection uses. */
  readonly rootOf: (topic: string) => string;
  readonly authorOf: (topic: string, slug: string) => Author | null;
  readonly now?: () => Date;
}

const unknownAuthor = () =>
  new AppError('VALIDATION_FAILED', 'Unknown author', {
    details: { field: 'author' },
  });

/**
 * Changing an item's title, author and collection (KBC-050). Positions, bookmarks and
 * transcripts follow the item's id, so a move only has to care for what lives in lists of
 * the collection: its author and the speakers of its voices.
 */
export class MediaEditService {
  private readonly now: () => Date;

  constructor(private readonly deps: MediaEditServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  edit(actor: MediaActor, mediaId: string, request: UpdateMediaRequest): void {
    const media = this.deps.store.getMedia(mediaId);
    if (!media || !actor.canSee(media.topic))
      throw new AppError('MEDIA_NOT_FOUND', 'Unknown media');
    if (!canEditMedia(actor, media))
      throw new AppError('FORBIDDEN', 'Only who sent it or a master may edit');
    const topic = this.destinationOf(actor, media, request.topic);
    const author = this.authorAfter(media, topic, request.author);
    const save = () =>
      this.deps.store.editMedia({
        mediaId,
        title: request.title ?? media.title,
        topic,
        author,
        legacyAuthorship: legacyAuthorshipOf(author),
        now: this.now(),
      });
    if (this.sameLists(media.topic, topic)) save();
    else
      this.deps.speakers.rehome({
        mediaId,
        moves: this.movesOf({ mediaId, from: media.topic, to: topic, actor }),
        alongside: save,
      });
  }

  /** BR-2: seeing the collection; sending there is the same right as editing (AC-4). */
  private destinationOf(
    actor: MediaActor,
    media: MediaRecord,
    topic: string | undefined,
  ): string {
    if (topic === undefined || topic === media.topic) return media.topic;
    if (!this.deps.hasTopic(topic) || !actor.canSee(topic))
      throw new AppError('TOPIC_NOT_FOUND', 'Unknown topic');
    return topic;
  }

  /** The author must be on the list it ends up in: a move never loses one in silence. */
  private authorAfter(
    media: MediaRecord,
    topic: string,
    asked: string | null | undefined,
  ): string | null {
    const author = asked === undefined ? media.author : asked;
    const kept = asked === undefined && this.sameLists(media.topic, topic);
    if (author === null || kept) return author;
    if (!this.deps.authorOf(topic, author)) throw unknownAuthor();
    return author;
  }

  private sameLists(a: string, b: string): boolean {
    return this.deps.rootOf(a) === this.deps.rootOf(b);
  }

  /** Each person named in its voices, as they are to be in the new collection's list. */
  private movesOf(input: {
    readonly mediaId: string;
    readonly from: string;
    readonly to: string;
    readonly actor: MediaActor;
  }): SpeakerMove[] {
    const collection = this.deps.rootOf(input.to);
    return this.deps.speakers.labelled(input.mediaId).map((speaker) => ({
      from: speaker.id,
      to: {
        ...this.identityIn(collection, speaker),
        id: randomUUID(),
        collection,
        createdBy: input.actor.principal,
        now: this.now(),
      },
    }));
  }

  /** The name shown today; the author link only if the new list has that author too. */
  private identityIn(collection: string, speaker: StoredSpeaker) {
    const { authorOf } = this.deps;
    const { name } = toCollectionSpeaker(speaker, authorOf);
    const { authorSlug } = speaker;
    const linked = authorSlug !== null && authorOf(collection, authorSlug);
    return {
      name,
      nameKey: speakerKeyOf(name),
      authorSlug: linked ? authorSlug : null,
    };
  }
}
