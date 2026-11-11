import { describe, expect, it } from 'vitest';
import { formatBoundary, speakBoundary, stopText } from './track-labels.js';

describe('track labels (KBC-066)', () => {
  it('shows a boundary to the tenth of a second', () => {
    expect(formatBoundary(724_200)).toBe('12:04,2');
    expect(formatBoundary(5_000)).toBe('0:05,0');
    expect(formatBoundary(3_725_500)).toBe('1:02:05,5');
    expect(formatBoundary(59_960)).toBe('1:00,0');
  });

  it('reads a boundary in words, the tenth only when there is one', () => {
    expect(speakBoundary(724_200)).toBe('12 minutos e 4,2 segundos');
    expect(speakBoundary(724_000)).toBe('12 minutos e 4 segundos');
    expect(speakBoundary(4_500)).toBe('4,5 segundos');
  });

  it('says why a handle stopped, and nothing at the recording`s ends', () => {
    expect(stopText({ kind: 'neighbour', ordinal: 4 })).toBe(
      'Encostou na faixa 4',
    );
    expect(stopText({ kind: 'minimum' })).toBe('Mínimo de 5 s');
    expect(stopText({ kind: 'recording' })).toBe('');
    expect(stopText(null)).toBe('');
  });
});
