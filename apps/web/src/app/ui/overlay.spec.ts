import { placeOverlay, type OverlayBox } from './overlay.js';

const viewport = { width: 390, height: 844 };
const anchor = (at: {
  left: number;
  top: number;
  width?: number;
}): OverlayBox => ({
  left: at.left,
  top: at.top,
  right: at.left + (at.width ?? 80),
  bottom: at.top + 32,
});

describe('placeOverlay (D5: menus never clipped, always on screen)', () => {
  it('opens under the trigger, its start under the trigger start, when it fits', () => {
    expect(
      placeOverlay({
        anchor: anchor({ left: 40, top: 100 }),
        size: { width: 200, height: 160 },
        viewport,
        align: 'start',
        side: 'below',
      }),
    ).toMatchObject({ top: 138, left: 40, side: 'below' });
  });

  it('opens over its trigger from the offset, and slides up to stay whole (v2 player menus)', () => {
    const desktop = { width: 1440, height: 900 };
    expect(
      placeOverlay({
        anchor: anchor({ left: 855, top: 401, width: 40 }),
        size: { width: 300, height: 440 },
        viewport: desktop,
        align: 'start',
        side: 'over',
        offset: { x: -40, y: -8 },
      }),
    ).toMatchObject({ top: 393, left: 815, side: 'over' });
    const low = placeOverlay({
      anchor: anchor({ left: 855, top: 700, width: 40 }),
      size: { width: 300, height: 440 },
      viewport: desktop,
      align: 'start',
      side: 'over',
      offset: { x: -40, y: -8 },
    });
    expect(low.top).toBe(900 - 8 - 440);
  });

  it('flips above when there is no room below and more above', () => {
    const where = placeOverlay({
      anchor: anchor({ left: 40, top: 760 }),
      size: { width: 200, height: 300 },
      viewport,
      align: 'start',
      side: 'below',
    });
    expect(where.side).toBe('above');
    expect(where.top).toBe(760 - 6 - 300);
  });

  it('slides over its trigger to stay whole when neither side has room for it', () => {
    const where = placeOverlay({
      anchor: anchor({ left: 40, top: 300 }),
      size: { width: 200, height: 500 },
      viewport,
      align: 'start',
      side: 'below',
    });
    expect(where.side).toBe('below');
    // Its foot at the screen's margin, all of it shown: no scrolling inside (D5).
    expect(where.top).toBe(844 - 8 - 500);
    expect(where.maxHeight).toBe(844 - 2 * 8);
  });

  it('takes the whole screen height, and only then scrolls, when taller than the screen', () => {
    const where = placeOverlay({
      anchor: anchor({ left: 40, top: 300 }),
      size: { width: 200, height: 900 },
      viewport,
      align: 'start',
      side: 'below',
    });
    expect(where.top).toBe(8);
    expect(where.maxHeight).toBe(844 - 2 * 8);
  });

  it('shifts left to end inside the viewport, and right past the left edge', () => {
    const size = { width: 240, height: 100 };
    expect(
      placeOverlay({
        anchor: anchor({ left: 300, top: 100 }),
        size,
        viewport,
        align: 'start',
        side: 'below',
      }).left,
    ).toBe(390 - 8 - 240);
    expect(
      placeOverlay({
        anchor: anchor({ left: 0, top: 100, width: 40 }),
        size,
        viewport,
        align: 'end',
        side: 'below',
      }).left,
    ).toBe(8);
  });

  it('never gets wider than the viewport less its margins', () => {
    const where = placeOverlay({
      anchor: anchor({ left: 0, top: 100 }),
      size: { width: 600, height: 100 },
      viewport,
      align: 'start',
      side: 'below',
    });
    expect(where).toMatchObject({ left: 8, maxWidth: 374 });
  });
});
