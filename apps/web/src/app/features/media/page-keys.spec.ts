import { afterEach, describe, expect, it } from 'vitest';
import { scrollPageByKey } from './page-keys.js';

const MOVES = new WeakMap<HTMLElement, number[]>();

function aScroller(): HTMLElement {
  const scroller = document.createElement('div');
  Object.defineProperty(scroller, 'clientHeight', { value: 500 });
  Object.defineProperty(scroller, 'scrollHeight', { value: 3000 });
  const moves: number[] = [];
  scroller.scrollTo = ((options: ScrollToOptions) => {
    moves.push(options.top ?? 0);
    scroller.scrollTop = options.top ?? 0;
  }) as typeof scroller.scrollTo;
  MOVES.set(scroller, moves);
  document.body.append(scroller);
  return scroller;
}

const movesOf = (scroller: HTMLElement) => MOVES.get(scroller) ?? [];

function press(on: EventTarget, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  Object.defineProperty(event, 'target', { value: on });
  return event;
}

describe('scrollPageByKey (a media page right after it opens)', () => {
  afterEach(() => document.body.replaceChildren());

  it('moves the page with PageDown, Space, the arrows, End and Home when nothing has the focus', () => {
    const scroller = aScroller();
    for (const [key, init] of [
      ['PageDown', {}],
      [' ', {}],
      [' ', { shiftKey: true }],
      ['ArrowDown', {}],
      ['End', {}],
      ['Home', {}],
    ] as const) {
      const event = press(document.body, key, init);
      scrollPageByKey(scroller, event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(movesOf(scroller)).toEqual([460, 920, 460, 500, 3000, 0]);
  });

  it('leaves a key that has a focused control, a modifier or an open dialog alone', () => {
    const scroller = aScroller();
    const field = document.createElement('input');
    document.body.append(field);
    scrollPageByKey(scroller, press(field, 'PageDown'));
    scrollPageByKey(
      scroller,
      press(document.body, 'PageDown', { ctrlKey: true }),
    );
    scrollPageByKey(scroller, press(document.body, 'a'));
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    document.body.append(dialog);
    scrollPageByKey(scroller, press(document.body, 'PageDown'));
    expect(movesOf(scroller)).toEqual([]);
  });
});
