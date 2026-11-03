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

/** True when `word` must start a new cue after `current` (silence, sentence, 6 s, 84). */
function breaksBefore(current: readonly TimedWord[], word: TimedWord): boolean {
  const first = current[0];
  const last = current[current.length - 1];
  if (!first || !last) return false;
  if (SENTENCE_END.test(last.text)) return true;
  if (word.startMs - last.endMs >= SUBTITLE_RULES.silenceMs) return true;
  if (word.endMs - first.startMs > SUBTITLE_RULES.maxCueMs) return true;
  return joinWords([...current, word]).length > SUBTITLE_RULES.maxCueChars;
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

/** Words of the text, a word longer than a whole cue cut into cue-sized parts. */
const tokensOf = (text: string): string[] =>
  text
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .flatMap(
      (token) =>
        token.match(new RegExp(`.{1,${SUBTITLE_RULES.maxCueChars}}`, 'gsu')) ??
        [],
    );

/** About `count` pieces of similar length, none over the cue limit. */
function piecesOf(text: string, count: number): string[] {
  const target = Math.ceil(text.length / count);
  const pieces: string[] = [];
  let current = '';
  for (const token of tokensOf(text)) {
    const joined = current ? `${current} ${token}` : token;
    const full =
      joined.length > SUBTITLE_RULES.maxCueChars || current.length >= target;
    if (current && full) {
      pieces.push(current);
      current = token;
    } else current = joined;
  }
  if (current) pieces.push(current);
  return pieces;
}

/**
 * A text over a span, in as many cues as the limits need, each timed by its share of the
 * characters (a segment without word times, or one word longer than a cue).
 */
function spreadText(text: string, span: Span): SubtitleCue[] {
  const length = text.trim().length;
  if (length === 0) return [];
  const duration = Math.max(0, span.endMs - span.startMs);
  const count = Math.max(
    1,
    Math.ceil(length / SUBTITLE_RULES.maxCueChars),
    Math.ceil(duration / SUBTITLE_RULES.maxCueMs),
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
  groupWords(words).flatMap((group) => {
    const first = group[0];
    const last = group[group.length - 1];
    if (!first || !last) return [];
    const span = { startMs: first.startMs, endMs: last.endMs };
    return spreadText(joinWords(group), span);
  });

/** Two lines of at most 42 characters when the text is longer than one (the best split). */
export function linesOf(text: string): string {
  if (text.length <= SUBTITLE_RULES.maxLineChars) return text;
  let best = -1;
  let bestLongest = Number.POSITIVE_INFINITY;
  for (let at = text.indexOf(' '); at !== -1; at = text.indexOf(' ', at + 1)) {
    const longest = Math.max(at, text.length - at - 1);
    if (longest < bestLongest) [best, bestLongest] = [at, longest];
  }
  return best === -1 ? text : `${text.slice(0, best)}\n${text.slice(best + 1)}`;
}

/** No cue runs into the next one (whisper's word times may overlap). */
const separated = (cues: readonly SubtitleCue[]): SubtitleCue[] =>
  cues.map((cue, index) => {
    const next = cues[index + 1];
    const endMs =
      next && next.startMs > cue.startMs
        ? Math.min(cue.endMs, next.startMs)
        : cue.endMs;
    return { ...cue, endMs: Math.max(endMs, cue.startMs) };
  });

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
