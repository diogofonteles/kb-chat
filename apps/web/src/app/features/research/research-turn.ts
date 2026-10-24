import {
  MAX_HISTORY_TURNS,
  type AnswerSource,
  type ResearchBilling,
  type ResearchEvent,
  type ResearchStep,
  type ResearchTurn as HistoryTurn,
  type SavedResearchTurn,
} from '@kb-chat/contracts';
import {
  toResearchErrorCode,
  type ResearchErrorCode,
} from './research-errors.js';

/** One question and the agent's answer, as shown in the "Pesquisa com IA" thread. */
export interface ResearchTurn {
  readonly id: number;
  readonly question: string;
  readonly phase: 'streaming' | 'done' | 'error';
  readonly text: string;
  /** Every document the agent read, numbered; [n] in the text points to one of them. */
  readonly sources: readonly AnswerSource[];
  /** What the agent did, live; a restored turn only keeps the count. */
  readonly steps: readonly ResearchStep[];
  readonly stepCount: number;
  readonly usd: number | null;
  /** A subscription turn shows "Incluído na sua assinatura" instead of a cost (KBC-007 BR-2). */
  readonly billing: ResearchBilling;
  readonly model: string;
  readonly interrupted: boolean;
  readonly error: ResearchErrorCode | null;
  readonly at: string;
  /** Brought back from the history (FR-6): shown as saved, never announced or re-run. */
  readonly restored: boolean;
}

export function startTurn(id: number, question: string): ResearchTurn {
  return {
    id,
    question,
    phase: 'streaming',
    text: '',
    sources: [],
    steps: [],
    stepCount: 0,
    usd: null,
    billing: 'per-token',
    model: '',
    interrupted: false,
    error: null,
    at: new Date().toISOString(),
    restored: false,
  };
}

const HANDLERS: {
  [K in ResearchEvent['type']]: (
    turn: ResearchTurn,
    e: Extract<ResearchEvent, { type: K }>,
  ) => ResearchTurn;
} = {
  step: (turn, e) => ({
    ...turn,
    steps: [...turn.steps, e.step],
    stepCount: turn.stepCount + 1,
  }),
  sources: (turn, e) => ({ ...turn, sources: e.sources }),
  token: (turn, e) => ({ ...turn, text: turn.text + e.text }),
  // A finished answer without text is a provider failure, not an empty success.
  done: (turn, e) => ({
    ...turn,
    phase: turn.text.trim() || e.interrupted ? 'done' : 'error',
    error: turn.text.trim() || e.interrupted ? null : 'INTERNAL',
    usd: e.usd,
    billing: e.billing,
    model: e.model,
    interrupted: e.interrupted,
    stepCount: Math.max(turn.stepCount, e.steps),
  }),
  error: (turn, e) => ({
    ...turn,
    phase: 'error',
    error: toResearchErrorCode(e.code),
  }),
};

export function applyEvent(
  turn: ResearchTurn,
  event: ResearchEvent,
): ResearchTurn {
  const handler = HANDLERS[event.type] as (
    turn: ResearchTurn,
    e: ResearchEvent,
  ) => ResearchTurn;
  return handler(turn, event);
}

/** A turn that ended with text: it is context for follow-ups and goes to the history. */
export const isFinished = (turn: ResearchTurn): boolean =>
  turn.phase === 'done' && turn.text.trim().length > 0;

const MAX_ANSWER_CHARS = 20_000;

/** The previous questions and answers (text only, BR-4), the most recent ones within the cap. */
export function toHistory(turns: readonly ResearchTurn[]): HistoryTurn[] {
  return turns
    .filter(isFinished)
    .slice(-MAX_HISTORY_TURNS)
    .map(({ question, text }) => ({
      question,
      answer: text.slice(0, MAX_ANSWER_CHARS),
    }));
}

/** Only the sources the answer cites with [n], in their numbering order. */
export function citedSources(turn: ResearchTurn): AnswerSource[] {
  const cited = new Set(
    [...turn.text.matchAll(/\[(\d{1,2})\]/g)].map((match) => Number(match[1])),
  );
  return turn.sources.filter((source) => cited.has(source.n));
}

export function toSavedTurn(turn: ResearchTurn): SavedResearchTurn {
  return {
    question: turn.question,
    answer: turn.text,
    sources: [...turn.sources],
    steps: turn.stepCount,
    usd: turn.usd ?? 0,
    billing: turn.billing,
    model: turn.model,
    interrupted: turn.interrupted,
    at: turn.at,
  };
}

export function fromSavedTurn(
  id: number,
  saved: SavedResearchTurn,
): ResearchTurn {
  return {
    id,
    question: saved.question,
    phase: 'done',
    text: saved.answer,
    sources: saved.sources,
    steps: [],
    stepCount: saved.steps,
    usd: saved.usd,
    billing: saved.billing,
    model: saved.model,
    interrupted: saved.interrupted,
    error: null,
    at: saved.at,
    restored: true,
  };
}
