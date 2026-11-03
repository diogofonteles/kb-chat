import type { TranscriptConfidence } from '@kb-chat/contracts';
import type { DerivedTranscript } from './transcript-filter.js';

/**
 * ADR 0023 §6, calibrated on the pilot's 111 tracks (work/KBC-036/spec.md): the noisy
 * excerpt's tracks come out low, the clean excerpts' normal.
 */
/** Bump whenever a rule below changes: each transcript keeps the version it was judged by. */
export const CONFIDENCE_VERSION = 1;

export const CONFIDENCE_RULES = {
  /** A segment whisper doubted: mean token log-probability under this… */
  minAvgLogprob: -0.6,
  /** …or text this repetitive (gzip ratio). */
  maxCompressionRatio: 2.4,
  /** Low when more than this share of the words sits in doubted segments… */
  maxDoubtedShare: 0.3,
  /** …or when the filter removed more than this share of the words. */
  maxRemovedShare: 0.1,
} as const;

export interface ConfidenceVerdict {
  readonly confidence: TranscriptConfidence;
  /** Kept words in doubted segments. */
  readonly doubtedWords: number;
  /** Kept words. */
  readonly wordCount: number;
}

const isDoubted = (segment: DerivedTranscript['segments'][number]): boolean =>
  (segment.avgLogprob ?? 0) < CONFIDENCE_RULES.minAvgLogprob ||
  (segment.compressionRatio ?? 0) > CONFIDENCE_RULES.maxCompressionRatio;

/** Words per segment: the timed words, or the text's words for an untimed segment. */
function wordsPerSegment(transcript: DerivedTranscript): number[] {
  const counts = transcript.segments.map(() => 0);
  for (const word of transcript.words)
    counts[word.segment] = (counts[word.segment] ?? 0) + 1;
  return counts.map((count, index) =>
    count > 0
      ? count
      : (transcript.segments[index]?.text.split(/\s+/).filter(Boolean).length ??
        0),
  );
}

/**
 * `low` when too many words are doubted or the filter removed too many (BR-5: still
 * searchable and playable, with the notice). A transcript with no words at all is low.
 */
export function confidenceOf(transcript: DerivedTranscript): ConfidenceVerdict {
  const counts = wordsPerSegment(transcript);
  const wordCount = counts.reduce((sum, count) => sum + count, 0);
  const doubtedWords = transcript.segments.reduce(
    (sum, segment, index) =>
      isDoubted(segment) ? sum + (counts[index] ?? 0) : sum,
    0,
  );
  const { wordsBefore, removedWords } = transcript.stats;
  const low =
    wordCount === 0 ||
    doubtedWords / wordCount > CONFIDENCE_RULES.maxDoubtedShare ||
    removedWords / Math.max(1, wordsBefore) > CONFIDENCE_RULES.maxRemovedShare;
  return { confidence: low ? 'low' : 'normal', doubtedWords, wordCount };
}
