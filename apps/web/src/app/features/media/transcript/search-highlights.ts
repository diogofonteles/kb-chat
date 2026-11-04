import { DOCUMENT } from '@angular/common';
import { InjectionToken, inject } from '@angular/core';

/**
 * The looks painted over the transcript: every search occurrence, the current one, the
 * passage opened from a search hit (KBC-039 AC-10) and the spoken word (KBC-045).
 */
export type SearchHighlightName =
  | 'transcript-match'
  | 'transcript-current'
  | 'transcript-passage'
  | 'transcript-word';

/**
 * Paints ranges of text without touching the DOM (CSS Custom Highlight API): marking
 * thousands of occurrences in a 2 h transcript costs no layout (KBC-038 NFR-2), and text
 * selection and the browser's find keep working. Where the API is missing, nothing is
 * painted; the current occurrence's segment still shows its outline.
 */
export interface SearchHighlights {
  show(name: SearchHighlightName, ranges: readonly Range[]): void;
  clear(name: SearchHighlightName): void;
}

interface HighlightRegistry {
  set(name: string, highlight: unknown): unknown;
  delete(name: string): boolean;
}

type HighlightConstructor = new (...ranges: Range[]) => { priority: number };

/** What the person looks for stays readable over the word that goes by (0 is the default). */
const PRIORITY: Partial<Record<SearchHighlightName, number>> = {
  'transcript-word': -1,
};

export const SEARCH_HIGHLIGHTS = new InjectionToken<SearchHighlights>(
  'SEARCH_HIGHLIGHTS',
  {
    providedIn: 'root',
    factory: () => {
      const view = inject(DOCUMENT).defaultView as
        | (Window & {
            CSS?: { highlights?: HighlightRegistry };
            Highlight?: HighlightConstructor;
          })
        | null;
      const registry = view?.CSS?.highlights;
      const Highlight = view?.Highlight;
      if (!registry || !Highlight)
        return { show: () => undefined, clear: () => undefined };
      return {
        show: (name, ranges) => {
          const highlight = new Highlight(...ranges);
          highlight.priority = PRIORITY[name] ?? 0;
          registry.set(name, highlight);
        },
        clear: (name) => registry.delete(name),
      };
    },
  },
);
