import {
  isRestrictedSource,
  pairTurns,
  sweepCursorKey,
  type Conversation,
  type ResearchConversation,
  type SavedAnswerSource,
  type SavedResearchTurn,
  type SweepCursor,
} from '@kb-chat/contracts';

/**
 * A pending turn that does not run here waits this long before it reads as interrupted:
 * the page saves the question a moment before the server starts the turn (KBC-029).
 */
export const PENDING_GRACE_MS = 2 * 60_000;

/** What decides whether a pending turn still runs. */
export interface Liveness {
  readonly isLive: (turnId: string) => boolean;
  /** When this process started: a pending turn from before it cannot be running. */
  readonly bootAt: number;
  readonly now: number;
  readonly ceilingMs: number;
}

function isDead(turn: SavedResearchTurn, liveness: Liveness): boolean {
  const at = Date.parse(turn.at);
  const age = liveness.now - at;
  if (age > liveness.ceilingMs) return true;
  if (turn.id !== undefined && liveness.isLive(turn.id)) return false;
  return at < liveness.bootAt || age > PENDING_GRACE_MS;
}

/** A pending turn whose agent is gone reads as interrupted (never a spinner forever). */
export function settleDeadTurns(
  conversation: Conversation,
  liveness: Liveness,
): Conversation {
  if (conversation.kind !== 'research') return conversation;
  const dead = (turn: SavedResearchTurn) =>
    turn.status === 'pending' && isDead(turn, liveness);
  if (!conversation.turns.some(dead)) return conversation;
  return {
    ...conversation,
    turns: conversation.turns.map((turn) => {
      if (!dead(turn)) return turn;
      const settled = { ...turn, interrupted: true };
      delete settled.status;
      return settled;
    }),
  };
}

/** The stored turn with the same id wins only when the incoming one is a stale pending one. */
function pick(
  incoming: SavedResearchTurn,
  stored: SavedResearchTurn | undefined,
) {
  const stale = incoming.status === 'pending' && stored?.status !== 'pending';
  return stored && stale ? stored : incoming;
}

/**
 * A page's snapshot merged over what is stored (KBC-029): turns pair by `pairTurns` (id,
 * then start and question, each stored turn once); a pending snapshot never overwrites a
 * turn that already ended; stored turns the snapshot does not pair with stay, in time order.
 */
export function mergeResearchTurns(
  incoming: ResearchConversation,
  stored: Conversation | null,
): ResearchConversation {
  if (stored?.kind !== 'research') return incoming;
  // One pairing with the restore (KBC-110 QA F-7, F-8): by id, then by start and question.
  const paired = pairTurns(incoming.turns, stored.turns);
  const merged = incoming.turns.map((turn, at) => {
    const known = paired[at];
    return turn.id && known?.id === turn.id ? pick(turn, known) : turn;
  });
  const sent = new Set(paired);
  const kept = stored.turns.filter((turn) => !sent.has(turn));
  if (kept.length === 0) return { ...incoming, turns: merged };
  const turns = [...merged, ...kept].sort((a, b) => a.at.localeCompare(b.at));
  return { ...incoming, turns };
}

/** The conversation with `turn` in place of the one with its id, or added at the end. */
export function withTurn(
  conversation: ResearchConversation,
  turn: SavedResearchTurn,
): SavedResearchTurn[] {
  const index = conversation.turns.findIndex((t) => t.id === turn.id);
  if (index < 0) return [...conversation.turns, turn];
  return conversation.turns.map((t, i) => (i === index ? turn : t));
}

/** A restricted source of the snapshot becomes the stored one with its number again. */
function unmaskSources(
  sources: readonly SavedAnswerSource[],
  stored: readonly SavedAnswerSource[] | undefined,
): SavedAnswerSource[] {
  return sources.map((source) => {
    if (!isRestrictedSource(source)) return source;
    return stored?.find((one) => one.n === source.n) ?? source;
  });
}

/** The stored cursor when the snapshot's is it with hidden parts left out (KBC-110). */
function unmaskCursor(
  sweep: SweepCursor | undefined,
  stored: SweepCursor | undefined,
): SweepCursor | undefined {
  if (!sweep || !stored || sweepCursorKey(sweep) !== sweepCursorKey(stored))
    return sweep;
  const sameAfter = sweep.after === undefined || sweep.after === stored.after;
  const storedFindings = new Set(
    stored.findings.map((one) => JSON.stringify(one)),
  );
  const filtered = sweep.findings.every((one) =>
    storedFindings.has(JSON.stringify(one)),
  );
  return sameAfter && filtered ? stored : sweep;
}

function unmaskTurn(
  turn: SavedResearchTurn,
  known: SavedResearchTurn | undefined,
): SavedResearchTurn {
  const restored: SavedResearchTurn = {
    ...turn,
    sources: unmaskSources(turn.sources, known?.sources),
  };
  // A count of what the reader may see is the server's, worked out at each read.
  delete restored.restrictedSources;
  const sweep = unmaskCursor(turn.sweep, known?.sweep);
  if (sweep) restored.sweep = sweep;
  return restored;
}

/**
 * A page's snapshot read masked (KBC-110, ADR 0036 §8) back over what is stored: a restricted
 * source and a cursor whose findings were filtered take the stored ones again, so saving what
 * the reader sees never makes the file lose anything; returning to the level shows it all.
 */
export function unmaskResearchTurns(
  incoming: ResearchConversation,
  stored: Conversation | null,
): ResearchConversation {
  const known =
    stored?.kind === 'research' ? pairTurns(incoming.turns, stored.turns) : [];
  return {
    ...incoming,
    turns: incoming.turns.map((turn, at) => unmaskTurn(turn, known[at])),
  };
}
