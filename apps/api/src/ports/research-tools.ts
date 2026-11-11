import type { AnswerSource, ResearchStep } from '@kb-chat/contracts';
import type { ToolDefinition } from './llm.js';
import type { LevelView } from './level-view.js';
import type { TrackShelf } from './track-shelf.js';

/** What one tool call produced: the text the model reads, the step shown and the sources so far. */
export interface ResearchToolResult {
  readonly text: string;
  /** The steps shown to the reader (one per document read); none when the call was refused. */
  readonly steps: readonly ResearchStep[];
  /** Every document numbered in this turn so far ([n] points to sources[n - 1]). */
  readonly sources: readonly AnswerSource[];
}

/**
 * The research tools of one turn (ADR 0006), bound to a topic and to the turn's source
 * numbering. The in-API loop and the MCP server (ADR 0007) call the same implementation.
 */
export interface ResearchToolsPort {
  definitions(): readonly ToolDefinition[];
  /** Runs a tool; `args` is the parsed JSON the model wrote. Unknown tools reject. */
  call(name: string, args: unknown): Promise<ResearchToolResult>;
  /**
   * The sources once the answer is written, each cited track with its passages (KBC-099
   * FR-6); null when nothing changed.
   */
  finalSources?(answer: string): readonly AnswerSource[] | null;
}

/**
 * A fresh tool set per turn: each turn numbers its own sources. `view` is the person's view
 * of the collection (ADR 0036 §7, KBC-104): the tools, and an external model over the turn's
 * MCP token, reach only what it allows; `tracks`, the tracks the person may research.
 */
export type ResearchToolsFactory = (
  topic: string,
  view: LevelView,
  tracks?: TrackShelf,
) => ResearchToolsPort;
