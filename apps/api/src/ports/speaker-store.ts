/** A speaker as stored (KBC-065); `name` is its own, the author's is read at display. */
export interface StoredSpeaker {
  readonly id: string;
  /** The top-level collection whose list it is in (BR-1). */
  readonly collection: string;
  readonly name: string;
  readonly authorSlug: string | null;
}

export interface NewSpeaker extends StoredSpeaker {
  /** `speakerKeyOf(name)`: one speaker per key in a collection. */
  readonly nameKey: string;
  readonly createdBy: string;
  readonly now: Date;
}

/** One speaker of an item moved between collections, and who they are in the new list. */
export interface SpeakerMove {
  readonly from: string;
  readonly to: NewSpeaker;
}

/** The speakers of each collection (ADR 0029 §2), in the media database. */
export interface SpeakerStorePort {
  list(collection: string): StoredSpeaker[];
  get(id: string): StoredSpeaker | null;
  /**
   * Registers a speaker, or returns the one that author, or else that name, already is; asked
   * with an author, an unlinked speaker of that name gets linked.
   */
  add(speaker: NewSpeaker): {
    readonly speaker: StoredSpeaker;
    readonly created: boolean;
  };
  /** The speakers named in any separation of this item (KBC-050). */
  labelled(mediaId: string): StoredSpeaker[];
  /**
   * The item's voices now name each move's speaker, found or added in the new list, with
   * `alongside` in the same transaction: it must write to this same media database.
   */
  rehome<T>(input: {
    readonly mediaId: string;
    readonly moves: readonly SpeakerMove[];
    readonly alongside: () => T;
  }): T;
  /** Renames and links; false when another speaker has that name or author. */
  update(change: {
    readonly id: string;
    readonly name: string;
    readonly nameKey: string;
    readonly authorSlug: string | null;
    readonly now: Date;
  }): boolean;
}

/** Who one voice of a separation is, as stored (ADR 0029 §2). */
export interface StoredVoiceLabel {
  readonly voice: number;
  readonly speaker: StoredSpeaker | null;
  readonly audience: boolean;
  /** Joined to that voice (FR-2); `speaker` and `audience` stay for the undo. */
  readonly mergedInto: number | null;
}

/** The names of the voices of a separation; each change is one transaction. */
export interface VoiceLabelStorePort {
  labels(diarizationId: string): StoredVoiceLabel[];
  setLabel(input: {
    readonly diarizationId: string;
    readonly voice: number;
    readonly speakerId: string | null;
    readonly audience: boolean;
  }): void;
  /**
   * `voice` becomes part of `into`, and whatever had joined `voice` too; `into` takes
   * `voice`'s name when it has none, until the join is undone.
   */
  merge(input: {
    readonly diarizationId: string;
    readonly voice: number;
    readonly into: number;
  }): void;
  /** Undoes the join of `voice`, and takes back the name it had lent. */
  split(input: {
    readonly diarizationId: string;
    readonly voice: number;
  }): void;
  /** "Confirmar nomes" (BR-5). */
  confirmNames(diarizationId: string): void;
}
