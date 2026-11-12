import { describe, expect, it } from 'vitest';
import { fixesOf, withNameFixed } from './voice-name-fixer.js';

const FIX = { from: 'Márcio da Roça', to: 'Márcio da Rós' };
const label = (voice: number, name: string | null, audience = false) => ({
  voice,
  audience,
  mergedInto: null,
  speaker: name
    ? { id: `s${voice}`, collection: 'udv', name, authorSlug: null }
    : null,
});
const text = (voice: number, name: string, written: string | null = null) => ({
  runId: 'run',
  voice,
  name,
  written,
});
const pairs = (input: Parameters<typeof fixesOf>[0]) =>
  fixesOf(input).map(({ from, to }) => ({ from, to }));

describe('withNameFixed (KBC-090)', () => {
  it('changes every whole mention, in any case', () => {
    expect(
      withNameFixed('Márcio da Roça e MÁRCIO DA ROÇA falam', FIX, 80),
    ).toBe('Márcio da Rós e Márcio da Rós falam');
  });

  it('leaves a longer word, and the name without its accents', () => {
    const text = 'Márcio da Roçado e Marcio da Roca';
    expect(withNameFixed(text, FIX, 80)).toBe(text);
  });

  it('finds a name stored in the decomposed form', () => {
    expect(withNameFixed(FIX.from.normalize('NFD'), FIX, 80)).toBe(FIX.to);
  });

  it('keeps a name with symbols literal', () => {
    expect(
      withNameFixed('Sr. (José) fala', { from: 'Sr. (José)', to: 'José' }, 80),
    ).toBe('José fala');
  });

  it('keeps the text when the right name would not fit', () => {
    const long = { ...FIX, to: 'x'.repeat(20) };
    expect(withNameFixed(FIX.from, long, 15)).toBe(FIX.from);
  });

  it('stays the same on a rerun when the new name holds the old one', () => {
    const fix = { from: FIX.from, to: `${FIX.from} Filho` };
    const once = withNameFixed(FIX.from, fix, 80);
    expect(once).toBe(fix.to);
    expect(withNameFixed(once, fix, 80)).toBe(fix.to);
  });

  it('shortens when the old name holds the new one', () => {
    expect(
      withNameFixed(
        `${FIX.from} Filho`,
        { from: `${FIX.from} Filho`, to: FIX.from },
        80,
      ),
    ).toBe(FIX.from);
  });
});

describe('fixesOf (KBC-090)', () => {
  it('pairs what the run suggested with the name a person gave', () => {
    const texts = [text(1, FIX.from)];
    expect(pairs({ texts, labels: [label(1, FIX.to)], refused: [] })).toEqual([
      FIX,
    ]);
  });

  it('starts from what it wrote, on a second correction', () => {
    const texts = [text(1, FIX.from, FIX.to)];
    expect(
      pairs({ texts, labels: [label(1, 'Márcio Rocha')], refused: [] }),
    ).toEqual([
      { from: FIX.to, to: 'Márcio Rocha' },
      { from: FIX.from, to: 'Márcio Rocha' },
    ]);
  });

  it('goes back to the suggestion on an undo', () => {
    const texts = [text(1, FIX.from, FIX.to)];
    expect(pairs({ texts, labels: [label(1, null)], refused: [] })).toEqual([
      { from: FIX.to, to: FIX.from },
    ]);
  });

  it('has nothing to do with the same name, a one-word name or a refusal', () => {
    const same = [text(1, FIX.from)];
    expect(
      pairs({ texts: same, labels: [label(1, FIX.from)], refused: [] }),
    ).toEqual([]);
    const word = [text(1, 'Pedro')];
    expect(
      pairs({ texts: word, labels: [label(1, FIX.to)], refused: [] }),
    ).toEqual([]);
    expect(
      pairs({ texts: same, labels: [label(1, FIX.to)], refused: [1] }),
    ).toEqual([]);
  });

  it('leaves the text of a voice called the audience', () => {
    const texts = [text(1, FIX.from, FIX.to)];
    expect(
      pairs({ texts, labels: [label(1, null, true)], refused: [] }),
    ).toEqual([]);
  });

  it("never rewrites a name that is another voice's by a person", () => {
    const texts = [text(1, 'Ana Lima')];
    expect(
      pairs({
        texts,
        labels: [label(1, 'Beatriz Lima'), label(2, 'Ana Lima')],
        refused: [],
      }),
    ).toEqual([]);
  });
});
