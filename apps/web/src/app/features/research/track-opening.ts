import type { AnswerSource } from '@kb-chat/contracts';
import { formatClock } from '@kb-chat/player-core';

/** A cited track opened from the answer (KBC-099, T22): which passage, and from where. */
export interface TrackOpening {
  readonly source: AnswerSource;
  /** The time the citation wrote ("0:41"); "" for a plain [n] or the chip. */
  readonly at: string;
  /** What gets the focus back when the panel closes (AC-12). */
  readonly trigger: HTMLElement | null;
  /**
   * The answer's cited sources, texts and tracks in [n] order, for "Fonte n de N" and ‹ ›
   * (KBC-150); absent for a search result.
   */
  readonly sources?: readonly AnswerSource[];
  /** The answer's question: a text source opened from ‹ › highlights it. */
  readonly question?: string;
}

/** "Palestra de 12/03/2017 · 0:41 · +2 trechos": what a track's chip says after its title. */
export interface TrackChip {
  readonly recording: string;
  readonly clock: string;
  readonly more: number;
}

export function trackChipOf(source: AnswerSource): TrackChip | null {
  if (!source.media) return null;
  const passages = source.passages ?? [];
  const [first] = passages;
  return {
    recording: source.media.recordingTitle,
    clock: first ? formatClock(first.startMs) : '',
    more: Math.max(0, passages.length - 1),
  };
}
