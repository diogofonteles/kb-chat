import type {
  Conversation,
  ResearchConversation,
  SavedResearchTurn,
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
 * A page's snapshot merged over what is stored (KBC-029): turns match by id; a pending
 * snapshot never overwrites a turn that already ended; turns the server recorded that the
 * snapshot lacks stay, in time order. Turns without an id (older ones) come from the snapshot.
 */
export function mergeResearchTurns(
  incoming: ResearchConversation,
  stored: Conversation | null,
): ResearchConversation {
  if (stored?.kind !== 'research') return incoming;
  const byId = new Map(
    stored.turns.flatMap((turn) => (turn.id ? [[turn.id, turn] as const] : [])),
  );
  const sent = new Set(incoming.turns.map((turn) => turn.id));
  const merged = incoming.turns.map((turn) =>
    turn.id ? pick(turn, byId.get(turn.id)) : turn,
  );
  const kept = [...byId.values()].filter((turn) => !sent.has(turn.id));
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
