import { describe, expect, it } from 'vitest';
import { anEntryWith } from '../../../test/usage-factories.js';
import { topSuggestions } from './suggestions.js';

describe('topSuggestions (KBC-006 BR-1, AC-1)', () => {
  it('returns the six subjects with the most documents, ties alphabetically', () => {
    const counts: Record<string, number> = {
      Alquimia: 9,
      Cabala: 8,
      Tarô: 7,
      Gnosticismo: 6,
      Astrologia: 5,
      Ritmo: 5,
      Ocultismo: 2,
      Magia: 1,
    };
    const entries = Object.entries(counts).flatMap(([concept, n]) =>
      Array.from({ length: n }, () => anEntryWith([concept])),
    );
    expect(topSuggestions(entries).items).toEqual([
      { concept: 'Alquimia', count: 9 },
      { concept: 'Cabala', count: 8 },
      { concept: 'Tarô', count: 7 },
      { concept: 'Gnosticismo', count: 6 },
      { concept: 'Astrologia', count: 5 },
      { concept: 'Ritmo', count: 5 },
    ]);
  });

  it('merges a subject written with its wiki path (KBC-002 BR-5)', () => {
    const entries = [
      anEntryWith(['[[hermetismo/wiki/concepts/Cabala]]']),
      anEntryWith(['Cabala']),
    ];
    expect(topSuggestions(entries).items).toEqual([
      { concept: 'Cabala', count: 2 },
    ]);
  });

  it('is empty for a collection without subjects', () => {
    expect(topSuggestions([anEntryWith([])]).items).toEqual([]);
  });
});
