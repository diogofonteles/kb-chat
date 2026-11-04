import { randomUUID } from 'node:crypto';
import {
  MAX_TRACK_SUBJECTS,
  subjectKey,
  type CollectionSubjects,
  decideSuggestionsRequestSchema,
  type FreeSubject,
  type MediaItem,
  type SubjectRef,
  type TrackSubject,
  type TrackSubjects,
} from '@kb-chat/contracts';
import type { z } from 'zod';
import { AppError } from '../../app-error.js';
import type { MediaStorePort } from '../../ports/media-store.js';
import type {
  LinkTarget,
  StoredLink,
  StoredTrackSubjects,
  TrackSubjectStorePort,
} from '../../ports/track-subject-store.js';
import type { MediaActor } from '../media/index.js';

/** A track as a list shows it; a track that left the approved ones has no place. */
interface TrackRow {
  readonly mediaId: string;
  readonly title: string;
  readonly ordinal: number | null;
}

export interface TrackSubjectServiceDeps {
  readonly store: TrackSubjectStorePort;
  readonly media: {
    getMedia(
      id: string,
    ): Pick<
      NonNullable<ReturnType<MediaStorePort['getMedia']>>,
      'id' | 'topic' | 'title' | 'track' | 'archivedAt'
    > | null;
  };
  readonly items: { tracksOf(parentId: string): readonly TrackRow[] };
  /** The recording as this person sees it; throws MEDIA_NOT_FOUND when they cannot. */
  readonly findMedia: (actor: MediaActor, mediaId: string) => MediaItem;
  /** The top-level collection, whose concepts and subjects a sub-collection uses (BR-1). */
  readonly rootOf: (topic: string) => string;
  /** The concept names of a collection in the catalog as it stands now (FR-5). */
  readonly conceptsOf: (collection: string) => readonly string[];
  readonly now?: () => Date;
}

/** A write to a track's subjects: who, on what, from which version. */
export interface SubjectCall {
  readonly actor: MediaActor;
  readonly mediaId: string;
  readonly expectedVersion: number;
}

export type DecideSuggestions = z.output<typeof decideSuggestionsRequestSchema>;

const stale = () =>
  new AppError('EDIT_STALE', 'Someone else changed these subjects');

const notFound = () => new AppError('MEDIA_NOT_FOUND', 'Unknown track');

const unknownSubject = () =>
  new AppError('VALIDATION_FAILED', 'Unknown subject', {
    details: { field: 'subjects' },
  });

const tooMany = () =>
  new AppError('VALIDATION_FAILED', 'Too many subjects', {
    details: { field: 'subjects' },
  });

const repeated = () =>
  new AppError('MEDIA_CONFLICT', 'This subject already exists', {
    details: { reason: 'duplicate-subject' },
  });

/**
 * What a track is about (KBC-069, ADR 0029 §6). Reads ask the catalog as it stands: a concept
 * that left is flagged, its link kept, and comes back by itself (BR-4, FR-5). Nothing here
 * reaches the vault (Q7).
 */
export class TrackSubjectService {
  private readonly now: () => Date;

  constructor(private readonly deps: TrackSubjectServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Everything a track of this collection can link to (FR-1). */
  collection(topic: string): CollectionSubjects {
    const root = this.deps.rootOf(topic);
    return {
      concepts: [...this.deps.conceptsOf(root)],
      free: this.deps.store.freeSubjects(root),
    };
  }

  /** A new free subject; a name a free subject or a concept already has is refused (AC-4). */
  createFree(actor: MediaActor, topic: string, name: string): FreeSubject {
    const key = subjectKey(name);
    const { concepts } = this.collection(topic);
    if (concepts.some((concept) => subjectKey(concept) === key))
      throw repeated();
    const subject = { id: randomUUID(), name };
    const created = this.deps.store.createFree({
      ...subject,
      key,
      collection: this.deps.rootOf(topic),
      by: actor.principal,
      now: this.now(),
    });
    if (!created) throw repeated();
    return subject;
  }

  read(actor: MediaActor, trackId: string): TrackSubjects {
    const track = this.track(actor, trackId);
    return this.shownOne(track.topic, this.rowOf(track));
  }

  /**
   * The approved row: a track being cut has no place yet on its `media` row, and a new title
   * reaches that row only when published. One that left the approved tracks has neither.
   */
  private rowOf(track: {
    readonly id: string;
    readonly title: string;
    readonly ordinal: number | null;
    readonly parentId: string;
  }): TrackRow {
    const approved = this.deps.items
      .tracksOf(track.parentId)
      .find((one) => one.mediaId === track.id);
    return (
      approved ?? {
        mediaId: track.id,
        title: track.title,
        ordinal: track.ordinal,
      }
    );
  }

  private shownOne(topic: string, row: TrackRow): TrackSubjects {
    const [track] = this.shown(topic, [row]);
    if (!track) throw notFound();
    return track;
  }

  /** The approved tracks of a recording, as step 4 lists them. */
  tracksOf(recording: Pick<MediaItem, 'id' | 'topic'>): TrackSubjects[] {
    return this.shown(recording.topic, this.deps.items.tracksOf(recording.id));
  }

  /** FR-2: the whole accepted list. A subject already linked stays even when it left (BR-4). */
  save(
    call: SubjectCall,
    request: {
      readonly subjects: readonly SubjectRef[];
      readonly summary: string | null;
    },
  ): TrackSubjects {
    const track = this.writable(call);
    const [stored] = this.deps.store.read([track.id]);
    const accepted = this.targetsOf(track.topic, {
      refs: request.subjects,
      linked: stored?.links ?? [],
    });
    if (accepted.length > MAX_TRACK_SUBJECTS) throw tooMany();
    this.written(
      this.deps.store.save({
        ...this.writeOf(call),
        accepted,
        summary: request.summary,
      }),
    );
    return this.read(call.actor, call.mediaId);
  }

  /** "Aceitar" and "Recusar" (FR-4): only here does a suggestion start to count (BR-3). */
  decide(call: SubjectCall, request: DecideSuggestions): TrackSubjects {
    const track = this.writable(call);
    const [stored] = this.deps.store.read([track.id]);
    const links = stored?.links ?? [];
    const accepted = this.suggestionsOf(links, request.accept);
    this.suggestionsOf(links, request.refuse);
    const held = links.filter((link) => link.status === 'accepted').length;
    if (held + accepted.length > MAX_TRACK_SUBJECTS) throw tooMany();
    this.written(
      this.deps.store.decide({
        ...this.writeOf(call),
        accept: accepted.map((link) => this.decisionOn(track.topic, link)),
        refuse: request.refuse,
        summary: request.summary,
      }),
    );
    return this.read(call.actor, call.mediaId);
  }

  private decisionOn(topic: string, link: StoredLink) {
    if (link.kind !== 'new') return { linkId: link.id, creates: null };
    return {
      linkId: link.id,
      creates: {
        id: randomUUID(),
        collection: this.deps.rootOf(topic),
        name: link.name,
        key: subjectKey(link.name),
      },
    };
  }

  private suggestionsOf(
    links: readonly StoredLink[],
    ids: readonly string[],
  ): StoredLink[] {
    return ids.map((id) => {
      const link = links.find(
        (one) => one.id === id && one.status === 'suggested',
      );
      if (!link) throw unknownSubject();
      return link;
    });
  }

  private shown(topic: string, tracks: readonly TrackRow[]): TrackSubjects[] {
    const present = this.presence(topic);
    const stored = new Map(
      this.deps.store
        .read(tracks.map((track) => track.mediaId))
        .map((one) => [one.mediaId, one]),
    );
    return tracks.map((track) =>
      toTrackSubjects(track, stored.get(track.mediaId), present),
    );
  }

  /** Whether a link's subject is in the recording's collection now (BR-4). */
  private presence(topic: string): (link: StoredLink) => boolean {
    const root = this.deps.rootOf(topic);
    const concepts = new Set(this.deps.conceptsOf(root).map(subjectKey));
    return (link) =>
      link.kind === 'concept'
        ? concepts.has(subjectKey(link.name))
        : link.collection === root;
  }

  private targetsOf(
    topic: string,
    input: {
      readonly refs: readonly SubjectRef[];
      readonly linked: readonly StoredLink[];
    },
  ): LinkTarget[] {
    const root = this.deps.rootOf(topic);
    const concepts = new Map(
      this.deps.conceptsOf(root).map((name) => [subjectKey(name), name]),
    );
    const linked = new Map(
      input.linked
        .filter((link) => link.kind === 'concept')
        .map((link) => [subjectKey(link.name), link.name]),
    );
    const targets = input.refs.map((ref): LinkTarget => {
      if (ref.kind === 'free')
        return this.freeTarget(ref.id, input.linked, root);
      const key = subjectKey(ref.name);
      const name = linked.get(key) ?? concepts.get(key);
      if (name === undefined) throw unknownSubject();
      return { kind: 'concept', name };
    });
    return unique(targets);
  }

  private freeTarget(
    id: string,
    linked: readonly StoredLink[],
    root: string,
  ): LinkTarget {
    const held = linked.some((link) => link.freeId === id);
    if (!held && this.deps.store.freeSubject(id)?.collection !== root)
      throw unknownSubject();
    return { kind: 'free', id };
  }

  /** A track of a recording this person can see, published or still being cut. */
  private track(actor: MediaActor, trackId: string) {
    const record = this.deps.media.getMedia(trackId);
    if (!record) throw notFound();
    if (!record.track)
      throw new AppError('MEDIA_CONFLICT', 'Subjects belong to tracks', {
        details: { reason: 'not-a-track' },
      });
    this.deps.findMedia(actor, record.track.parentId);
    return {
      ...record,
      ordinal: record.track.ordinal,
      parentId: record.track.parentId,
    };
  }

  private writable(call: SubjectCall) {
    const track = this.track(call.actor, call.mediaId);
    if (track.archivedAt !== null) throw notFound();
    return track;
  }

  private writeOf(call: SubjectCall) {
    return {
      mediaId: call.mediaId,
      expectedVersion: call.expectedVersion,
      principal: call.actor.principal,
      now: this.now(),
    };
  }

  private written(version: number | null): void {
    if (version === null) throw stale();
  }
}

const targetKey = (target: LinkTarget): string =>
  target.kind === 'free' ? target.id : subjectKey(target.name);

const unique = (targets: readonly LinkTarget[]): LinkTarget[] => [
  ...new Map(targets.map((one) => [targetKey(one), one])).values(),
];

function toTrackSubjects(
  track: TrackRow,
  stored: StoredTrackSubjects | undefined,
  present: (link: StoredLink) => boolean,
): TrackSubjects {
  const links = stored?.links ?? [];
  return {
    mediaId: track.mediaId,
    title: track.title,
    ordinal: track.ordinal,
    version: stored?.version ?? 0,
    summary: stored?.summary ?? null,
    subjects: links
      .filter((link) => link.status === 'accepted')
      .map((link) => toSubject(link, !present(link))),
    suggestions: links
      .filter((link) => link.status === 'suggested')
      .map(({ id, kind, name }) => ({ id, kind, name })),
    suggestedSummary: stored?.suggestedSummary ?? null,
  };
}

const toSubject = (link: StoredLink, missing: boolean): TrackSubject => ({
  kind: link.kind === 'concept' ? 'concept' : 'free',
  name: link.name,
  id: link.freeId,
  missing,
});
