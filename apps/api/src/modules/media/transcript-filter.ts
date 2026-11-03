import type { RawSegment, RawTranscript } from '@kb-chat/contracts';
import type {
  DerivedSegment,
  DerivedWord,
} from '../../ports/transcript-store.js';

/**
 * The post-filter of ADR 0023 §5, in the API so a change re-derives without transcribing
 * again. Bump the version whenever what it keeps or drops changes.
 */
export const FILTER_VERSION = 1;

/** Phrases whisper invents on silence (pt and en), and English prefixes. */
const BLOCKED_PHRASES = [
  'obrigado por assistir',
  'obrigada por assistir',
  'inscreva-se',
  'se inscreva',
  'ative o sininho',
  'legendas pela comunidade',
  'amara.org',
  'legendado por',
  'até o próximo vídeo',
  'deixe seu like',
];
const ENGLISH_PREFIXES = [
  'thanks for watching',
  'thank you for watching',
  'subtitles by',
  'please subscribe',
  'thank you.',
];
const ISOLATED_THANKS = /^\s*(muito\s+)?obrigad[oa][.!]?\s*$/i;
/** "obrigado" alone is dropped only when whisper itself doubts there was speech. */
const THANKS_NO_SPEECH = 0.8;
const CHARACTER_LOOP = /(.{1,24}?)\1{3,}/gs;
/** Word n-grams of 1 to 12 words repeated 3 or more times in a row (the pilot's loop had 7). */
const MAX_LOOP_WORDS = 12;
const MIN_LOOP_REPEATS = 3;
/** A segment made almost only of the term list is the prompt leaking into the text. */
const LEAK_MIN_TOKENS = 6;
const LEAK_SHARE = 0.8;

/** What the filter did, for the confidence (ADR 0023 §6) and the log. */
export interface FilterStats {
  /** Words whisper produced. */
  readonly wordsBefore: number;
  /** Words dropped: blocked segments and collapsed loops. */
  readonly removedWords: number;
  readonly removedSegments: number;
}

export interface DerivedTranscript {
  readonly segments: readonly DerivedSegment[];
  readonly words: readonly DerivedWord[];
  readonly stats: FilterStats;
}

/** A word on its way through the filter, tied to its raw segment. */
interface WorkingWord {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly probability: number | null;
  readonly segment: number;
  /** Lowercase letters and digits only: what loops are compared by. */
  readonly token: string;
}

interface WorkingSegment extends DerivedSegment {
  /** False when whisper gave no word timestamps: its text stands alone. */
  readonly timed: boolean;
}

const toMs = (seconds: number): number =>
  Math.max(0, Math.round(seconds * 1000));
const tokenOf = (text: string): string =>
  text
    .normalize('NFC')
    .toLocaleLowerCase('pt-BR')
    .replace(/[^\p{L}\p{N}]+/gu, '');
const countWords = (text: string): number =>
  text.split(/\s+/).filter((part) => part.length > 0).length;
const normalized = (text: string): string =>
  text.toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ').trim();

function toWorkingSegment(raw: RawSegment, offset: number): WorkingSegment {
  return {
    startMs: toMs(raw.start + offset),
    endMs: toMs(raw.end + offset),
    text: raw.text.trim(),
    avgLogprob: raw.avg_logprob ?? null,
    compressionRatio: raw.compression_ratio ?? null,
    noSpeechProb: raw.no_speech_prob ?? null,
    timed: (raw.words?.length ?? 0) > 0,
  };
}

function wordsOf(
  raw: RawSegment,
  place: { offset: number; segment: number },
): WorkingWord[] {
  return (raw.words ?? []).map((word) => ({
    text: word.word,
    startMs: toMs(word.start + place.offset),
    endMs: toMs(word.end + place.offset),
    probability: word.probability ?? null,
    segment: place.segment,
    token: tokenOf(word.word),
  }));
}

/** Every chunk's segments and words, on the track's clock. */
function flatten(raw: RawTranscript): {
  segments: WorkingSegment[];
  words: WorkingWord[];
} {
  const segments: WorkingSegment[] = [];
  const words: WorkingWord[] = [];
  for (const chunk of raw.chunks)
    for (const segment of chunk.result.segments) {
      const place = { offset: chunk.offset, segment: segments.length };
      segments.push(toWorkingSegment(segment, chunk.offset));
      words.push(...wordsOf(segment, place));
    }
  return { segments, words };
}

/** True when the segment is whisper's filler, not speech (blocked phrase, leak, thanks). */
function isBlocked(segment: WorkingSegment, termTokens: Set<string>): boolean {
  const text = normalized(segment.text);
  if (BLOCKED_PHRASES.some((phrase) => text.includes(phrase))) return true;
  if (ENGLISH_PREFIXES.some((prefix) => text.startsWith(prefix))) return true;
  if (
    ISOLATED_THANKS.test(text) &&
    (segment.noSpeechProb ?? 0) >= THANKS_NO_SPEECH
  )
    return true;
  return isPromptLeak(text, termTokens);
}

function isPromptLeak(text: string, termTokens: Set<string>): boolean {
  const tokens = text.split(' ').map(tokenOf).filter(Boolean);
  if (tokens.length < LEAK_MIN_TOKENS) return false;
  const fromTerms = tokens.filter((token) => termTokens.has(token)).length;
  return fromTerms / tokens.length >= LEAK_SHARE;
}

/** How many times the `size` tokens at `start` repeat back to back (1 = no repeat). */
function repeatsAt(tokens: readonly string[], start: number, size: number) {
  let count = 1;
  const same = (offset: number) =>
    tokens
      .slice(start, start + size)
      .every((token, i) => token === tokens[start + offset + i]);
  while (start + (count + 1) * size <= tokens.length && same(count * size))
    count++;
  return count;
}

/** The shortest n-gram looping at `start`, as [size, repeats], or null. */
function loopAt(
  tokens: readonly string[],
  start: number,
): [number, number] | null {
  for (let size = 1; size <= MAX_LOOP_WORDS; size++) {
    if (start + MIN_LOOP_REPEATS * size > tokens.length) return null;
    const count = repeatsAt(tokens, start, size);
    if (count >= MIN_LOOP_REPEATS) return [size, count];
  }
  return null;
}

/** One pass: every loop keeps its first occurrence. */
function collapseOnce(words: readonly WorkingWord[]): WorkingWord[] {
  const tokens = words.map((word) => word.token);
  const kept: WorkingWord[] = [];
  let index = 0;
  while (index < words.length) {
    const loop = loopAt(tokens, index);
    const size = loop ? loop[0] : 1;
    kept.push(...words.slice(index, index + size));
    index += loop ? loop[0] * loop[1] : 1;
  }
  return kept;
}

/**
 * Collapses word loops across segment borders (the pilot's 7-word loop spanned four
 * segments), until none is left: collapsing can make a longer loop appear.
 */
function collapseLoops(words: readonly WorkingWord[]): WorkingWord[] {
  let current = [...words];
  for (;;) {
    const next = collapseOnce(current);
    if (next.length === current.length) return next;
    current = next;
  }
}

const textOf = (words: readonly WorkingWord[]): string =>
  words
    .map((word) => word.text)
    .join('')
    .trim();

/** The kept segments, their text rebuilt from the kept words, renumbered. */
function rebuild(
  segments: readonly WorkingSegment[],
  kept: { words: readonly WorkingWord[]; dropped: ReadonlySet<number> },
): Pick<DerivedTranscript, 'segments' | 'words'> {
  const byOld = new Map<number, WorkingWord[]>();
  for (const word of kept.words)
    byOld.set(word.segment, [...(byOld.get(word.segment) ?? []), word]);
  const out: { segments: DerivedSegment[]; words: DerivedWord[] } = {
    segments: [],
    words: [],
  };
  segments.forEach((segment, old) => {
    const words = byOld.get(old) ?? [];
    if (kept.dropped.has(old) || (segment.timed && words.length === 0)) return;
    const index = out.segments.length;
    out.segments.push(toDerived(segment, segment.timed ? textOf(words) : null));
    out.words.push(...words.map((word) => toDerivedWord(word, index)));
  });
  return out;
}

function toDerived(
  segment: WorkingSegment,
  text: string | null,
): DerivedSegment {
  return {
    startMs: segment.startMs,
    endMs: Math.max(segment.startMs, segment.endMs),
    text: text ?? segment.text.replace(CHARACTER_LOOP, '$1'),
    avgLogprob: segment.avgLogprob,
    compressionRatio: segment.compressionRatio,
    noSpeechProb: segment.noSpeechProb,
  };
}

const toDerivedWord = (word: WorkingWord, segment: number): DerivedWord => ({
  segment,
  startMs: word.startMs,
  endMs: Math.max(word.startMs, word.endMs),
  text: word.text.trim(),
  probability: word.probability,
});

/** Words of the timed segments, plus the words of the text of the untimed ones. */
function wordCountOf(transcript: {
  segments: readonly DerivedSegment[];
  timedWords: number;
  isTimed: (index: number) => boolean;
}): number {
  return transcript.segments.reduce(
    (sum, segment, index) =>
      transcript.isTimed(index) ? sum : sum + countWords(segment.text),
    transcript.timedWords,
  );
}

/** What the filter removed, counted the same way before and after. */
function statsOf(
  before: { segments: readonly WorkingSegment[]; words: number },
  after: Pick<DerivedTranscript, 'segments' | 'words'>,
): FilterStats {
  const wordsBefore = wordCountOf({
    segments: before.segments,
    timedWords: before.words,
    isTimed: (index) => before.segments[index]?.timed === true,
  });
  const timedAfter = new Set(after.words.map((word) => word.segment));
  const wordsAfter = wordCountOf({
    segments: after.segments,
    timedWords: after.words.length,
    isTimed: (index) => timedAfter.has(index),
  });
  return {
    wordsBefore,
    removedWords: Math.max(0, wordsBefore - wordsAfter),
    removedSegments: before.segments.length - after.segments.length,
  };
}

/**
 * The raw JSON → segments and words on the track's clock, with blocked segments dropped and
 * loops collapsed (ADR 0023 §4-5). Pure: the same raw and terms always give the same result.
 */
export function deriveTranscript(
  raw: RawTranscript,
  terms: readonly string[],
): DerivedTranscript {
  const { segments, words } = flatten(raw);
  const termTokens = new Set(
    terms.flatMap((term) => term.split(/\s+/).map(tokenOf)),
  );
  const dropped = new Set(
    segments.flatMap((segment, index) =>
      isBlocked(segment, termTokens) ? [index] : [],
    ),
  );
  const collapsed = collapseLoops(
    words.filter((word) => !dropped.has(word.segment)),
  );
  const derived = rebuild(segments, { words: collapsed, dropped });
  const stats = statsOf({ segments, words: words.length }, derived);
  return { ...derived, stats };
}
