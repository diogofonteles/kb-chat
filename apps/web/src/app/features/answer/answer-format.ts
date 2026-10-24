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
  const html = answerMarkdown.parse(text) as string;
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

const usd = (fractionDigits: number) =>
  new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'symbol',
    minimumFractionDigits: 2,
    maximumFractionDigits: fractionDigits,
  });

/** "menos de US$ 0,01" for the usual answer (decision 2026-10-24), otherwise the rounded-up amount. */
export function formatEstimate(value: number): string {
  if (value < 0.01) return $localize`:@@ai.lessThanCent:menos de US$ 0,01`;
  return `~${usd(2).format(Math.ceil(value * 100) / 100)}`;
}

export function formatCost(value: number): string {
  return usd(4).format(value);
}

/** The model's own "not enough material" answer (ADR 0004), so the UI can suggest another search. */
export const isInsufficient = (text: string): boolean =>
  /não traz informação suficiente/i.test(text);
