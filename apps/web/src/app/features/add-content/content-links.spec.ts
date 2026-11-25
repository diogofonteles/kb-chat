import { parseLinks } from './content-links.js';

describe('parseLinks (KBC-184)', () => {
  it('takes one address per line, says what each becomes, and counts a repeated one once', () => {
    const { links, refused } = parseLinks(
      'https://example.org/a\n\n  https://youtu.be/abc \nhttps://example.org/a',
    );
    expect(links).toEqual([
      { url: 'https://example.org/a', kind: 'page' },
      { url: 'https://youtu.be/abc', kind: 'recording' },
    ]);
    expect(refused).toEqual([]);
  });

  it('takes several on one line', () => {
    const { links } = parseLinks('https://a.example/1, https://b.example/2');
    expect(links.map((one) => one.url)).toEqual([
      'https://a.example/1',
      'https://b.example/2',
    ]);
  });

  it('refuses, whole and as typed, what is not a web address', () => {
    const { links, refused } = parseLinks(
      'não é link\nfile:///etc/passwd\nhttps://user:pw@example.org/x',
    );
    expect(links).toEqual([]);
    expect(refused).toEqual([
      'não é link',
      'file:///etc/passwd',
      'https://user:pw@example.org/x',
    ]);
  });

  it('answers nothing for an empty field', () => {
    expect(parseLinks('  \n ')).toEqual({ links: [], refused: [] });
  });
});
