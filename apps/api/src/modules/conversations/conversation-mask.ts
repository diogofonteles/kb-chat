import {
  isRestrictedSource,
  type Conversation,
  type SavedAnswerSource,
  type SavedResearchTurn,
  type SweepCursor,
} from '@kb-chat/contracts';
import type {
  LevelView,
  ScopedDocument,
  ViewedScope,
} from '../../ports/level-view.js';

/** The documents of a collection and its sub-collections, by the id a source carries. */
export type ScopeOf = (
  topic: string,
) => ViewedScope<ScopedDocument> | undefined;

/** Whether the reader may see the document `id` of `topic`, judged like a research tool does. */
type Visible = (id: string, media: object | null) => boolean;

function visibilityIn(
  topic: string,
  view: LevelView,
  scopeOf: ScopeOf,
): Visible {
  const scope = scopeOf(topic);
  return (id, media) => {
    const entry = scope?.entries.get(id);
    // A sub-collection's document is judged where it really is (ADR 0028).
    if (entry)
      return view.allows(entry.home?.topic ?? topic, {
        id: entry.home?.id ?? entry.id,
        media: entry.media,
      });
    // Gone from the catalog: open without a scale, closed with one (fail-closed).
    return view.allows(topic, { id, media });
  };
}

const maskSource = (
  source: SavedAnswerSource,
  visible: Visible,
): SavedAnswerSource =>
  isRestrictedSource(source) || visible(source.id, source.media ?? null)
    ? source
    : { n: source.n, restricted: true };

/**
 * A cursor without the findings of hidden documents, nor the last swept id when that one is
 * hidden (QA E2): a continuation resumes by `covered` (KBC-101) either way.
 */
function maskCursor(cursor: SweepCursor, visible: Visible): SweepCursor {
  const findings = cursor.findings.filter((one) => visible(one.id, null));
  const hiddenAfter =
    cursor.after !== undefined && !visible(cursor.after, null);
  if (findings.length === cursor.findings.length && !hiddenAfter) return cursor;
  const masked: SweepCursor = { ...cursor, findings };
  if (hiddenAfter) delete masked.after;
  return masked;
}

function maskTurn(
  turn: SavedResearchTurn,
  visible: Visible,
): SavedResearchTurn {
  const sources = turn.sources.map((source) => maskSource(source, visible));
  const restricted = sources.filter(isRestrictedSource).length;
  const masked: SavedResearchTurn = { ...turn, sources };
  delete masked.restrictedSources;
  if (restricted > 0) masked.restrictedSources = restricted;
  if (turn.sweep) masked.sweep = maskCursor(turn.sweep, visible);
  return masked;
}

/**
 * A stored conversation as today's reader may see it (KBC-110, ADR 0036 §8): the prose of each
 * answer stays; a source the view hides becomes `{ n, restricted: true }` and the turn counts
 * them; a sweep cursor drops the findings of hidden documents. The stored file is untouched.
 */
export function maskConversation(
  conversation: Conversation,
  view: LevelView,
  scopeOf: ScopeOf,
): Conversation {
  if (conversation.kind !== 'research' || view.seesAll) return conversation;
  const visible = visibilityIn(conversation.topic, view, scopeOf);
  return {
    ...conversation,
    turns: conversation.turns.map((turn) => maskTurn(turn, visible)),
  };
}
