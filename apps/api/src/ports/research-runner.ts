import type {
  ResearchEvent,
  ResearchProfile,
  ResearchTurn,
} from '@kb-chat/contracts';
import type { AgentLlmPort } from './llm.js';

export interface ResearchInput {
  readonly topic: string;
  readonly question: string;
  readonly history: readonly ResearchTurn[];
  /** Step budget and prompt of the turn (KBC-011); the model was chosen with the runner. */
  readonly profile: ResearchProfile;
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

/** Whose spend a per-token turn checks and records, with the cap read on every check. */
export interface SpendScope {
  readonly principal: string;
  readonly dailyCapUsd: () => number;
}

/** The deep profile a fast turn may escalate to (ADR 0009). */
export interface Escalation<T> {
  /** The deep model (a per-token adapter, or a CLI model id). */
  readonly deep: T;
  /** Read on every turn: Settings' "Aprofundar automaticamente". */
  readonly enabled: () => boolean;
}

/** Builds the in-API tool loop (KBC-008) over a per-token model. */
export type PerTokenRunnerFactory = (
  llm: AgentLlmPort,
  scope: SpendScope,
  escalation?: Escalation<AgentLlmPort>,
) => ResearchRunnerPort;
