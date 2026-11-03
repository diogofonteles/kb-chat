import type { DerivedSegment } from '../../ports/transcript-store.js';

/**
 * The transcript as the AI reads it (KBC-067 FR-2; plan in the KBC-063 research, sections
 * 3 and 9): numbered segments with their voice, in windows of fixed length, with cut
 * candidates found by code so the model guesses less.
 */

/** Ten minutes per window: long enough to hold a question with its answer, short enough for the output cap. */
export const WINDOW_MS = 10 * 60_000;
/** A silence this long before a segment makes it a cut candidate (KBC-044's map later). */
export const CANDIDATE_SILENCE_MS = 1_000;

/** The marks around the transcript in the prompt; text inside may never close them. */
const DATA_MARK = /<\s*\/?\s*transcri[cç][aã]o\s*>/giu;

/**
 * Text from the recording or the upload (speech, title, names) made safe to quote in the
 * prompt: one line, without the transcript marks, so it can neither forge a segment line
 * ("\n[999] …") nor step out of the data (KBC-067 review: prompt injection).
 */
export function asData(text: string): string {
  return text.replace(DATA_MARK, ' ').replace(/\s+/g, ' ').trim();
}

/** One segment as sent: its 1-based id, times, text and voice (null without KBC-064). */
export interface PromptSegment {
  readonly id: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly voice: number | null;
}

/** The segments with their voices, numbered from 1 in the transcript's order. */
export function toPromptSegments(
  segments: readonly DerivedSegment[],
  voices: readonly (number | null)[] | null,
): PromptSegment[] {
  return segments.map((segment, index) => ({
    id: index + 1,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: asData(segment.text),
    voice: voices?.[index] ?? null,
  }));
}

/** Consecutive windows by start time; a window without segments is skipped. */
export function splitWindows(
  segments: readonly PromptSegment[],
  windowMs = WINDOW_MS,
): PromptSegment[][] {
  const windows = new Map<number, PromptSegment[]>();
  for (const segment of segments) {
    const key = Math.floor(segment.startMs / windowMs);
    windows.set(key, [...(windows.get(key) ?? []), segment]);
  }
  return [...windows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, window]) => window);
}

/** Whether a segment may start a track: another voice, a question just asked, a silence. */
function isCandidate(segment: PromptSegment, previous: PromptSegment): boolean {
  const voiceChanged =
    segment.voice !== null &&
    previous.voice !== null &&
    segment.voice !== previous.voice;
  return (
    voiceChanged ||
    previous.text.endsWith('?') ||
    segment.startMs - previous.endMs >= CANDIDATE_SILENCE_MS
  );
}

/** The ids of a window where a track may start, judged against the segment before each. */
export function cutCandidates(
  window: readonly PromptSegment[],
  before: PromptSegment | null,
): number[] {
  const candidates: number[] = [];
  let previous = before;
  for (const segment of window) {
    if (previous && isCandidate(segment, previous)) candidates.push(segment.id);
    previous = segment;
  }
  return candidates;
}

/** How long each voice speaks and in how many segments ("quem fala mais", BR-5). */
export interface VoiceStat {
  readonly voice: number;
  readonly speakingMs: number;
  readonly segments: number;
}

export function voiceStats(segments: readonly PromptSegment[]): VoiceStat[] {
  const stats = new Map<number, { speakingMs: number; segments: number }>();
  for (const segment of segments) {
    if (segment.voice === null) continue;
    const stat = stats.get(segment.voice) ?? { speakingMs: 0, segments: 0 };
    stats.set(segment.voice, {
      speakingMs: stat.speakingMs + segment.endMs - segment.startMs,
      segments: stat.segments + 1,
    });
  }
  return [...stats.entries()]
    .sort(([a], [b]) => a - b)
    .map(([voice, stat]) => ({ voice, ...stat }));
}

/** "Voz 3": the label a voice has in the prompt and in the model's answer. */
export const voiceLabel = (voice: number): string => `Voz ${voice}`;

/** The voice a label names, or null ("plateia", an invented name, null). */
export function voiceOfLabel(label: unknown): number | null {
  if (typeof label !== 'string') return null;
  const match = /^\s*voz\s+(\d{1,2})\s*$/i.exec(label);
  const voice = match ? Number(match[1]) : NaN;
  return voice >= 1 && voice <= 10 ? voice : null;
}

/** mm:ss from the start of the recording (minutes go past 59 in long ones). */
export function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = String(Math.floor(seconds / 60)).padStart(2, '0');
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/** One line of the prompt: `[id] mm:ss Voz N: texto`, without the voice when unknown. */
export function segmentLine(segment: PromptSegment): string {
  const voice = segment.voice === null ? '' : ` ${voiceLabel(segment.voice)}:`;
  return `[${segment.id}] ${clock(segment.startMs)}${voice} ${segment.text}`;
}
