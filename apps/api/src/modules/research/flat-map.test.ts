import { describe, expect, it } from 'vitest';
import { flatWithMap } from './flat-map.js';
import { flatText } from './folded-text.js';

describe('flatWithMap (KBC-017)', () => {
  it('gives exactly the flatText output', () => {
    const samples = [
      '  Os **Cinco\nPrincípios**  _Universais_ > nota\n\n# Título\t fim  ',
      'a * b',
      '\n\n',
      'Sem marcas.',
      'linha 1\r\nlinha 2',
    ];
    for (const sample of samples) {
      const source = sample.normalize('NFC');
      expect(flatWithMap(source).flat).toBe(flatText(source));
    }
  });

  it('maps every flat character back to where it came from', () => {
    const source = 'Ver o **livro**\n\n  citado.';
    const { flat, map } = flatWithMap(source);
    const at = flat.indexOf('livro');
    expect(source.slice(map[at], (map[at] ?? 0) + 5)).toBe('livro');
    const citado = flat.indexOf('citado');
    expect(source.slice(map[citado])).toBe('citado.');
    expect(map).toHaveLength(flat.length);
  });
});
