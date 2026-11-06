import {
  SOURCE_CITATION,
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
 * "[2]" → a link to source 2 named after it; the panel opens on click. A track's "[2@8:15]"
 * shows as "[2]" too (T22), and its link keeps the time it cites.
 */
export function renderAnswer(
  text: string,
  sources: readonly AnswerSource[] = [],
): string {
  // Raw HTML in the text is escaped above, so every <table> here is Markdown's own.
  const html = (answerMarkdown.parse(text) as string)
    .replaceAll('<table>', '<div class="table-scroll"><table>')
    .replaceAll('</table>', '</table></div>');
  return html.replace(
    new RegExp(SOURCE_CITATION.source, 'g'),
    (match, n: string, at: string | undefined) => {
      const source = sources.find((s) => s.n === Number(n));
      if (!source) return match;
      const label = escapeHtml(
        source.media
          ? trackLabel(source, at ?? '')
          : `Fonte ${n}: ${source.title}`,
      );
      // The time rides in the href: Angular's sanitizer keeps it, not a data attribute.
      const time = source.media && at ? `@${at}` : '';
      return `<a class="cite" href="#fonte-${n}${time}" aria-label="${label}" title="${label}">[${n}]</a>`;
    },
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
