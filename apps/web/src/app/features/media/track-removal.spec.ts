import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, it } from 'vitest';
import {
  alsoRemovesText,
  trackListText,
  tracksInTheWay,
} from './track-removal.js';

const refused = (reason: string) =>
  new HttpErrorResponse({
    status: 409,
    error: { error: { details: { reason, tracks: ['Uma', 'Duas'] } } },
  });

describe('removing a recording with tracks (KBC-068)', () => {
  it('reads the tracks out of the refusal', () => {
    expect(tracksInTheWay(refused('has-tracks'))).toEqual(['Uma', 'Duas']);
  });

  it('leaves any other refusal alone', () => {
    expect(tracksInTheWay(refused('track'))).toBeNull();
    expect(tracksInTheWay(new Error('x'))).toBeNull();
  });

  it('lists five titles and counts the rest', () => {
    const titles = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    expect(trackListText(titles)).toBe('a, b, c, d, e +2');
    expect(trackListText(['a'])).toBe('a');
  });

  it('counts the tracks that go along in the singular and in the plural', () => {
    expect(alsoRemovesText(['Pergunta 1'])).toBe(
      'Também remove 1 faixa: Pergunta 1',
    );
    expect(alsoRemovesText(['a', 'b'])).toBe('Também remove 2 faixas: a, b');
  });
});
