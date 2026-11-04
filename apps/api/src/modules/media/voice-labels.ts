import type {
  CollectionSpeaker,
  MergedVoice,
  SpeakerTurn,
  VoiceLabel,
} from '@kb-chat/contracts';
import type { CarriedLabel } from '../../ports/diarization-store.js';
import type {
  StoredSpeaker,
  StoredVoiceLabel,
} from '../../ports/speaker-store.js';
import { joinNeighbours } from './speaker-turns.js';

/** The author a speaker is linked to, as a collection shows it (BR-2). */
export type AuthorLookup = (
  collection: string,
  slug: string,
) => { readonly name: string; readonly main: boolean } | null;

/** How much of an old voice must fall inside a new one to take its name (BR-5). */
export const CARRY_MIN_SHARE = 0.7;

/** Each joined voice and the voice it reads as. */
export const aliasOf = (
  labels: readonly StoredVoiceLabel[],
): ReadonlyMap<number, number> =>
  new Map(
    labels.flatMap(({ voice, mergedInto }) =>
      mergedInto === null ? [] : [[voice, mergedInto] as const],
    ),
  );

export const mergedOf = (labels: readonly StoredVoiceLabel[]): MergedVoice[] =>
  labels.flatMap(({ voice, mergedInto }) =>
    mergedInto === null ? [] : [{ voice, into: mergedInto }],
  );

/** The turns with joined voices read as one: back-to-back turns become one. */
export function mergeTurns(
  turns: readonly SpeakerTurn[],
  alias: ReadonlyMap<number, number>,
): SpeakerTurn[] {
  if (alias.size === 0) return [...turns];
  return joinNeighbours(
    turns.map((turn) => ({
      ...turn,
      voice: alias.get(turn.voice) ?? turn.voice,
    })),
  );
}

/** A speaker as shown: linked to an author, the author's name and ✦ (BR-2). */
export function toCollectionSpeaker(
  speaker: StoredSpeaker,
  authorOf: AuthorLookup,
): CollectionSpeaker {
  const author = speaker.authorSlug
    ? authorOf(speaker.collection, speaker.authorSlug)
    : null;
  return {
    id: speaker.id,
    name: author?.name ?? speaker.name,
    authorSlug: speaker.authorSlug,
    main: author?.main ?? false,
  };
}

/** Who a voice is, as read; a voice with no row or no name is unnamed (BR-6). */
export function voiceLabelOf(
  voice: number,
  row: StoredVoiceLabel | undefined,
  authorOf: AuthorLookup,
): VoiceLabel {
  if (row?.speaker) {
    const { id, name, main } = toCollectionSpeaker(row.speaker, authorOf);
    return { voice, kind: 'person', speakerId: id, name, main };
  }
  const kind = row?.audience ? 'audience' : 'unnamed';
  return { voice, kind, speakerId: null, name: null, main: false };
}

/** Time each (old voice, new voice) pair shares; both lists are in time order. */
function sharedTime(
  oldTurns: readonly SpeakerTurn[],
  newTurns: readonly SpeakerTurn[],
): Map<number, Map<number, number>> {
  const shared = new Map<number, Map<number, number>>();
  let first = 0;
  for (const old of oldTurns) {
    while ((newTurns[first]?.endMs ?? Infinity) <= old.startMs) first++;
    const row = shared.get(old.voice) ?? new Map<number, number>();
    shared.set(old.voice, row);
    for (
      let index = first, turn = newTurns[index];
      turn && turn.startMs < old.endMs;
      turn = newTurns[++index]
    ) {
      const ms =
        Math.min(old.endMs, turn.endMs) - Math.max(old.startMs, turn.startMs);
      row.set(turn.voice, (row.get(turn.voice) ?? 0) + ms);
    }
  }
  return shared;
}

function spokenBy(turns: readonly SpeakerTurn[]): Map<number, number> {
  const spoken = new Map<number, number>();
  for (const { voice, startMs, endMs } of turns)
    spoken.set(voice, (spoken.get(voice) ?? 0) + endMs - startMs);
  return spoken;
}

/** The new voice holding at least the required share of an old one, and the time it holds. */
function bestMatch(
  row: ReadonlyMap<number, number> | undefined,
  spokenMs: number,
): { voice: number; ms: number } | null {
  let best: { voice: number; ms: number } | null = null;
  for (const [voice, ms] of row ?? [])
    if (ms >= spokenMs * CARRY_MIN_SHARE && (!best || ms > best.ms))
      best = { voice, ms };
  return best;
}

/**
 * The names a new separation takes from the one before (BR-5): a new voice takes the name of
 * an old voice when at least 70 % of the old one's time falls inside it; when two old voices
 * end up in one new voice, the one sharing more time wins.
 */
export function carryLabels(input: {
  readonly labels: readonly StoredVoiceLabel[];
  readonly oldTurns: readonly SpeakerTurn[];
  readonly newTurns: readonly SpeakerTurn[];
}): CarriedLabel[] {
  const shared = sharedTime(input.oldTurns, input.newTurns);
  const spoken = spokenBy(input.oldTurns);
  const winners = new Map<number, { label: CarriedLabel; ms: number }>();
  for (const row of input.labels) {
    if (row.mergedInto !== null || (!row.speaker && !row.audience)) continue;
    const match = bestMatch(shared.get(row.voice), spoken.get(row.voice) ?? 0);
    if (!match || (winners.get(match.voice)?.ms ?? -1) >= match.ms) continue;
    winners.set(match.voice, {
      ms: match.ms,
      label: {
        voice: match.voice,
        speakerId: row.speaker?.id ?? null,
        audience: row.audience,
      },
    });
  }
  return [...winners.values()]
    .map(({ label }) => label)
    .sort((a, b) => a.voice - b.voice);
}
