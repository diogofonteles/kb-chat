import type {
  DerivedSegment,
  DerivedWord,
} from '../../ports/transcript-store.js';

/**
 * The subtitle rules of ADR 0023 §8, applied to the stored words (never to the raw JSON).
 * Bump the version whenever a rule changes: cached WebVTT is keyed by it and re-derived.
 */
export const SUBTITLE_RULES_VERSION = 1;

export const SUBTITLE_RULES = {
  /** A pause this long between two words starts a new cue. */
  silenceMs: 500,
  maxCueMs: 6_000,
  maxCueChars: 84,
  /** Two lines at most on the player's caption area. */
  maxLineChars: 42,
  /** Whisper stretches a word over the pause after it: its end counts only this far. */
  maxWordMs: 1_200,
  /** A cue whose words have no length still shows this long (up to the next cue). */
  minCueMs: 500,
} as const;

export interface SubtitleCue {
  readonly startMs: number;
  readonly endMs: number;
  /** One or two lines, joined by "\n". */
  readonly text: string;
}

interface TimedWord {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}

interface Span {
  readonly startMs: number;
  readonly endMs: number;
}

/** A sentence ends on . ! ? or …, maybe followed by a closing quote or bracket. */
const SENTENCE_END = /[.!?…]["'”»)\]]*$/u;

const capped = (word: DerivedWord): TimedWord => ({
  text: word.text,
  startMs: word.startMs,
  endMs: Math.min(word.endMs, word.startMs + SUBTITLE_RULES.maxWordMs),
});

const joinWords = (words: readonly TimedWord[]): string =>
  words
    .map((word) => word.text)
    .filter((text) => text.length > 0)
    .join(' ');

/**
 * Where to break `text` into two lines of at most 42 characters, the most even split:
 * -1 when it fits on one line, null when no split fits.
 */
function lineBreakOf(text: string): number | null {
  const max = SUBTITLE_RULES.maxLineChars;
  if (text.length <= max) return -1;
  let best: number | null = null;
  let bestLongest = Number.POSITIVE_INFINITY;
  for (let at = text.indexOf(' '); at !== -1; at = text.indexOf(' ', at + 1)) {
    const longest = Math.max(at, text.length - at - 1);
    if (longest <= max && longest < bestLongest)
      [best, bestLongest] = [at, longest];
  }
  return best;
}

/** The text fits the caption area: one line, or two of at most 42 characters. */
export const fitsTwoLines = (text: string): boolean =>
  lineBreakOf(text) !== null;

/** True when `word` must start a new cue after `current` (silence, sentence, 6 s, 2 lines). */
function breaksBefore(current: readonly TimedWord[], word: TimedWord): boolean {
  const first = current[0];
  const last = current[current.length - 1];
  if (!first || !last) return false;
  if (SENTENCE_END.test(last.text)) return true;
  if (word.startMs - last.endMs >= SUBTITLE_RULES.silenceMs) return true;
  if (word.endMs - first.startMs > SUBTITLE_RULES.maxCueMs) return true;
  return !fitsTwoLines(joinWords([...current, word]));
}

function groupWords(words: readonly TimedWord[]): TimedWord[][] {
  const groups: TimedWord[][] = [];
  let current: TimedWord[] = [];
  for (const word of words) {
    if (breaksBefore(current, word)) {
      groups.push(current);
      current = [];
    }
    current.push(word);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** A word longer than a line, cut into line-sized parts. */
const LINE_SIZED = new RegExp(`.{1,${SUBTITLE_RULES.maxLineChars}}`, 'gsu');

/** Words of the text, each at most a line long. */
const tokensOf = (text: string): string[] =>
  text
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .flatMap((token) => token.match(LINE_SIZED) ?? []);

/** Words, each at most a line long, and each one cut so (one-word groups fit too). */
const wordsFitting = (words: readonly TimedWord[]): TimedWord[] =>
  words.flatMap((word) => {
    const parts = tokensOf(word.text);
    if (parts.length <= 1) return [word];
    const step = (word.endMs - word.startMs) / parts.length;
    return parts.map((text, index) => ({
      text,
      startMs: Math.round(word.startMs + step * index),
      endMs: Math.round(word.startMs + step * (index + 1)),
    }));
  });

/** About `count` pieces of similar length, each fitting two lines. */
function piecesOf(text: string, count: number): string[] {
  const target = Math.ceil(text.length / count);
  const pieces: string[] = [];
  let current = '';
  for (const token of tokensOf(text)) {
    const joined = current ? `${current} ${token}` : token;
    const full = !fitsTwoLines(joined) || current.length >= target;
    if (current && full) {
      pieces.push(current);
      current = token;
    } else current = joined;
  }
  if (current) pieces.push(current);
  return pieces;
}

/** A word-less segment is split by its length only into cues of at least this many words. */
const MIN_WORDS_PER_SPLIT = 3;

/**
 * A segment without word times over its span: cues spread over it by text and by duration,
 * each timed by its share of the characters and shown 6 s at most (two words in 30 s make one cue, not
 * one cue per word).
 */
function spreadText(text: string, span: Span): SubtitleCue[] {
  const length = text.trim().length;
  if (length === 0) return [];
  const duration = Math.max(0, span.endMs - span.startMs);
  // Split by duration too (no cue over 6 s leaves the rest of a long segment bare), but
  // never below three words per cue: a short text in a long segment shows once.
  const byDuration = Math.min(
    Math.ceil(duration / SUBTITLE_RULES.maxCueMs),
    Math.floor(tokensOf(text).length / MIN_WORDS_PER_SPLIT),
  );
  const count = Math.max(
    1,
    Math.ceil(length / SUBTITLE_RULES.maxCueChars),
    byDuration,
  );
  const pieces = piecesOf(text.trim(), count);
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
  let done = 0;
  return pieces.map((piece) => {
    const startMs = span.startMs + Math.round((duration * done) / total);
    done += piece.length;
    const endMs = span.startMs + Math.round((duration * done) / total);
    const longest = startMs + SUBTITLE_RULES.maxCueMs;
    return { startMs, endMs: Math.min(endMs, longest), text: piece };
  });
}

const cuesOfWords = (words: readonly TimedWord[]): SubtitleCue[] =>
  groupWords(wordsFitting(words)).flatMap((group) => {
    const first = group[0];
    const last = group[group.length - 1];
    if (!first || !last) return [];
    return [
      { startMs: first.startMs, endMs: last.endMs, text: joinWords(group) },
    ];
  });

/**
 * The caption's lines: never more than 42 characters each. The cues are built to fit two
 * (`fitsTwoLines`); a text that does not is wrapped every 42 characters rather than let a
 * line run longer.
 */
export function linesOf(text: string): string {
  const at = lineBreakOf(text);
  if (at === -1) return text;
  if (at !== null) return `${text.slice(0, at)}\n${text.slice(at + 1)}`;
  return (text.match(LINE_SIZED) ?? []).map((line) => line.trim()).join('\n');
}

/**
 * In time order, none running into the next (segment and word times may overlap), each
 * lasting: a cue with no length shows `minCueMs` up to the next one, or is dropped when
 * the next starts at the same moment (it could never be seen).
 */
function separated(cues: readonly SubtitleCue[]): SubtitleCue[] {
  const ordered = [...cues].sort((a, b) => a.startMs - b.startMs);
  return ordered.flatMap((cue, index) => {
    const next = ordered[index + 1];
    const limit = next ? next.startMs : Number.POSITIVE_INFINITY;
    const wanted =
      cue.endMs > cue.startMs
        ? cue.endMs
        : cue.startMs + SUBTITLE_RULES.minCueMs;
    const endMs = Math.min(wanted, limit);
    return endMs > cue.startMs ? [{ ...cue, endMs }] : [];
  });
}

function wordsBySegment(
  words: readonly DerivedWord[],
): Map<number, TimedWord[]> {
  const bySegment = new Map<number, TimedWord[]>();
  for (const word of words)
    bySegment.set(word.segment, [
      ...(bySegment.get(word.segment) ?? []),
      capped(word),
    ]);
  return bySegment;
}

/**
 * The cues of a transcript (ADR 0023 §8): from the word times where there are words, from
 * the segment times where whisper gave none. Pure: the same transcript, the same cues.
 */
export function cuesOf(transcript: {
  readonly segments: readonly DerivedSegment[];
  readonly words: readonly DerivedWord[];
}): SubtitleCue[] {
  const bySegment = wordsBySegment(transcript.words);
  const cues: SubtitleCue[] = [];
  let run: TimedWord[] = [];
  transcript.segments.forEach((segment, index) => {
    const words = bySegment.get(index);
    if (words) {
      run.push(...words);
      return;
    }
    cues.push(...cuesOfWords(run), ...spreadText(segment.text, segment));
    run = [];
  });
  cues.push(...cuesOfWords(run));
  return separated(cues).map((cue) => ({ ...cue, text: linesOf(cue.text) }));
}

const pad = (value: number, size = 2): string =>
  String(value).padStart(size, '0');

/** `hh:mm:ss.mmm`, as WebVTT requires. */
export function vttTime(ms: number): string {
  const whole = Math.max(0, Math.round(ms));
  const hours = Math.floor(whole / 3_600_000);
  const minutes = Math.floor((whole % 3_600_000) / 60_000);
  const seconds = Math.floor((whole % 60_000) / 1000);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(whole % 1000, 3)}`;
}

/** Cue text is markup in WebVTT: the three special characters are escaped. */
const escapeCueText = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function formatWebVtt(cues: readonly SubtitleCue[]): string {
  const blocks = cues.map(
    (cue, index) =>
      `${index + 1}\n${vttTime(cue.startMs)} --> ${vttTime(cue.endMs)}\n${escapeCueText(cue.text)}`,
  );
  return ['WEBVTT', ...blocks].join('\n\n') + '\n';
}
