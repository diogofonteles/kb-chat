import {
  MAX_VOICES,
  type RawSpeakerTurn,
  type SpeakerTurn,
} from '@kb-chat/contracts';

/**
 * Bump when a rule below changes: the stored voices were derived with the old rules and can
 * be derived again from the raw file without separating the voices again.
 */
export const DERIVATION_VERSION = 1;

/** Turns shorter than this are dropped (a click, an engine artefact). */
const MIN_TURN_MS = 1;

/** A span of time in ms. */
interface Span {
  readonly startMs: number;
  readonly endMs: number;
}

const toMs = (seconds: number): number => Math.round(seconds * 1000);

/**
 * The raw turns as stored turns (ADR 0029 §1): in ms, clipped to the recording, one voice per
 * instant (where two overlap, the later one takes over from its start), neighbours of the
 * same voice joined, and voices numbered 1, 2, … by who speaks first. At most MAX_VOICES
 * voices: a further one (the worker never sends it) joins the voice that speaks most.
 */
export function deriveTurns(
  raw: readonly RawSpeakerTurn[],
  durationMs: number | null,
): SpeakerTurn[] {
  const limit = durationMs ?? Number.POSITIVE_INFINITY;
  const timed = raw
    .map((turn) => ({
      voice: turn.voice,
      startMs: Math.min(toMs(turn.start), limit),
      endMs: Math.min(toMs(turn.end), limit),
    }))
    .filter((turn) => turn.endMs - turn.startMs >= MIN_TURN_MS)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const exclusive = timed.map((turn, index) => {
    const next = timed[index + 1];
    return next && next.startMs < turn.endMs
      ? { ...turn, endMs: next.startMs }
      : turn;
  });
  return joinNeighbours(
    numberVoices(
      exclusive.filter((turn) => turn.endMs - turn.startMs >= MIN_TURN_MS),
    ),
  );
}

/** Voice names become 1, 2, … by first appearance; a name past MAX_VOICES joins the top one. */
function numberVoices(
  turns: readonly { voice: string; startMs: number; endMs: number }[],
): SpeakerTurn[] {
  const order = new Map<string, number>();
  for (const turn of turns)
    if (!order.has(turn.voice)) order.set(turn.voice, order.size + 1);
  const numbered = turns.map((turn) => ({
    voice: order.get(turn.voice) ?? 1,
    startMs: turn.startMs,
    endMs: turn.endMs,
  }));
  const top = mostSpoken(numbered.filter((turn) => turn.voice <= MAX_VOICES));
  return numbered.map((turn) =>
    turn.voice > MAX_VOICES ? { ...turn, voice: top } : turn,
  );
}

/** The voice that speaks longest (the first one on a tie). */
function mostSpoken(turns: readonly SpeakerTurn[]): number {
  let best = { voice: 1, speakingMs: -1 };
  for (const one of speakingTimeOf(turns))
    if (one.speakingMs > best.speakingMs) best = one;
  return best.voice;
}

/** Back-to-back turns of the same voice become one. */
function joinNeighbours(turns: readonly SpeakerTurn[]): SpeakerTurn[] {
  const joined: SpeakerTurn[] = [];
  for (const turn of turns) {
    const last = joined.at(-1);
    if (last && last.voice === turn.voice && turn.startMs <= last.endMs)
      joined[joined.length - 1] = { ...last, endMs: turn.endMs };
    else joined.push(turn);
  }
  return joined;
}

/** How many distinct voices the turns hold. */
export const voiceCountOf = (turns: readonly SpeakerTurn[]): number =>
  new Set(turns.map((turn) => turn.voice)).size;

/** Speaking time per voice, in voice order. */
export function speakingTimeOf(
  turns: readonly SpeakerTurn[],
): { voice: number; speakingMs: number }[] {
  const spoken = new Map<number, number>();
  for (const turn of turns)
    spoken.set(
      turn.voice,
      (spoken.get(turn.voice) ?? 0) + turn.endMs - turn.startMs,
    );
  return [...spoken]
    .sort(([a], [b]) => a - b)
    .map(([voice, speakingMs]) => ({ voice, speakingMs }));
}

/** Time two spans share, in ms. */
const overlapOf = (a: Span, b: Span): number =>
  Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));

/**
 * The voice that speaks most of each span (FR-3); null where no turn touches it. Both lists
 * are in time order, so one pass with a moving start serves them all.
 */
export function dominantVoices(
  spans: readonly Span[],
  turns: readonly SpeakerTurn[],
): (number | null)[] {
  let first = 0;
  return spans.map((span) => {
    first = skipEndedBy(turns, first, span.startMs);
    const share = new Map<number, number>();
    for (
      let index = first, turn = turns[index];
      turn && turn.startMs < span.endMs;
      turn = turns[++index]
    )
      share.set(
        turn.voice,
        (share.get(turn.voice) ?? 0) + overlapOf(span, turn),
      );
    return pickLargest(share);
  });
}

/** From `from` on, the index of the first turn still going at `ms`. */
function skipEndedBy(
  turns: readonly SpeakerTurn[],
  from: number,
  ms: number,
): number {
  let index = from;
  for (let turn = turns[index]; turn && turn.endMs <= ms; turn = turns[index])
    index++;
  return index;
}

function pickLargest(share: ReadonlyMap<number, number>): number | null {
  let best: number | null = null;
  let bestMs = 0;
  for (const [voice, ms] of share)
    if (ms > bestMs) {
      best = voice;
      bestMs = ms;
    }
  return best;
}

/**
 * The voice of each word: the turn holding its midpoint, or its segment's voice when the
 * midpoint falls in a gap between turns.
 */
export function wordVoicesOf(input: {
  readonly words: readonly (Span & { readonly segment: number })[];
  readonly turns: readonly SpeakerTurn[];
  readonly segmentVoices: readonly (number | null)[];
}): (number | null)[] {
  const { turns } = input;
  let current = 0;
  return input.words.map((word) => {
    const middle = (word.startMs + word.endMs) / 2;
    current = skipEndedBy(turns, current, middle);
    const turn = turns[current];
    return turn && turn.startMs <= middle
      ? turn.voice
      : (input.segmentVoices[word.segment] ?? null);
  });
}
