import { describe, expect, it } from 'vitest';
import { trackFindingFocus } from './track-findings.js';

const BODY = [
  '# O que é o ritmo?',
  '',
  'Gravação: Palestra · faixa 1 de 2 · Mestre Laércio · 3:48',
  '',
  '[0:03] Pergunta sobre o ritmo',
  '',
  '[3:10] O ritmo é a lei do [[Pêndulo|pêndulo]] que tudo governa',
  '',
  '[3:40] Tudo flui para fora e para dentro',
].join('\n');

const whole = [{ body: BODY, start: 0, end: BODY.length }];

describe('trackFindingFocus (KBC-101 BR-4, ADR 0035 §6 c)', () => {
  it('AC-4: a finding that quotes a passage lands on its anchor, wikilinks read as text', () => {
    const placed = trackFindingFocus(
      '“O ritmo é a lei do pêndulo que tudo governa”, diz ele',
      whole,
    );
    expect(placed.focus).toBe(190);
    expect(placed.anchors).toEqual([3, 190, 220]);
  });

  it('AC-4: a quote the text does not have falls back to the start of the window read', () => {
    const start = BODY.indexOf('[3:10]');
    const placed = trackFindingFocus('“uma frase que ninguém disse”', [
      { body: BODY, start, end: BODY.length },
    ]);
    expect(placed.focus).toBe(190);
    expect(placed.anchors).toEqual([190, 220]);
  });

  it('a finding with no quote, or a quote too short, takes the window start too', () => {
    expect(trackFindingFocus('fala do ritmo', whole).focus).toBe(3);
    expect(trackFindingFocus('“ritmo”', whole).focus).toBe(3);
  });
});
