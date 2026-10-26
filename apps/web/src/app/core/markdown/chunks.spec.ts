import { CHUNK_CHARS, sectionIndex, splitIntoChunks } from './chunks.js';

describe('splitIntoChunks', () => {
  it('keeps short documents whole', () => {
    expect(splitIntoChunks('curto')).toEqual(['curto']);
  });

  it('splits long documents at paragraph boundaries', () => {
    const paragraph = 'x'.repeat(60);
    const chunks = splitIntoChunks(
      Array.from({ length: 10 }, () => paragraph).join('\n\n'),
      150,
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 150 + 62)).toBe(true);
    expect(chunks.join('').replace(/\s/g, '')).toBe('x'.repeat(600));
    expect(CHUNK_CHARS).toBe(150_000);
  });
});

describe('sectionIndex', () => {
  it('lists real headings with their chunk and skips stray "#" lines', () => {
    expect(
      sectionIndex([
        '# Início\n\ntexto\n\n# t\n\n#\nShin',
        'texto\n\n## Segunda parte ##',
      ]),
    ).toEqual([
      { title: 'Início', chunk: 0 },
      { title: 'Segunda parte', chunk: 1 },
    ]);
  });
});
