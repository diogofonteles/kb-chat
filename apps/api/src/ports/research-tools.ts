import type { AnswerSource, ResearchStep } from '@kb-chat/contracts';
import type { ToolDefinition } from './llm.js';

/** What one tool call produced: the text the model reads, the step shown and the sources so far. */
export interface ResearchToolResult {
  readonly text: string;
  /** The step shown to the reader; null when the call was refused (invalid arguments). */
  readonly step: ResearchStep | null;
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
}

/** A fresh tool set per turn: each turn numbers its own sources. */
export type ResearchToolsFactory = (topic: string) => ResearchToolsPort;
