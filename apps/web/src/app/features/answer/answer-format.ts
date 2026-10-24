import type { AnswerSource } from '@kb-chat/contracts';
import { Marked } from 'marked';

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

/** "[2]" → a link to source 2 named after it; the panel opens on click. */
export function renderAnswer(
  text: string,
  sources: readonly AnswerSource[] = [],
): string {
  // Raw HTML in the text is escaped above, so every <table> here is Markdown's own.
  const html = (answerMarkdown.parse(text) as string)
    .replaceAll('<table>', '<div class="table-scroll"><table>')
    .replaceAll('</table>', '</table></div>');
  return html.replace(/\[(\d{1,2})\]/g, (match, n: string) => {
    const source = sources.find((s) => s.n === Number(n));
    if (!source) return match;
    const label = escapeHtml(`Fonte ${n}: ${source.title}`);
    return `<a class="cite" href="#fonte-${n}" aria-label="${label}" title="${label}">[${n}]</a>`;
  });
}

/** Source number of a citation link, or null when the click was elsewhere. */
export function citedSource(target: EventTarget | null): number | null {
  const link = target instanceof Element ? target.closest('a.cite') : null;
  const match = /#fonte-(\d+)$/.exec(link?.getAttribute('href') ?? '');
  return match ? Number(match[1]) : null;
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
