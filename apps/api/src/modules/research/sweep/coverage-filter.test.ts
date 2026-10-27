import { describe, expect, it } from 'vitest';
import { CoverageLineFilter } from './coverage-filter.js';

/** Feeds the text in small deltas, as a stream does, and returns what passed. */
function filtered(text: string, size = 3): string {
  const filter = new CoverageLineFilter();
  let out = '';
  for (let at = 0; at < text.length; at += size)
    out += filter.push(text.slice(at, at + size));
  return out + filter.end();
}

describe('CoverageLineFilter (KBC-030)', () => {
  it('drops every line the model writes as coverage, in any markdown dress', () => {
    const text = [
      'Os livros citados são:',
      '- O Caibalion [1]',
      '',
      '**Cobertura:** varri 2.555 documentos de autoria Mestre Laércio.',
      '> cobertura: 100%',
      '## Cobertura',
      '',
      'Fim [2].',
    ].join('\n');
    expect(filtered(text)).toBe(
      'Os livros citados são:\n- O Caibalion [1]\n\nFim [2].',
    );
  });

  it('drops a coverage line at the very end, without a line break', () => {
    expect(filtered('Lista [1].\nCobertura: tudo varrido')).toBe(
      'Lista [1].\n',
    );
  });

  it('keeps lines that only mention coverage further in, or start like it but differ', () => {
    const text = 'A cobertura do tema é ampla [1].\nCobre três livros [2].\nCo';
    expect(filtered(text)).toBe(text);
  });

  it('passes text through at once while a line cannot be a coverage line', () => {
    const filter = new CoverageLineFilter();
    expect(filter.push('Lista')).toBe('Lista');
    expect(filter.push('\n**Co')).toBe('\n');
    expect(filter.push('mo diz [1]')).toBe('**Como diz [1]');
  });

  it('drops numbered and table coverage lines, and a coverage heading with its section (code review 8)', () => {
    const text = [
      'Livros [1].',
      '1. Cobertura: 2.555 documentos',
      '| Cobertura | 2.555 |',
      '## Cobertura',
      'Varri 2.555 documentos de 2.555.',
      'Todos lidos.',
      '',
      'Fim [2].',
    ].join('\n');
    expect(filtered(text)).toBe('Livros [1].\nFim [2].');
  });
});
