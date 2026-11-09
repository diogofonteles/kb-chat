import type { TrackShelf } from '../../../ports/track-shelf.js';
import type { MainAuthorIdentity } from '../prompt.js';
import type { SourceBook } from '../source-book.js';
import type { SweepPlanner } from './sweep-planner.js';

/** What a subscription CLI's exhaustive turn needs to sweep with the tools' numbering. */
export interface SweepKit {
  readonly sweeps: SweepPlanner;
  readonly book: SourceBook;
  readonly topicTitle: string;
  /** The collection's main author (KBC-049), or null. */
  readonly mainAuthor: MainAuthorIdentity | null;
  /** The tracks this turn may research (KBC-099 BR-4): the sweep reads them too (KBC-101). */
  readonly tracks?: TrackShelf;
}
