/**
 * Subtitle cues and transcript segments on the media's clock (KBC-038, ADR 0025 §4): the
 * WebVTT the API serves, parsed for the player's own caption overlay, and the binary
 * searches that find what is showing at a time.
 */

export interface TimedSpan {
  readonly startMs: number;
  readonly endMs: number;
}

export interface Cue extends TimedSpan {
  /** One or two lines, joined by "\n", as plain text. */
  readonly text: string;
}

/**
 * Index of the last span that started at or before `ms` (-1 before the first), by binary
 * search: spans are in start order.
 */
export function lastStartedAt(spans: readonly TimedSpan[], ms: number): number {
  let low = 0;
  let high = spans.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const span = spans[middle];
    if (span && span.startMs <= ms) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

/** The cue on screen at `ms`: started and not ended yet; null in a gap. */
export function cueAt(cues: readonly Cue[], ms: number): Cue | null {
  const cue = cues[lastStartedAt(cues, ms)];
  return cue && ms < cue.endMs ? cue : null;
}

const TIMING =
  /^((?:\d+:)?\d{2}:\d{2}\.\d{3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}\.\d{3})/;

/** `hh:mm:ss.mmm` or `mm:ss.mmm` in ms. */
export function vttTimeToMs(time: string): number {
  const parts = time.split(':').map(Number);
  return Math.round(parts.reduce((total, part) => total * 60 + part, 0) * 1000);
}

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': '\u00a0',
  '&lrm;': '\u200e',
  '&rlm;': '\u200f',
};

/** Cue text as plain text: tags dropped, the WebVTT entities decoded. */
const plainText = (lines: readonly string[]): string =>
  lines
    .join('\n')
    .replace(/<[^>]*>/g, '')
    .replace(
      /&(?:amp|lt|gt|nbsp|lrm|rlm);/g,
      (entity) => ENTITIES[entity] ?? '',
    );

function cueOf(block: string): Cue | null {
  const lines = block.split(/\r?\n/);
  const at = lines.findIndex((line) => line.includes('-->'));
  const timing = at === -1 ? null : TIMING.exec(lines[at]?.trim() ?? '');
  if (!timing?.[1] || !timing[2]) return null;
  const text = plainText(lines.slice(at + 1)).trim();
  if (!text) return null;
  return {
    startMs: vttTimeToMs(timing[1]),
    endMs: vttTimeToMs(timing[2]),
    text,
  };
}

/** The cues of a WebVTT file, in start order; anything else (notes, styles) is skipped. */
export function parseWebVtt(vtt: string): Cue[] {
  if (!vtt.replace(/^\uFEFF/, '').startsWith('WEBVTT')) return [];
  return vtt
    .split(/\r?\n\r?\n/)
    .slice(1)
    .map(cueOf)
    .filter((cue): cue is Cue => cue !== null)
    .sort((a, b) => a.startMs - b.startMs);
}

/** Where the position was last reported, and when (a `performance.now()` time). */
export interface ClockAnchor {
  readonly reportedMs: number;
  readonly atMs: number;
}

/** No guess runs further than this past the last report (a stall, a slow tab). */
export const MAX_EXTRAPOLATION_MS = 1_000;

/**
 * The position between two `timeupdate` events (ADR 0025 §4: interpolated with
 * `requestAnimationFrame` while playing): the last report plus the time since, at the
 * playback rate. A new report becomes the new anchor.
 */
export function interpolate(
  anchor: ClockAnchor | null,
  now: {
    readonly reportedMs: number;
    readonly nowMs: number;
    readonly rate: number;
  },
): { readonly anchor: ClockAnchor; readonly positionMs: number } {
  const current =
    anchor && anchor.reportedMs === now.reportedMs
      ? anchor
      : { reportedMs: now.reportedMs, atMs: now.nowMs };
  const elapsed = Math.min(
    Math.max(0, now.nowMs - current.atMs),
    MAX_EXTRAPOLATION_MS,
  );
  return {
    anchor: current,
    positionMs: current.reportedMs + elapsed * now.rate,
  };
}
