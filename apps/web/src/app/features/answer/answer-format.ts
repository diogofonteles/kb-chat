import { renderMarkdown } from '@core/markdown/render-markdown.js';

/** "[2]" → a link to source 2; the panel opens on click (Angular keeps href and class when sanitizing). */
export function renderAnswer(text: string): string {
  const linked = text.replace(
    /\[(\d{1,2})\]/g,
    '<a class="cite" href="#fonte-$1" title="Abrir a fonte $1">[$1]</a>',
  );
  return renderMarkdown(linked);
}

/** Source number of a citation link, or null when the click was elsewhere. */
export function citedSource(target: EventTarget | null): number | null {
  const link = target instanceof Element ? target.closest('a.cite') : null;
  const match = /#fonte-(\d+)$/.exec(link?.getAttribute('href') ?? '');
  return match ? Number(match[1]) : null;
}

/** "menos de US$ 0,01" for the usual answer, otherwise the rounded-up amount. */
export function formatEstimate(usd: number): string {
  if (usd < 0.01) return $localize`:@@ai.lessThanCent:menos de US$ 0,01`;
  const cents = Math.ceil(usd * 100) / 100;
  return `~US$ ${cents.toFixed(2).replace('.', ',')}`;
}

export function formatCost(usd: number): string {
  return `US$ ${usd.toFixed(4).replace('.', ',')}`;
}
