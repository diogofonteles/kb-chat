import type { ResearchEvent, ResearchTurn } from '@kb-chat/contracts';

export interface ResearchInput {
  readonly topic: string;
  readonly question: string;
  readonly history: readonly ResearchTurn[];
  readonly signal: AbortSignal;
}

/**
 * Runs one research turn (ADR 0006) and streams its events. Two implementations:
 * the in-API tool loop over an AgentLlmPort (per-token providers) and Claude Code / Codex
 * driving the same tools over MCP (subscriptions, KBC-007).
 */
export interface ResearchRunnerPort {
  readonly model: string;
  readonly billing: 'per-token' | 'subscription';
  configured(): boolean;
  run(input: ResearchInput): AsyncIterable<ResearchEvent>;
}
