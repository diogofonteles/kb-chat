import { describe, expect, it } from 'vitest';
import type { CatalogEntry } from '../../catalog/index.js';
import { SourceBook } from '../source-book.js';
import { FindingSet, parseFindings, parseNumbered } from './findings.js';

const entry = (id: string, title: string) =>
  ({ id, title, authorship: 'mestre-laercio' }) as CatalogEntry;

const a = entry('raw/a.md', 'Tema A');
const b = entry('raw/b.md', 'Tema B');
const labels = new Map([
  [1, a],
  [2, b],
]);

describe('sweep findings (KBC-030)', () => {
  it('reads one finding per line with the batch labels and drops labels outside the batch', () => {
    const output = [
      'Achados:',
      '- [D1] O Caibalion, recomendado — “leiam o Caibalion”',
      '* [D2][D1] Ísis sem Véu — “uma obra de referência”',
      '3. [D7] livro inventado',
      '[D2]: A Doutrina Secreta',
      'NENHUM',
    ].join('\n');
    const found = parseFindings(output, labels);
    expect(found.map((f) => [f.entry.id, f.text])).toEqual([
      ['raw/a.md', 'O Caibalion, recomendado — “leiam o Caibalion”'],
      ['raw/b.md', 'Ísis sem Véu — “uma obra de referência”'],
      ['raw/a.md', 'Ísis sem Véu — “uma obra de referência”'],
      ['raw/b.md', 'A Doutrina Secreta'],
    ]);
  });

  it('merges findings into the shared numbering, without repeats, grouped by document', () => {
    const book = new SourceBook();
    book.number({ id: 'raw/z.md', title: 'Z' });
    const set = new FindingSet(book);
    set.addFound([
      { entry: b, text: 'A Doutrina Secreta' },
      { entry: a, text: 'O Caibalion' },
      { entry: b, text: 'a doutrina secreta.' },
    ]);
    expect(set.size).toBe(2);
    expect(set.documents).toBe(2);
    expect(set.lines()).toEqual([
      '- [2] A Doutrina Secreta',
      '- [3] O Caibalion',
    ]);
    expect(book.find(2)?.id).toBe('raw/b.md');
  });

  it('reads condensed findings by [n], keeping only numbers the turn knows', () => {
    const book = new SourceBook();
    book.number(a);
    const found = parseNumbered('- [1] O Caibalion\n- [9] inventado', book);
    expect(found).toEqual([{ n: 1, text: 'O Caibalion' }]);
  });
});
