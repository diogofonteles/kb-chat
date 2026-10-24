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
  it('lists headings with their chunk', () => {
    expect(sectionIndex(['# Um\n\ntexto', 'texto\n\n## Dois ##'])).toEqual([
      { title: 'Um', chunk: 0 },
      { title: 'Dois', chunk: 1 },
    ]);
  });
});
