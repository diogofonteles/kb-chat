import {
  AUTHORSHIPS,
  mergeFindings,
  MAX_HISTORY_TURNS,
  type AnswerSource,
  type Authorship,
  type ResearchBilling,
  type ResearchEvent,
  type ResearchPlan,
  type ResearchProfile,
  type ResearchStep,
  type ResearchTurn as HistoryTurn,
  type SavedResearchTurn,
  type SweepCoverage,
  type SweepCursor,
  type SweepProgress,
} from '@kb-chat/contracts';
import {
  toResearchErrorCode,
  type ResearchErrorCode,
} from './research-errors.js';

/** Text the agent wrote before calling tools, moved from the answer into the steps (ADR 0009). */
export interface ThoughtStep {
  readonly kind: 'thought';
  readonly text: string;
}

/** A line of the steps list: a tool step, or the agent thinking aloud. */
export type TurnStep = ResearchStep | ThoughtStep;

/** Answer text from one model call; a retracted segment leaves the answer. */
export interface AnswerSegment {
  readonly segment: number;
  readonly text: string;
}

/** One question and the agent's answer, as shown in the "Pesquisa com IA" thread. */
export interface ResearchTurn {
  readonly id: number;
  /** The turn's id in the history (KBC-029); "Tentar de novo" keeps it. */
  readonly turnId: string;
  readonly question: string;
  readonly phase: 'streaming' | 'done' | 'error';
  /** The answer: the segments shown and not retracted, joined. */
  readonly text: string;
  readonly segments: readonly AnswerSegment[];
  /** Every document the agent read, numbered; [n] in the text points to one of them. */
  readonly sources: readonly AnswerSource[];
  /** What the agent did, live; a restored turn only keeps the count. */
  readonly steps: readonly TurnStep[];
  readonly stepCount: number;
  readonly usd: number | null;
  /** A subscription turn shows "Incluído na sua assinatura" instead of a cost (KBC-007 BR-2). */
  readonly billing: ResearchBilling;
  readonly model: string;
  readonly interrupted: boolean;
  /** The fast turn went on with the deep profile (ADR 0009). */
  readonly escalated: boolean;
  /** Who paid (KBC-022): the app's AI or the reader's own; null when unknown. */
  readonly plan: ResearchPlan | null;
  /** House plan: researches left today, from this turn's end; null otherwise. */
  readonly remaining: number | null;
  /** The profile it was asked with (KBC-017); null for turns saved before. */
  readonly profile: ResearchProfile | null;
  readonly error: ResearchErrorCode | null;
  /** HOUSE_QUOTA_EXHAUSTED: the person's researches a day, for the message (KBC-022). */
  readonly errorLimit: number | null;
  readonly at: string;
  /** Brought back from the history (FR-6): shown as saved, never announced or re-run. */
  readonly restored: boolean;
  /** The exhaustive sweep's estimate, then its progress, while it runs (KBC-030). */
  readonly sweep: SweepProgress | null;
  /** What the sweep covered, measured by the app. */
  readonly coverage: SweepCoverage | null;
  /** Where "Continuar varredura" resumes; null when the sweep covered its whole set. */
  readonly cursor: SweepCursor | null;
}

/**
 * The cursor of a sweep still running: the server's latest, with every finding the page
 * received so far, so a stop keeps them for "Continuar varredura" (KBC-030 QA F-1).
 */
function progressCursor(
  turn: ResearchTurn,
  progress: SweepProgress,
): SweepCursor | null {
  if (!progress.cursor) return turn.cursor;
  const findings = mergeFindings(
    turn.cursor?.findings ?? [],
    progress.found ?? [],
  );
  return { ...progress.cursor, findings };
}

/**
 * A turn ended well with text, when stopped, or when a sweep kept its cursor without an
 * answer (the day's cap blocked it): the coverage box says so (KBC-030).
 */
const endedWell = (
  turn: ResearchTurn,
  e: Extract<ResearchEvent, { type: 'done' }>,
): boolean => turn.text.trim() !== '' || e.interrupted || e.sweep !== undefined;

/** The estimate (time, cost) comes once, before the first batch: progress keeps it shown. */
function withEstimate(
  before: SweepProgress | null,
  progress: SweepProgress,
): SweepProgress {
  const minutes = progress.minutes ?? before?.minutes;
  const usd = progress.usd ?? before?.usd;
  return {
    ...progress,
    ...(minutes !== undefined && { minutes }),
    ...(usd !== undefined && { usd }),
  };
}

/** A turn without an exhaustive sweep (KBC-030). */
const NO_SWEEP = { sweep: null, coverage: null, cursor: null } as const;

/** What a turn not answered yet reports. */
const NOT_ANSWERED = {
  usd: null,
  billing: 'per-token',
  model: '',
  interrupted: false,
  escalated: false,
  plan: null,
  remaining: null,
  error: null,
  errorLimit: null,
} as const;

export function startTurn(
  id: number,
  question: string,
  options: { profile?: ResearchProfile | null; turnId?: string } = {},
): ResearchTurn {
  const { profile = null, turnId = crypto.randomUUID() } = options;
  return {
    id,
    turnId,
    question,
    profile,
    phase: 'streaming',
    text: '',
    segments: [],
    sources: [],
    steps: [],
    stepCount: 0,
    ...NOT_ANSWERED,
    at: new Date().toISOString(),
    restored: false,
    ...NO_SWEEP,
  };
}

/** A retracted thought, one line and short: the steps list stays discreet. */
const THOUGHT_CHARS = 160;

function thoughtOf(text: string): ThoughtStep {
  const flat = text.replace(/\s+/g, ' ').trim();
  const short =
    flat.length > THOUGHT_CHARS ? `${flat.slice(0, THOUGHT_CHARS - 1)}…` : flat;
  return { kind: 'thought', text: short };
}

const joined = (segments: readonly AnswerSegment[]): string =>
  segments.map((s) => s.text).join('');

function appendToken(
  turn: ResearchTurn,
  { text, segment }: { text: string; segment: number },
): ResearchTurn {
  const last = turn.segments.at(-1);
  const segments =
    last?.segment === segment
      ? [...turn.segments.slice(0, -1), { segment, text: last.text + text }]
      : [...turn.segments, { segment, text }];
  return { ...turn, segments, text: joined(segments) };
}

/** The segment leaves the answer and shows, collapsed, among the steps as "Pensando: …". */
function retractSegment(turn: ResearchTurn, segment: number): ResearchTurn {
  const taken = turn.segments.find((s) => s.segment === segment);
  if (!taken) return turn;
  const segments = turn.segments.filter((s) => s.segment !== segment);
  const thought = thoughtOf(taken.text);
  return {
    ...turn,
    segments,
    text: joined(segments),
    steps: thought.text ? [...turn.steps, thought] : turn.steps,
  };
}

const HANDLERS: {
  [K in ResearchEvent['type']]: (
    turn: ResearchTurn,
    e: Extract<ResearchEvent, { type: K }>,
  ) => ResearchTurn;
} = {
  start: (turn, e) => ({ ...turn, model: e.model, billing: e.billing }),
  step: (turn, e) => ({
    ...turn,
    steps: [...turn.steps, e.step],
    stepCount: turn.stepCount + 1,
  }),
  sources: (turn, e) => ({ ...turn, sources: e.sources }),
  token: appendToken,
  retract: (turn, e) => retractSegment(turn, e.segment),
  sweep: (turn, e) => ({
    ...turn,
    sweep: withEstimate(turn.sweep, e.sweep),
    cursor: progressCursor(turn, e.sweep),
  }),
  // A finished answer without text is a provider failure, not an empty success.
  done: (turn, e) => ({
    ...turn,
    phase: endedWell(turn, e) ? 'done' : 'error',
    error: endedWell(turn, e) ? null : 'INTERNAL',
    usd: e.usd,
    billing: e.billing,
    model: e.model,
    interrupted: e.interrupted,
    escalated: e.escalated === true,
    plan: e.plan ?? null,
    remaining: e.remaining ?? null,
    stepCount: Math.max(turn.stepCount, e.steps),
    coverage: e.coverage ?? null,
    // A sweep that finished leaves no cursor; a stopped one keeps where it got to.
    cursor:
      e.sweep ?? (e.coverage && e.coverage.missing === 0 ? null : turn.cursor),
  }),
  error: (turn, e) => ({
    ...turn,
    phase: 'error',
    error: toResearchErrorCode(e.code),
    errorLimit: e.limit ?? null,
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

/** A turn that ended with text: it is context for follow-ups. */
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
    [...turn.text.matchAll(/\[(\d{1,4})\]/g)].map((match) => Number(match[1])),
  );
  return turn.sources.filter((source) => cited.has(source.n));
}

/** How the history keeps a turn's phase (KBC-029): pending, failed with its code, or ended. */
function savedStatusOf(turn: ResearchTurn): Partial<SavedResearchTurn> {
  if (turn.phase === 'streaming') return { status: 'pending' };
  if (turn.phase === 'error')
    return { status: 'failed', error: turn.error ?? 'INTERNAL' };
  return {};
}

export function toSavedTurn(turn: ResearchTurn): SavedResearchTurn {
  return {
    id: turn.turnId,
    question: turn.question,
    answer: turn.text,
    sources: [...turn.sources],
    steps: turn.stepCount,
    usd: turn.usd ?? 0,
    billing: turn.billing,
    model: turn.model,
    interrupted: turn.interrupted,
    ...(turn.escalated ? { escalated: true } : {}),
    ...(turn.profile ? { profile: turn.profile } : {}),
    ...(turn.plan ? { plan: turn.plan } : {}),
    ...savedStatusOf(turn),
    ...(turn.coverage ? { coverage: turn.coverage } : {}),
    ...(turn.cursor ? { sweep: turn.cursor } : {}),
    at: turn.at,
  };
}

const PHASES: Record<
  NonNullable<SavedResearchTurn['status']> | 'ended',
  ResearchTurn['phase']
> = { pending: 'streaming', failed: 'error', ended: 'done' };

/**
 * A turn from the history. A pending one (KBC-029) comes back streaming, to be followed
 * again; a failed one with its error, so "Tentar de novo" can ask it again.
 */
export function fromSavedTurn(
  id: number,
  saved: SavedResearchTurn,
): ResearchTurn {
  const phase = PHASES[saved.status ?? 'ended'];
  return {
    id,
    turnId: saved.id ?? crypto.randomUUID(),
    question: saved.question,
    phase,
    text: saved.answer,
    segments: [{ segment: 0, text: saved.answer }],
    sources: saved.sources,
    steps: [],
    stepCount: saved.steps,
    usd: saved.usd,
    billing: saved.billing,
    model: saved.model,
    interrupted: saved.interrupted,
    escalated: saved.escalated === true,
    plan: saved.plan ?? null,
    remaining: null,
    profile: saved.profile ?? null,
    error: phase === 'error' ? toResearchErrorCode(saved.error ?? '') : null,
    errorLimit: null,
    at: saved.at,
    // A pending turn is still to be followed: its answer is announced when it arrives.
    restored: phase !== 'streaming',
    ...savedSweep(saved),
  };
}

/** A saved turn's sweep: its coverage and cursor; no live progress (KBC-030). */
const savedSweep = (saved: SavedResearchTurn) => ({
  sweep: null,
  coverage: saved.coverage ?? null,
  cursor: saved.sweep ?? null,
});

/**
 * A followed turn replays from its start (KBC-029): what was shown so far is cleared; the
 * sweep's cursor stays (a continuation's carried findings), the replay adds what it found.
 */
export const replayFrom = (turn: ResearchTurn): ResearchTurn => ({
  ...turn,
  phase: 'streaming',
  text: '',
  segments: [],
  sources: [],
  steps: [],
  stepCount: 0,
  sweep: null,
  coverage: null,
});

/** The last turn of an unfinished sweep, once it ended: "Continuar varredura" (KBC-030). */
export const canContinueSweep = (turn: ResearchTurn): boolean =>
  turn.cursor !== null && turn.phase !== 'streaming';

export interface SourceGroup {
  readonly authorship: Authorship;
  readonly sources: readonly AnswerSource[];
}

/**
 * The cited sources by authorship (KBC-020 FR-7), or null when they need no groups: all of
 * one group, or some saved before authorship existed (they show as one list, as before).
 */
export function groupByAuthorship(
  sources: readonly AnswerSource[],
): SourceGroup[] | null {
  if (sources.some((source) => !source.authorship)) return null;
  // The contract's order puts the collection's core first.
  const groups = AUTHORSHIPS.map((authorship) => ({
    authorship,
    sources: sources.filter((source) => source.authorship === authorship),
  })).filter((group) => group.sources.length > 0);
  return groups.length > 1 ? groups : null;
}
