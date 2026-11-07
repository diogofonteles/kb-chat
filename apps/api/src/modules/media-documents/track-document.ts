import { createHash } from 'node:crypto';
import {
  TRACK_ANCHOR,
  formatTrackClock,
  type TranscriptConfidence,
} from '@kb-chat/contracts';
import { stringify } from 'yaml';

/** The renderer's version, written into every document (ADR 0035 §2). */
export const RENDER_VERSION = 1;

/** One segment of the track's current transcript, on the track's clock. */
export interface DocumentSegment {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  /** A named speaker (KBC-065) opens a paragraph of its own. */
  readonly speaker?: string | null;
}

/** Everything a track document is made of, read from media.db (ADR 0035 §2). */
export interface TrackDocumentInput {
  /** The collection's vault folder (a sub-collection has its own). */
  readonly topic: string;
  readonly mediaId: string;
  readonly kind: 'track' | 'recording';
  readonly title: string;
  readonly recordingId: string;
  readonly recordingTitle: string;
  readonly ordinal: number | null;
  readonly total: number | null;
  /** Where the track starts in its recording. */
  readonly startMs: number;
  readonly durationMs: number;
  readonly confidence: TranscriptConfidence;
  /** The media's authorship (ADR 0015): the collection's main author or the others. */
  readonly authorship: 'mestre-laercio' | 'outros-autores';
  /** The author's name, as the collection lists it (ADR 0030); null without one. */
  readonly author: string | null;
  /** Accepted subjects (KBC-069), by name. */
  readonly subjects: readonly string[];
  /** The collection's `domain` in its topic.yaml (kb lint wants it); null without one. */
  readonly domain: string | null;
  /**
   * When the transcript in use was made (ISO): the document's `scraped` date, from the
   * state and never from the clock, so the same track renders the same text (BR-2).
   */
  readonly transcribedAt: string;
  readonly segments: readonly DocumentSegment[];
}

export interface RenderedDocument {
  /** Relative to the collection's vault folder. */
  readonly path: string;
  readonly markdown: string;
  /** sha256 of the document before kb touches it, without this key. */
  readonly fingerprint: string;
}

/** `raw/media/<recording>/<track>.md`; a recording without tracks under its own id. */
export const trackDocumentPath = (
  input: Pick<TrackDocumentInput, 'kind' | 'recordingId' | 'mediaId'>,
): string =>
  `raw/media/${input.recordingId}/${input.kind === 'recording' ? input.recordingId : input.mediaId}.md`;

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** A time the speaker said in brackets would read as an anchor: it keeps parentheses. */
const withoutAnchors = (text: string): string =>
  text.replace(new RegExp(TRACK_ANCHOR.source, 'g'), '($1)');

/** `[[x]]` in what was said would read as a wikilink to `kb link`: it keeps a space. */
const withoutWikilinks = (text: string): string =>
  text.replaceAll('[[', '[ [').replaceAll(']]', '] ]');

/** Spoken text as the vault may hold it: one line, no anchor and no link of its own. */
const plain = (text: string): string =>
  withoutWikilinks(withoutAnchors(oneLine(text)));

const speechOf = (segment: DocumentSegment): string => plain(segment.text);

/** A name between `**` cannot carry its own `*`. */
const speakerOf = (segment: DocumentSegment): string =>
  segment.speaker ? plain(segment.speaker.replaceAll('*', '')) : '';

/**
 * One paragraph per spoken segment (KBC-099 AC-1), each opened by its anchor: every passage
 * the agent may cite has its own time, so a citation lands on one segment of media.db.
 * This is finer than ADR 0035 §2's 600-character paragraphs, which would leave most
 * segments without an anchor of their own.
 */
function paragraphLine(segment: DocumentSegment): string {
  const name = speakerOf(segment);
  const speaker = name ? `**${name}:** ` : '';
  return `[${formatTrackClock(segment.startMs)}] ${speaker}${speechOf(segment)}`;
}

/** "Gravação: <recording> · faixa n de N · <author> · <duration>". */
function recordingLine(input: TrackDocumentInput): string {
  const parts = [
    `Gravação: ${oneLine(input.recordingTitle)}`,
    input.ordinal && input.total
      ? `faixa ${input.ordinal} de ${input.total}`
      : '',
    input.author ? oneLine(input.author) : '',
    formatTrackClock(input.durationMs),
  ];
  return parts.filter(Boolean).join(' · ');
}

/** The keys the app owns, in a fixed order; kb leaves them as they are. */
function headerOf(input: TrackDocumentInput): Record<string, unknown> {
  const source = `${input.recordingId}/${input.kind === 'recording' ? input.recordingId : input.mediaId}`;
  return {
    title: oneLine(input.title),
    type: 'source',
    stage: 'raw',
    source_kind: 'media-transcript',
    source_path: `media/${input.topic}/${source}`,
    // What `kb lint` requires of a raw document (KBC-099 spike, kb 0.0.12).
    ...(input.domain ? { domain: input.domain } : {}),
    scraped: input.transcribedAt.slice(0, 10),
    tags: [input.domain, 'raw', 'media-transcript'].filter(Boolean),
    author_group: input.authorship,
    ...(input.author ? { author: oneLine(input.author) } : {}),
    kb_chat_media_id: input.mediaId,
    kb_chat_media_kind: input.kind,
    kb_chat_recording_id: input.recordingId,
    kb_chat_recording_title: oneLine(input.recordingTitle),
    ...(input.ordinal ? { kb_chat_track_ordinal: input.ordinal } : {}),
    ...(input.total ? { kb_chat_tracks_total: input.total } : {}),
    kb_chat_start_ms: input.startMs,
    kb_chat_duration_ms: input.durationMs,
    kb_chat_confidence: input.confidence,
    kb_chat_subjects: input.subjects.map(oneLine),
    kb_chat_render: RENDER_VERSION,
  };
}

const yamlOf = (data: Record<string, unknown>): string =>
  stringify(data, { lineWidth: 0 });

/**
 * The Markdown of one track (ADR 0035 §2): the app's frontmatter, the title, the recording
 * line and one anchored paragraph per run of speech. The same track in the same state always
 * gives the same text and fingerprint (BR-2).
 */
export function renderTrackDocument(
  input: TrackDocumentInput,
): RenderedDocument {
  const header = headerOf(input);
  const body = [
    `# ${oneLine(input.title)}`,
    recordingLine(input),
    ...input.segments.filter((one) => speechOf(one)).map(paragraphLine),
  ].join('\n\n');
  const unsigned = `---\n${yamlOf(header)}---\n\n${body}\n`;
  const fingerprint = createHash('sha256').update(unsigned).digest('hex');
  const markdown = `---\n${yamlOf({ ...header, kb_chat_fingerprint: fingerprint })}---\n\n${body}\n`;
  return { path: trackDocumentPath(input), markdown, fingerprint };
}
