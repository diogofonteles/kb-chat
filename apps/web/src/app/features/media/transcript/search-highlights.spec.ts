import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { SEARCH_HIGHLIGHTS } from './search-highlights.js';

class FakeHighlight {
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

describe('SEARCH_HIGHLIGHTS (KBC-038 FR-8, NFR-2)', () => {
  it('paints and clears through the CSS Custom Highlight registry', () => {
    const registry = new Map<string, unknown>();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: DOCUMENT,
          useValue: {
            defaultView: {
              CSS: { highlights: registry },
              Highlight: FakeHighlight,
            },
          },
        },
      ],
    });
    const highlights = TestBed.inject(SEARCH_HIGHLIGHTS);
    const range = document.createRange();
    highlights.show('transcript-match', [range]);
    expect(registry.get('transcript-match')).toEqual(new FakeHighlight(range));
    highlights.clear('transcript-match');
    expect(registry.has('transcript-match')).toBe(false);
  });

  it('paints nothing where the browser has no highlight API', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: DOCUMENT, useValue: { defaultView: {} } }],
    });
    const highlights = TestBed.inject(SEARCH_HIGHLIGHTS);
    expect(() => {
      highlights.show('transcript-current', []);
      highlights.clear('transcript-current');
    }).not.toThrow();
  });
});
