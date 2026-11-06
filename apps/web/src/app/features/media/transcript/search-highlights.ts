import { DOCUMENT } from '@angular/common';
import { InjectionToken, inject } from '@angular/core';

/**
 * The looks painted over the transcript: every search occurrence, the current one, the
 * passage opened from a search hit (KBC-039 AC-10) and the spoken word (KBC-045); and the
 * spoken word in a track's text (KBC-092), under its own name so that neither view clears
 * the other's.
 */
export type SearchHighlightName =
  | 'transcript-match'
  | 'transcript-current'
  | 'transcript-passage'
  | 'transcript-word'
  | 'track-word';

/**
 * Paints ranges of text without touching the DOM (CSS Custom Highlight API): marking
 * thousands of occurrences in a 2 h transcript costs no layout (KBC-038 NFR-2), and text
 * selection and the browser's find keep working. Where the API is missing, nothing is
 * painted; the current occurrence's segment still shows its outline.
 */
export interface SearchHighlights {
  show(name: SearchHighlightName, ranges: readonly Range[]): void;
  clear(name: SearchHighlightName): void;
  /** False where nothing can be painted: a view then marks a line instead (KBC-092). */
  readonly paints?: boolean;
}

interface HighlightRegistry {
  set(name: string, highlight: unknown): unknown;
  delete(name: string): boolean;
}

type HighlightConstructor = new (...ranges: Range[]) => { priority: number };

/**
 * What the person looks for stays readable over the word going by. The word stays at the
 * default 0: WebKit does not draw the underline of a highlight with a negative priority.
 */
const PRIORITY: Readonly<Record<SearchHighlightName, number>> = {
  'transcript-match': 1,
  'transcript-current': 1,
  'transcript-passage': 1,
  'transcript-word': 0,
  'track-word': 0,
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
        return {
          show: () => undefined,
          clear: () => undefined,
          paints: false,
        };
      return {
        paints: true,
        show: (name, ranges) => {
          const highlight = new Highlight(...ranges);
          highlight.priority = PRIORITY[name];
          registry.set(name, highlight);
        },
        clear: (name) => registry.delete(name),
      };
    },
  },
);
