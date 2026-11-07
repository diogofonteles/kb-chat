import type {
  AnswerMedia,
  AnswerSource,
  Authorship,
  DocumentRef,
} from '@kb-chat/contracts';
import type { CatalogMedia } from '../catalog/index.js';

/** A document as the tools meet it: catalog entries and hits carry their authorship (KBC-020). */
export interface SourceRef extends DocumentRef {
  readonly authorship?: Authorship;
  readonly author?: string | null;
  /** A track of the collection (KBC-099): its citations carry a passage. */
  readonly media?: CatalogMedia | null;
}

/** What the tools showed of one track source this turn (ADR 0035 §6, BR-5). */
export interface ShownPassages {
  /** Every anchor shown, in seconds on the track's clock. */
  readonly anchors: ReadonlySet<number>;
  /** The passage the tools showed last; null while only the title was. */
  readonly last: number | null;
}

const toAnswerMedia = (media: CatalogMedia): AnswerMedia => ({
  mediaId: media.mediaId,
  kind: media.kind,
  recordingTitle: media.recordingTitle,
  ...(media.ordinal ? { ordinal: media.ordinal } : {}),
  ...(media.total ? { total: media.total } : {}),
  durationMs: media.durationMs,
  confidence: media.confidence,
});

/**
 * Numbers every document the agent meets during one turn (ADR 0006): the first time a
 * document shows up it gets the next n, and keeps it for the rest of the turn, so [n] in
 * tool outputs and in the answer always points to the same source.
 */
export class SourceBook {
  private readonly byId = new Map<string, AnswerSource>();
  private readonly byNumber = new Map<number, AnswerSource>();
  private readonly shown = new Map<
    number,
    { anchors: Set<number>; last: number | null }
  >();

  number(ref: SourceRef): number {
    const known = this.byId.get(ref.id);
    if (known) return known.n;
    const source: AnswerSource = {
      n: this.byId.size + 1,
      id: ref.id,
      title: ref.title,
      ...(ref.authorship ? { authorship: ref.authorship } : {}),
      ...(ref.author ? { author: ref.author } : {}),
      ...(ref.media ? { media: toAnswerMedia(ref.media) } : {}),
    };
    this.byId.set(ref.id, source);
    this.byNumber.set(source.n, source);
    return source.n;
  }

  /**
   * A track's text shown to the model: its anchors may be cited, and `focus` (the passage
   * the call was about: a read's match, an occurrence, a hit) becomes the last one shown.
   */
  showTrack(
    n: number,
    { anchors, focus }: { anchors: readonly number[]; focus: number | null },
  ): void {
    if (!this.byNumber.get(n)?.media) return;
    const memory = this.shown.get(n) ?? {
      anchors: new Set<number>(),
      last: null,
    };
    for (const anchor of anchors) memory.anchors.add(anchor);
    if (focus !== null) memory.anchors.add(focus);
    memory.last = focus ?? anchors[0] ?? memory.last;
    this.shown.set(n, memory);
  }

  /** What the tools showed of a track source; undefined for a text or an unseen track. */
  shownOf(n: number): ShownPassages | undefined {
    return this.shown.get(n);
  }

  find(n: number): AnswerSource | undefined {
    return this.byNumber.get(n);
  }

  findById(id: string): AnswerSource | undefined {
    return this.byId.get(id);
  }

  get size(): number {
    return this.byId.size;
  }

  list(): AnswerSource[] {
    return [...this.byId.values()].map((source) => ({ ...source }));
  }
}
