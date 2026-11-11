import {
  GROQ_CHUNK_MAX_MS,
  GROQ_VAD,
  type SilenceInterval,
} from '@kb-chat/contracts';

/** A stretch of the track, in ms from its start. */
export interface Span {
  readonly startMs: number;
  readonly endMs: number;
}

export interface ChunkPlan {
  readonly chunks: readonly Span[];
  /** `skipped` when speech was under 40 %: fixed windows instead (ADR 0023 §3). */
  readonly vad: 'applied' | 'skipped';
  readonly speechRatio: number;
}

/** The speech between the pauses, padded and without the slivers (GROQ_VAD). */
function speechOf(
  silences: readonly SilenceInterval[],
  durationMs: number,
): Span[] {
  const spans: Span[] = [];
  let from = 0;
  for (const pause of [
    ...silences,
    { startMs: durationMs, endMs: durationMs },
  ]) {
    if (pause.startMs - from >= GROQ_VAD.minSpeechMs)
      spans.push({
        startMs: Math.max(0, from - GROQ_VAD.padMs),
        endMs: Math.min(durationMs, pause.startMs + GROQ_VAD.padMs),
      });
    from = Math.max(from, pause.endMs);
  }
  return spans;
}

/** A span longer than a chunk, in chunk-sized pieces. */
const pieces = (span: Span): Span[] => {
  const out: Span[] = [];
  for (let start = span.startMs; start < span.endMs; start += GROQ_CHUNK_MAX_MS)
    out.push({
      startMs: start,
      endMs: Math.min(span.endMs, start + GROQ_CHUNK_MAX_MS),
    });
  return out;
};

/** Greedily joins spans into chunks of at most 28 s, like the Mac's `merge_chunks`. */
export function mergeChunks(spans: readonly Span[]): Span[] {
  const merged: Span[] = [];
  for (const span of spans.flatMap(pieces)) {
    const last = merged.at(-1);
    if (last && span.endMs - last.startMs <= GROQ_CHUNK_MAX_MS)
      merged[merged.length - 1] = {
        startMs: last.startMs,
        endMs: Math.max(last.endMs, span.endMs),
      };
    else merged.push(span);
  }
  return merged;
}

/**
 * Where to cut a track for Groq (KBC-037 FR-3): speech chunks of at most 28 s, or fixed
 * 28 s windows over the whole track when speech is under 40 % (sung tracks, ADR 0023 §3).
 */
export function planChunks(input: {
  readonly silences: readonly SilenceInterval[];
  readonly durationMs: number;
}): ChunkPlan {
  const { durationMs } = input;
  const speech = speechOf(input.silences, durationMs);
  const spoken = speech.reduce(
    (sum, span) => sum + span.endMs - span.startMs,
    0,
  );
  const speechRatio = durationMs > 0 ? Math.min(1, spoken / durationMs) : 0;
  if (speechRatio < GROQ_VAD.minSpeechRatio)
    return {
      chunks: durationMs > 0 ? pieces({ startMs: 0, endMs: durationMs }) : [],
      vad: 'skipped',
      speechRatio,
    };
  return { chunks: mergeChunks(speech), vad: 'applied', speechRatio };
}
