import { randomUUID } from 'node:crypto';
import {
  speakerKeyOf,
  type CollectionSpeaker,
  type CollectionSpeakerCreate,
  type CollectionSpeakerUpdate,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type {
  SpeakerStorePort,
  StoredSpeaker,
} from '../../ports/speaker-store.js';
import { toCollectionSpeaker, type AuthorLookup } from './voice-labels.js';

export interface SpeakersServiceDeps {
  /** A speaker's name changed: the collection's documents follow (KBC-100 FR-1). */
  readonly onRenamed?: (collection: string) => void;
  readonly speakers: SpeakerStorePort;
  /** The top-level collection whose lists a collection uses (BR-1). */
  readonly rootOf: (topic: string) => string;
  readonly authorOf: AuthorLookup;
  readonly now?: () => Date;
}

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base' });

const unknownAuthor = () =>
  new AppError('VALIDATION_FAILED', 'Unknown author', {
    details: { field: 'authorSlug' },
  });

/**
 * The people named in a collection's recordings (KBC-065 FR-1, ADR 0029 §2): one list per
 * top-level collection, as authors. The rules on who may change it are in the routes.
 */
export class SpeakersService {
  private readonly now: () => Date;

  constructor(private readonly deps: SpeakersServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** By name, as shown. */
  list(topic: string): CollectionSpeaker[] {
    return this.deps.speakers
      .list(this.deps.rootOf(topic))
      .map((speaker) => this.toView(speaker))
      .sort((a, b) => collator.compare(a.name, b.name));
  }

  /** Registers a name, or returns the speaker it (or its author) already is. */
  add(
    topic: string,
    input: CollectionSpeakerCreate,
    by: string,
  ): { readonly speaker: CollectionSpeaker; readonly created: boolean } {
    const collection = this.deps.rootOf(topic);
    const authorSlug = input.authorSlug ?? null;
    this.assertAuthor(collection, authorSlug);
    const { speaker, created } = this.deps.speakers.add({
      id: randomUUID(),
      collection,
      name: input.name,
      nameKey: speakerKeyOf(input.name),
      authorSlug,
      createdBy: by,
      now: this.now(),
    });
    if (authorSlug !== null && speaker.authorSlug !== authorSlug)
      throw new AppError('MEDIA_CONFLICT', 'Another speaker has that name');
    return { speaker: this.toView(speaker), created };
  }

  /** Renames; `authorSlug` also links or unlinks, and left out keeps the link. */
  update(
    topic: string,
    id: string,
    input: CollectionSpeakerUpdate,
  ): CollectionSpeaker {
    const collection = this.deps.rootOf(topic);
    const current = this.deps.speakers.get(id);
    if (current?.collection !== collection)
      throw new AppError('NOT_FOUND', 'Unknown speaker');
    const authorSlug =
      input.authorSlug === undefined ? current.authorSlug : input.authorSlug;
    this.assertAuthor(collection, authorSlug);
    const saved = this.deps.speakers.update({
      id,
      name: input.name,
      nameKey: speakerKeyOf(input.name),
      authorSlug,
      now: this.now(),
    });
    if (!saved)
      throw new AppError('MEDIA_CONFLICT', 'Another speaker has that name');
    this.deps.onRenamed?.(collection);
    return this.toView({ ...current, name: input.name, authorSlug });
  }

  private assertAuthor(collection: string, slug: string | null): void {
    if (slug !== null && !this.deps.authorOf(collection, slug))
      throw unknownAuthor();
  }

  private toView(speaker: StoredSpeaker): CollectionSpeaker {
    return toCollectionSpeaker(speaker, this.deps.authorOf);
  }
}
