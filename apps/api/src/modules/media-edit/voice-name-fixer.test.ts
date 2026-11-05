import { describe, expect, it } from 'vitest';
import { fixesOf, withNameFixed } from './voice-name-fixer.js';

const FIX = { from: 'Márcio da Roça', to: 'Márcio da Rós' };
const label = (voice: number, name: string | null) => ({
  voice,
  audience: false,
  mergedInto: null,
  speaker: name
    ? { id: `s${voice}`, collection: 'udv', name, authorSlug: null }
    : null,
});
const suggestion = (voice: number, name: string | null) => ({
  voice,
  name,
  audience: false,
  reason: 'se apresenta',
});

describe('withNameFixed (KBC-090)', () => {
  it('changes every whole mention, in any case', () => {
    expect(
      withNameFixed('Márcio da Roça e MÁRCIO DA ROÇA falam', FIX, 80),
    ).toBe('Márcio da Rós e Márcio da Rós falam');
  });

  it('leaves a longer word alone', () => {
    const text = 'Márcio da Roçado fala';
    expect(withNameFixed(text, FIX, 80)).toBe(text);
  });

  it('keeps a name with symbols literal', () => {
    expect(
      withNameFixed('Sr. (José) fala', { from: 'Sr. (José)', to: 'José' }, 80),
    ).toBe('José fala');
  });

  it('keeps the text when the right name would not fit', () => {
    const text = 'Márcio da Roça';
    expect(withNameFixed(text, { ...FIX, to: 'x'.repeat(20) }, 15)).toBe(text);
  });
});

describe('fixesOf (KBC-090)', () => {
  it('pairs what the run suggested with the name a person gave', () => {
    expect(fixesOf([suggestion(1, FIX.from)], [label(1, FIX.to)])).toEqual([
      FIX,
    ]);
  });

  it('has nothing to do before a name, or with the same name', () => {
    expect(fixesOf([suggestion(1, FIX.from)], [label(1, null)])).toEqual([]);
    expect(fixesOf([suggestion(1, FIX.from)], [label(1, FIX.from)])).toEqual(
      [],
    );
    expect(fixesOf([suggestion(1, null)], [label(1, FIX.to)])).toEqual([]);
  });

  it("never rewrites a name that is another voice's by a person", () => {
    expect(
      fixesOf([suggestion(1, 'Ana')], [label(1, 'Beatriz'), label(2, 'Ana')]),
    ).toEqual([]);
  });
});
