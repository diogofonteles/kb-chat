import tokens from '../../../styles/tokens.json';
import { contrastRatio } from './contrast.js';

type Theme = keyof typeof tokens.color;
type ColorName = keyof (typeof tokens.color)['light'];

/** BR-4: text and accent ≥ 4.5:1 on backgrounds and surfaces, focus ring ≥ 3:1 (WCAG 2.2 AA). */
const PAIRS: readonly (readonly [ColorName, ColorName, number])[] = [
  ['text', 'bg', 4.5],
  ['text', 'surface', 4.5],
  ['text', 'surface-muted', 4.5],
  ['text-muted', 'bg', 4.5],
  ['text-muted', 'surface', 4.5],
  ['accent', 'bg', 4.5],
  ['accent', 'surface', 4.5],
  ['accent', 'surface-muted', 4.5],
  ['accent-strong', 'surface', 4.5],
  ['on-accent', 'accent', 4.5],
  ['text', 'mark', 4.5],
  ['focus', 'bg', 3],
  ['focus', 'surface', 3],
  ['danger', 'surface', 4.5],
];

describe('theme contrast (KBC-005 BR-4)', () => {
  for (const theme of Object.keys(tokens.color) as Theme[]) {
    for (const [fg, bg, min] of PAIRS) {
      it(`${theme}: ${fg} on ${bg} ≥ ${min}`, () => {
        const colors = tokens.color[theme];
        expect(
          contrastRatio(colors[fg].$value, colors[bg].$value),
        ).toBeGreaterThanOrEqual(min);
      });
    }
  }

  it('computes known ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
  });
});
