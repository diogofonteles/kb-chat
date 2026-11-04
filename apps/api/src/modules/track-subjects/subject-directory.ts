import {
  subjectKey,
  type HitSubject,
  type TrackAbout,
} from '@kb-chat/contracts';
import type {
  StoredLink,
  TrackSubjectStorePort,
} from '../../ports/track-subject-store.js';

export interface SubjectDirectoryDeps {
  readonly store: Pick<
    TrackSubjectStorePort,
    'read' | 'acceptedLinks' | 'freeSubjects'
  >;
  /** The top-level collection, whose concepts and subjects a sub-collection uses. */
  readonly rootOf: (topic: string) => string;
  /** The concept names of a collection in the catalog as it stands now. */
  readonly conceptsOf: (collection: string) => readonly string[];
}

/** A track, with the collection that says which subjects are in force. */
export interface PlacedTrack {
  readonly mediaId: string;
  readonly topic: string;
}

const conceptKeyOf = (name: string): string => `concept:${subjectKey(name)}`;
const freeKeyOf = (id: string): string => `free:${id}`;

const keyOfLink = (link: StoredLink): string =>
  link.kind === 'concept'
    ? conceptKeyOf(link.name)
    : freeKeyOf(link.freeId ?? '');

/**
 * Subjects as listeners read them (KBC-070): only accepted links, only of what the collection
 * has now. A concept that left the catalog, or a free subject of another collection, is not
 * told about; its link stays and comes back with it (ADR 0029 §6).
 */
export class SubjectDirectory {
  constructor(private readonly deps: SubjectDirectoryDeps) {}

  /** Every subject of the collection's tree, key → name. */
  namesIn(topic: string): ReadonlyMap<string, string> {
    const root = this.deps.rootOf(topic);
    return new Map([
      ...this.deps
        .conceptsOf(root)
        .map((name): [string, string] => [conceptKeyOf(name), name]),
      ...this.deps.store
        .freeSubjects(root)
        .map((one): [string, string] => [freeKeyOf(one.id), one.name]),
    ]);
  }

  /** The keys of these names; a name the collection does not have has none. */
  keysNamed(topic: string, names: readonly string[]): string[] {
    const wanted = new Set(names.map(subjectKey));
    return [...this.namesIn(topic)]
      .filter(([, name]) => wanted.has(subjectKey(name)))
      .map(([key]) => key);
  }

  /** Tracks with any of these subjects accepted: each once. */
  tracksLinkedTo(keys: readonly string[]): string[] {
    return [
      ...new Set(keys.flatMap((key) => this.deps.store.acceptedLinks(key))),
    ];
  }

  /** The accepted subjects each track shows, in the order they were linked. */
  shownOn(tracks: readonly PlacedTrack[]): ReadonlyMap<string, HitSubject[]> {
    const topics = new Map(tracks.map((one) => [one.mediaId, one.topic]));
    const names = new Map<string, ReadonlyMap<string, string>>();
    const namesOf = (topic: string) => {
      const root = this.deps.rootOf(topic);
      const known = names.get(root) ?? this.namesIn(topic);
      names.set(root, known);
      return known;
    };
    const stored = this.deps.store.read([...topics.keys()]);
    return new Map(
      stored.map((track) => [
        track.mediaId,
        acceptedOf(track.links, namesOf(topics.get(track.mediaId) ?? '')),
      ]),
    );
  }

  /** What the track's page says about it: the summary and the subjects. */
  about(track: PlacedTrack): TrackAbout {
    const [stored] = this.deps.store.read([track.mediaId]);
    return {
      subjects: this.shownOn([track]).get(track.mediaId) ?? [],
      summary: stored?.summary ?? null,
    };
  }
}

function acceptedOf(
  links: readonly StoredLink[],
  names: ReadonlyMap<string, string>,
): HitSubject[] {
  return links
    .filter((link) => link.status === 'accepted')
    .flatMap((link) => {
      const key = keyOfLink(link);
      const name = names.get(key);
      return name === undefined ? [] : [{ key, name }];
    });
}
