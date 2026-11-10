import { randomUUID } from 'node:crypto';
import {
  speakerKeyOf,
  type Author,
  type UpdateMediaRequest,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type {
  MediaEdit,
  MediaRecord,
  MediaStorePort,
} from '../../ports/media-store.js';
import type {
  SpeakerMove,
  SpeakerStorePort,
  StoredSpeaker,
} from '../../ports/speaker-store.js';
import type { LevelAuditPort } from '../../ports/level-audit.js';
import {
  NO_LEVELS,
  chosenLevel,
  type MediaActor,
  type MediaLevels,
} from './media-service.js';
import { canEditMedia, legacyAuthorshipOf, seesMedia } from './media-policy.js';
import { toCollectionSpeaker } from './voice-labels.js';

export interface MediaEditServiceDeps {
  readonly store: Pick<MediaStorePort, 'getMedia' | 'editMedia'>;
  readonly speakers: Pick<SpeakerStorePort, 'labelled' | 'rehome'>;
  /** The collection exists in the vault (a master "sees" any slug, even a wrong one). */
  readonly hasTopic: (topic: string) => boolean;
  /** The top-level collection whose author and speaker lists a collection uses. */
  readonly rootOf: (topic: string) => string;
  readonly authorOf: (topic: string, slug: string) => Author | null;
  /** The recording changed: its tracks follow, in the same transaction on a move (KBC-068 BR-2). */
  readonly onEdited?: (mediaId: string) => void;
  /** The collections' scales (KBC-105); none: no collection has levels. */
  readonly levels?: MediaLevels;
  /** Where a level change is recorded (ADR 0036 §11); required once levels exist. */
  readonly audit?: LevelAuditPort;
  readonly now?: () => Date;
}

/** Who edits, as the levels audit names them: the master, and the person they act as. */
export interface EditAuthor {
  readonly by: string;
  readonly actingAs?: string;
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

  /** One edit of a recording: who asks, which, and who the audit names (ADR 0027). */
  async edit(
    call: {
      readonly actor: MediaActor;
      readonly mediaId: string;
      readonly by?: EditAuthor;
    },
    request: UpdateMediaRequest,
  ): Promise<void> {
    const { actor, mediaId } = call;
    const media = this.editable(actor, mediaId);
    const topic = this.destinationOf(actor, media, request.topic);
    const edit: MediaEdit = {
      mediaId,
      title: request.title ?? media.title,
      topic,
      ...this.authorship(media, topic, request.author),
      level: this.levelAfter(actor, { media, topic, asked: request.level }),
      now: this.now(),
    };
    const tracks = this.save(actor, media, edit);
    if (edit.level !== media.level)
      await this.recordLevel(call.by ?? { by: actor.principal }, {
        topic,
        mediaId,
        before: media.level,
        after: edit.level,
        tracks,
      });
  }

  /** The recording, when this person may see and edit it. */
  private editable(actor: MediaActor, mediaId: string): MediaRecord {
    const media = this.deps.store.getMedia(mediaId);
    if (!media || !seesMedia(actor, media))
      throw new AppError('MEDIA_NOT_FOUND', 'Unknown media');
    if (!canEditMedia(actor, media))
      throw new AppError('FORBIDDEN', 'Only who sent it or a master may edit');
    return media;
  }

  private authorship(
    media: MediaRecord,
    topic: string,
    asked: string | null | undefined,
  ) {
    const author = this.authorAfter(media, topic, asked);
    return { author, legacyAuthorship: legacyAuthorshipOf(author) };
  }

  /** Writes the edit, the speakers following a move; how many tracks changed level. */
  private save(actor: MediaActor, media: MediaRecord, edit: MediaEdit): number {
    let tracks = 0;
    const write = () => {
      tracks = this.deps.store.editMedia(edit)?.tracksRelevelled ?? 0;
      this.deps.onEdited?.(edit.mediaId);
    };
    const { mediaId, topic } = edit;
    if (this.sameLists(media.topic, topic)) write();
    else
      this.deps.speakers.rehome({
        mediaId,
        moves: this.movesOf({ mediaId, from: media.topic, to: topic, actor }),
        alongside: write,
      });
    return tracks;
  }

  /**
   * BR-3, BR-4: the level the audio holds after the edit. A collection without levels holds
   * none; another top-level collection with levels needs one of its own; otherwise the asked
   * one (never above the person's), or the one it had.
   */
  private levelAfter(
    actor: MediaActor,
    edit: {
      readonly media: MediaRecord;
      readonly topic: string;
      readonly asked: string | undefined;
    },
  ): string | null {
    const { media, topic, asked } = edit;
    const scale = (this.deps.levels ?? NO_LEVELS).scaleOf(topic);
    const moved = !this.sameLists(media.topic, topic);
    if (scale.length === 0 || asked !== undefined || moved)
      return chosenLevel(actor, { topic, scale, asked });
    return media.level;
  }

  /** ADR 0036 §11: before → after, with the recording and the tracks that followed it. */
  private async recordLevel(
    by: EditAuthor,
    change: {
      readonly topic: string;
      readonly mediaId: string;
      readonly before: string | null;
      readonly after: string | null;
      readonly tracks: number;
    },
  ): Promise<void> {
    const { audit } = this.deps;
    if (!audit) throw new Error('A level changed with no audit to record it');
    await audit.append({
      at: this.now().toISOString(),
      by: by.by,
      ...(by.actingAs && { actingAs: by.actingAs }),
      kind: 'item.level',
      collection: change.topic,
      target: change.mediaId,
      before: change.before,
      after: change.after,
      count: { recordings: 1, tracks: change.tracks },
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
