import type { Conversation, SavedResearchTurn } from '@kb-chat/contracts';

const startOf = (turn: SavedResearchTurn) => `${turn.at} ${turn.question}`;

/** The server's turn that a local one is: same id, or (older turns) same start and question. */
function serverTurnOf(
  turn: SavedResearchTurn,
  server: readonly SavedResearchTurn[],
): SavedResearchTurn | undefined {
  return server.find((one) =>
    turn.id !== undefined && one.id !== undefined
      ? one.id === turn.id
      : startOf(one) === startOf(turn),
  );
}

function withServerTurn(
  turn: SavedResearchTurn,
  known: SavedResearchTurn | undefined,
): SavedResearchTurn {
  if (!known) return turn;
  const next: SavedResearchTurn = { ...turn, sources: known.sources };
  delete next.restrictedSources;
  delete next.sweep;
  if (known.restrictedSources) next.restrictedSources = known.restrictedSources;
  if (known.sweep) next.sweep = known.sweep;
  return next;
}

/**
 * A copy kept in this browser with the server's view of its sources (KBC-110 BR-5, ADR 0036
 * §8): each turn the server has takes the server's sources and sweep cursor, read against the
 * reader's level today; turns only this browser has stay as they are. The same object when
 * nothing is the server's.
 */
export function withServerSources(
  local: Conversation,
  server: Conversation,
): Conversation {
  if (local.kind !== 'research' || server.kind !== 'research') return local;
  const known = local.turns.map((turn) => serverTurnOf(turn, server.turns));
  if (known.every((one) => one === undefined)) return local;
  return {
    ...local,
    turns: local.turns.map((turn, at) => withServerTurn(turn, known[at])),
  };
}
