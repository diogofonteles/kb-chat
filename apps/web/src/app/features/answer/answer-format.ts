import {
  SOURCE_CITATION,
  formatTrackClock,
  type AnswerSource,
  type TrackPassage,
} from '@kb-chat/contracts';
import { Marked } from 'marked';
import { speak } from '@core/i18n/spoken-time.js';

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Model output is untrusted (a vault document could carry a prompt injection): no raw
 * HTML, no links and no images reach the page, only text and our own citation links
 * (threat model, docs/architecture/overview.md).
 */
const answerMarkdown = new Marked({
  gfm: true,
  breaks: true,
  async: false,
  renderer: {
    html: ({ text }) => escapeHtml(text),
    link({ tokens }) {
      return this.parser.parseInline(tokens);
    },
    image: ({ text }) => escapeHtml(text),
  },
});

/**
 * The passage a citation of a track names (KBC-099): the one resolved for the time it wrote
 * ("" for a plain [n]), else its first; null for a text or an answer saved before it.
 */
export function passageOf(
  source: AnswerSource,
  at: string,
): TrackPassage | null {
  const passages = source.passages ?? [];
  return passages.find((one) => one.at === at) ?? passages[0] ?? null;
}

/** "Fonte 1, faixa O que é o ritmo?, aos 41 segundos" (T22, read by a screen reader). */
function trackLabel(source: AnswerSource, at: string): string {
  const passage = passageOf(source, at);
  const where = passage ? `, aos ${speak(passage.startMs)}` : '';
  return $localize`:@@answer.trackCitation:Fonte ${source.n}:n:, faixa ${source.title}:title:${where}:where:`;
}

/**
 * "[3]" of a source today's reader may not see (KBC-110 FR-5): text, not a link, read as
 * "Fonte 3, restrita".
 */
function restrictedCitation(n: string): string {
  const label = escapeHtml(
    $localize`:@@answer.restrictedCitation:Fonte ${n}:n:, restrita`,
  );
  return `<span class="cite-restricted"><span aria-hidden="true">[${n}]</span><span class="visually-hidden">${label}</span></span>`;
}

/**
 * A track's citation (KBC-150 item 7): a pill with the wave and its number, then "título ·
 * tempo", so it reads apart from a text's "[n]". The link's name says it all for a screen
 * reader; the wave is drawn by CSS (the sanitizer keeps no SVG).
 */
function audioCitation(source: AnswerSource, at: string): string {
  const label = escapeHtml(trackLabel(source, at));
  const time = at ? `@${at}` : '';
  const passage = passageOf(source, at);
  const where = escapeHtml(
    passage
      ? `${source.title} · ${formatTrackClock(passage.startMs)}`
      : source.title,
  );
  return `<a class="cite cite-audio" href="#fonte-${source.n}${time}" aria-label="${label}" title="${label}"><span class="cite-n">${source.n}</span><span class="cite-where">${where}</span></a>`;
}

/** "Ouvir Lembranças da infância aos 1 minuto e 16 segundos": a time in a grouped pill. */
function timeLabel(source: AnswerSource, startMs: number): string {
  return $localize`:@@answer.trackTime:Ouvir ${source.title}:title: aos ${speak(startMs)}:clock:`;
}

/**
 * Citations of the same track side by side, as one pill (KBC-155): the wave and its number,
 * "título · 1:16, 1:21, 0:48", each time a link of its own to that passage.
 */
function groupedCitation(
  source: AnswerSource,
  cited: readonly Pick<Cited, 'at' | 'passage'>[],
): string {
  const times = cited
    .flatMap(({ at, passage }) => (passage ? [{ at, passage }] : []))
    .map(({ at, passage }) => {
      const label = escapeHtml(timeLabel(source, passage.startMs));
      const time = at ? `@${at}` : '';
      return `<a class="cite cite-time" href="#fonte-${source.n}${time}" aria-label="${label}" title="${label}">${formatTrackClock(passage.startMs)}</a>`;
    })
    .join(', ');
  return `<span class="cite-group"><span class="cite-n" aria-hidden="true">${source.n}</span><span class="cite-where"><span aria-hidden="true">${escapeHtml(source.title)} · </span>${times}</span></span>`;
}

/** The answer's sources and the ones today's reader may not see. */
interface Cites {
  readonly sources: readonly AnswerSource[];
  readonly restricted: readonly number[];
}

/** A citation of a run, with the text before it and, for a track, the passage it names. */
interface Cited {
  readonly match: string;
  readonly n: string;
  readonly at: string;
  readonly gap: string;
  readonly track: AnswerSource | null;
  readonly passage: TrackPassage | null;
}

/** One citation as it reads alone: a track's pill, a text's [n], or a restricted number. */
function oneCitation({ match, n, at }: Cited, cites: Cites): string {
  if (cites.restricted.includes(Number(n))) return restrictedCitation(n);
  const source = cites.sources.find((s) => s.n === Number(n));
  if (!source) return match;
  if (source.media) return audioCitation(source, at);
  const label = escapeHtml(`Fonte ${n}: ${source.title}`);
  return `<a class="cite" href="#fonte-${n}" aria-label="${label}" title="${label}">[${n}]</a>`;
}

/** Only spaces, commas or semicolons between two citations: they read as one run. */
const RUN_GAP = String.raw`[\s,;]*`;
const CITATION_RUN = new RegExp(
  `${SOURCE_CITATION.source}(?:${RUN_GAP}${SOURCE_CITATION.source})*`,
  'g',
);

function citationsOf(run: string, cites: Cites): Cited[] {
  let end = 0;
  return [...run.matchAll(new RegExp(SOURCE_CITATION.source, 'g'))].map(
    (found) => {
      const [match, n = '', at = ''] = found;
      const source = cites.restricted.includes(Number(n))
        ? undefined
        : cites.sources.find((s) => s.n === Number(n));
      const track = source?.media ? source : null;
      const gap = run.slice(end, found.index);
      end = found.index + match.length;
      return {
        match,
        n,
        at,
        gap,
        track,
        passage: track ? passageOf(track, at) : null,
      };
    },
  );
}

/** The citations from `from` on that cite the same track's passages; repeats once. */
function sameTrackFrom(cited: readonly Cited[], from: number): Cited[] {
  const first = cited[from];
  if (!first?.track || !first.passage) return first ? [first] : [];
  const group: Cited[] = [];
  for (const one of cited.slice(from)) {
    if (one.track !== first.track || !one.passage) break;
    group.push(one);
  }
  return group;
}

/**
 * A run of citations: each one as it reads alone, except the same track's passages side by
 * side, which become one pill with their times (KBC-155 BR-3); repeated times show once.
 */
function renderRun(run: string, cites: Cites): string {
  const cited = citationsOf(run, cites);
  const out: string[] = [];
  for (let index = 0; index < cited.length;) {
    const group = sameTrackFrom(cited, index);
    const [first] = group as [Cited];
    const distinct = group.filter(
      (one, place) =>
        group.findIndex((other) => other.passage === one.passage) === place,
    );
    out.push(first.gap);
    out.push(
      distinct.length > 1 && first.track
        ? groupedCitation(first.track, distinct)
        : oneCitation(first, cites),
    );
    index += group.length;
  }
  return out.join('');
}

/**
 * "[2]" → a link to source 2 named after it; the panel opens on click. A track's "[2@8:15]"
 * shows its pill, and its link keeps the time it cites; the same track's citations side by
 * side are one pill (KBC-155).
 */
export function renderAnswer(
  text: string,
  sources: readonly AnswerSource[] = [],
  restricted: readonly number[] = [],
): string {
  // Raw HTML in the text is escaped above, so every <table> here is Markdown's own.
  const html = (answerMarkdown.parse(text) as string)
    .replaceAll('<table>', '<div class="table-scroll"><table>')
    .replaceAll('</table>', '</table></div>');
  return html.replace(CITATION_RUN, (run) =>
    renderRun(run, { sources, restricted }),
  );
}

const citationLink = (target: EventTarget | null): Element | null =>
  target instanceof Element ? target.closest('a.cite') : null;

const CITATION_HREF = /#fonte-(\d+)(?:@([\d:]+))?$/;

/** Source number of a citation link, or null when the click was elsewhere. */
export function citedSource(target: EventTarget | null): number | null {
  const match = CITATION_HREF.exec(
    citationLink(target)?.getAttribute('href') ?? '',
  );
  return match ? Number(match[1]) : null;
}

/** The time a clicked citation of a track wrote ("" for a plain [n]). */
export function citedAt(target: EventTarget | null): string {
  const match = CITATION_HREF.exec(
    citationLink(target)?.getAttribute('href') ?? '',
  );
  return match?.[2] ?? '';
}

const usd = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'USD',
  currencyDisplay: 'symbol',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

export function formatCost(value: number): string {
  return usd.format(value);
}
