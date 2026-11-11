import { DOCUMENT } from '@angular/common';
import { InjectionToken, inject } from '@angular/core';

/** Where a point falls in the text: a node, and the character in it. */
export interface TextCaret {
  readonly node: Node;
  readonly offset: number;
}

export type CaretAtPoint = (x: number, y: number) => TextCaret | null;

/** Chrome and Firefox have the standard call; Safari before 26, only the older one. */
interface CaretDocument {
  caretPositionFromPoint?(
    x: number,
    y: number,
  ): { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?(x: number, y: number): Range | null;
}

/**
 * The character under a click (KBC-045 FR-3): the words have no elements of their own
 * (KBC-038 NFR-2), so the browser is asked where in the text the point falls. Null where
 * it cannot say; the click then plays the segment.
 */
export const CARET_AT_POINT = new InjectionToken<CaretAtPoint>(
  'CARET_AT_POINT',
  {
    providedIn: 'root',
    factory: () => {
      const document: CaretDocument = inject(DOCUMENT);
      return (x, y) => {
        if (document.caretPositionFromPoint) {
          const caret = document.caretPositionFromPoint(x, y);
          return caret && { node: caret.offsetNode, offset: caret.offset };
        }
        const range = document.caretRangeFromPoint?.(x, y);
        return range
          ? { node: range.startContainer, offset: range.startOffset }
          : null;
      };
    },
  },
);
