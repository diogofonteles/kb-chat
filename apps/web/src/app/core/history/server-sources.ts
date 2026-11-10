import {
  isRestrictedSource,
  isSameTurn,
  type Conversation,
  type SavedAnswerSource,
  type SavedResearchTurn,
  type SweepCursor,
} from '@kb-chat/contracts';

/** The local sources, with each number the server restricted made restricted. */
function maskSources(
  local: readonly SavedAnswerSource[],
  server: readonly SavedAnswerSource[],
): SavedAnswerSource[] {
  const restricted = new Set(
    server.filter(isRestrictedSource).map(({ n }) => n),
  );
  return local.map((source) =>
    restricted.has(source.n) ? { n: source.n, restricted: true } : source,
  );
}

/**
 * The local cursor without what the server's cursor hides: findings of documents it does not
 * return, and the last swept id when it left that out. Kept whole when the server has none.
 */
function maskCursor(
  local: SweepCursor | undefined,
  server: SweepCursor | undefined,
): SweepCursor | undefined {
  if (!local || !server) return local;
  const seen = new Set(server.findings.map(({ id }) => id));
  const masked: SweepCursor = {
    ...local,
    findings: local.findings.filter(({ id }) => seen.has(id)),
  };
  if (server.after === undefined) delete masked.after;
  return masked;
}

function withServerTurn(
  turn: SavedResearchTurn,
  known: SavedResearchTurn | undefined,
): SavedResearchTurn {
  if (!known) return turn;
  const next: SavedResearchTurn = {
    ...turn,
    sources: maskSources(turn.sources, known.sources),
  };
  delete next.restrictedSources;
  const restricted = next.sources.filter(isRestrictedSource).length;
  if (restricted > 0) next.restrictedSources = restricted;
  const sweep = maskCursor(turn.sweep, known.sweep);
  if (sweep) next.sweep = sweep;
  return next;
}

/**
 * A copy kept in this browser, masked by the server's read (KBC-110 BR-5, ADR 0036 §8): a
 * source becomes restricted only where the server restricted that number, and a cursor loses
 * only what the server's cursor hides, so a turn the server holds in another state (still
 * pending, interrupted) keeps the answer this browser got. Turns only this browser has stay
 * as they are. The same object when the server has none of its turns.
 */
export function withServerSources(
  local: Conversation,
  server: Conversation,
): Conversation {
  if (local.kind !== 'research' || server.kind !== 'research') return local;
  const known = local.turns.map((turn) =>
    server.turns.find((one) => isSameTurn(one, turn)),
  );
  if (known.every((one) => one === undefined)) return local;
  return {
    ...local,
    turns: local.turns.map((turn, at) => withServerTurn(turn, known[at])),
  };
}
