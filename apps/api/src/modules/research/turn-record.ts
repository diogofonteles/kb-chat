import type {
  ResearchEvent,
  ResearchProfile,
  SavedResearchTurn,
} from '@kb-chat/contracts';

/** What the server knows of a turn when it starts (KBC-029). */
export interface TurnStart {
  readonly id: string;
  readonly question: string;
  readonly profile: ResearchProfile;
  readonly at: string;
}

/** The turn as the history keeps it while the agent works. */
export function pendingTurn(start: TurnStart): SavedResearchTurn {
  return {
    id: start.id,
    question: start.question,
    answer: '',
    sources: [],
    steps: 0,
    usd: 0,
    billing: 'per-token',
    model: '',
    interrupted: false,
    profile: start.profile,
    status: 'pending',
    at: start.at,
  };
}

/** A turn that ended carries no status (see `savedResearchTurnSchema`). */
export function withoutStatus(turn: SavedResearchTurn): SavedResearchTurn {
  const copy = { ...turn };
  delete copy.status;
  return copy;
}

interface Segment {
  readonly segment: number;
  readonly text: string;
}

interface Progress {
  readonly turn: SavedResearchTurn;
  readonly segments: readonly Segment[];
  readonly ended: boolean;
}

function appendToken(segments: readonly Segment[], e: Segment): Segment[] {
  const last = segments.at(-1);
  return last?.segment === e.segment
    ? [
        ...segments.slice(0, -1),
        { segment: e.segment, text: last.text + e.text },
      ]
    : [...segments, e];
}

const failed = (turn: SavedResearchTurn, error: string): SavedResearchTurn => ({
  ...turn,
  status: 'failed',
  error,
});

/** A finished turn: no status; with no text and not stopped, a provider failure. */
function finished(
  turn: SavedResearchTurn,
  e: Extract<ResearchEvent, { type: 'done' }>,
): SavedResearchTurn {
  const ended: SavedResearchTurn = {
    ...withoutStatus(turn),
    usd: e.usd,
    billing: e.billing,
    model: e.model,
    interrupted: e.interrupted,
    steps: Math.max(turn.steps, e.steps),
    ...(e.escalated ? { escalated: true } : {}),
    ...(e.plan ? { plan: e.plan } : {}),
  };
  return turn.answer.trim() || e.interrupted
    ? ended
    : failed(ended, 'INTERNAL');
}

const withTurn = (
  progress: Progress,
  change: Partial<SavedResearchTurn>,
): Progress => ({ ...progress, turn: { ...progress.turn, ...change } });

const withSegments = (progress: Progress, segments: Segment[]): Progress => ({
  ...withTurn(progress, { answer: segments.map((s) => s.text).join('') }),
  segments,
});

/** One reducer per event type, so a new type breaks the build (TS-10). */
const STEPS: {
  [K in ResearchEvent['type']]: (
    progress: Progress,
    e: Extract<ResearchEvent, { type: K }>,
  ) => Progress;
} = {
  start: (p, e) => withTurn(p, { model: e.model, billing: e.billing }),
  step: (p) => withTurn(p, { steps: p.turn.steps + 1 }),
  sources: (p, e) => withTurn(p, { sources: e.sources }),
  token: (p, e) => withSegments(p, appendToken(p.segments, e)),
  retract: (p, e) =>
    withSegments(
      p,
      p.segments.filter((s) => s.segment !== e.segment),
    ),
  done: (p, e) => ({ ...p, turn: finished(p.turn, e), ended: true }),
  error: (p, e) => ({ ...p, turn: failed(p.turn, e.code), ended: true }),
};

function apply(progress: Progress, event: ResearchEvent): Progress {
  if (progress.ended) return progress;
  const step = STEPS[event.type] as (p: Progress, e: ResearchEvent) => Progress;
  return step(progress, event);
}

/**
 * The turn the history keeps from the events the agent streamed (the page builds the same
 * from the same events). A stream that ended without `done` or `error` is interrupted with
 * text and failed without, as the page shows it.
 */
export function recordTurn(
  pending: SavedResearchTurn,
  events: readonly ResearchEvent[],
): SavedResearchTurn {
  const start: Progress = { turn: pending, segments: [], ended: false };
  const end = events.reduce(apply, start);
  if (end.ended) return end.turn;
  const turn = withoutStatus(end.turn);
  return turn.answer.trim()
    ? { ...turn, interrupted: true }
    : failed(end.turn, 'INTERNAL');
}
