import type { SourceBook } from '../source-book.js';
import type { SweepPlanner } from './sweep-planner.js';

/** What a subscription CLI's exhaustive turn needs to sweep with the tools' numbering. */
export interface SweepKit {
  readonly sweeps: SweepPlanner;
  readonly book: SourceBook;
  readonly topicTitle: string;
  /** The collection's main author (KBC-049), or null. */
  readonly mainAuthor: string | null;
}
