import { describe, expect, it } from 'vitest';
import { holdsName, mentionsName } from './voice-names.js';

describe('mentionsName (KBC-090)', () => {
  it('sees the name, but not inside the right one', () => {
    expect(mentionsName('São Pedro', 'Pedro', 'Marcos')).toBe(true);
    expect(mentionsName('Pedro Silva e nada', 'Pedro', 'Pedro Silva')).toBe(
      false,
    );
    expect(mentionsName('Pedrosa', 'Pedro', null)).toBe(false);
  });

  it('reads the name in any case and however its accents are stored', () => {
    expect(mentionsName('JOANA PRADO (parte 2)', 'Joana Prado', null)).toBe(
      true,
    );
    expect(
      mentionsName('Márcio da Roça'.normalize('NFD'), 'Márcio da Roça', null),
    ).toBe(true);
  });
});

describe('holdsName (KBC-102)', () => {
  it('holds a name whole, word by word, as the catalog compares names', () => {
    expect(holdsName('Laércio Fonseca', 'Laércio')).toBe(true);
    expect(holdsName('Fonseca, Laércio', 'Laércio')).toBe(true);
    expect(holdsName('Laércio, Fonseca', 'Laércio')).toBe(true);
    expect(holdsName('Laércio-Fonseca', 'Laércio')).toBe(true);
    expect(holdsName('Laércio', 'Laercio')).toBe(true);
    expect(holdsName('Ana Lima Souza', 'ana lima')).toBe(true);
  });

  it('never a piece of a word, nor words that are apart', () => {
    expect(holdsName('Anabela Souza', 'Ana')).toBe(false);
    expect(holdsName('Ana Lima Souza', 'Ana Souza')).toBe(false);
    expect(holdsName('Ana Souza', 'Ana Lima')).toBe(false);
    expect(holdsName('Ana Souza', '—')).toBe(false);
  });
});
