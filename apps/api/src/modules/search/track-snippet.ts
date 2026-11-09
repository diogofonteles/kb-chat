import { TRACK_ANCHOR, anchorAt } from '@kb-chat/contracts';
import {
  isBodyLine,
  snippetLines,
  truncate,
  type SnippetSource,
} from './snippet.js';

/** A track's snippet as the card shows it, and the second of the paragraph it came from. */
export interface TrackSnippet {
  readonly snippet: string;
  /** The anchor before the snippet; null when it fell outside the speech. */
  readonly seconds: number | null;
}

/** The rendered heading and recording line (ADR 0035 §2): never a passage. */
const HEADER_LINE = /^(#\s|Gravação:)/;

const withoutAnchors = (text: string): string =>
  text.replace(new RegExp(String.raw`${TRACK_ANCHOR.source}\s*`, 'g'), '');

/** The first paragraph that is speech: after the heading and the recording line. */
function firstSpeech(body: string): string {
  const paragraph = body
    .split('\n')
    .find((line) => line.trim() && !HEADER_LINE.test(line.trim()));
  return withoutAnchors(paragraph ?? '');
}

/**
 * The index snippet of a track's document (KBC-101 FR-8): only speech lines, never the
 * frontmatter, the heading, the recording line nor the `[m:ss]` anchors; with the anchor of
 * the paragraph it starts in. Outside the speech, the summary or the first paragraph.
 */
export function trackSnippet(raw: string, source: SnippetSource): TrackSnippet {
  const { body, summary } = source;
  const lines = snippetLines(raw).filter(
    (line) => isBodyLine(line, body) && !HEADER_LINE.test(line.trim()),
  );
  const first = lines[0]
    ?.trim()
    .replace(/(\.\.\.|…)$/, '')
    .trim();
  if (!first)
    return { snippet: truncate(summary ?? firstSpeech(body)), seconds: null };
  return {
    snippet: truncate(withoutAnchors(lines.join(' '))),
    seconds: anchorAt(body, body.indexOf(first)),
  };
}
