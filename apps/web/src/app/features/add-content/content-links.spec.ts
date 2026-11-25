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

  it('takes an address without its scheme, as a browser does', () => {
    const { links, refused } = parseLinks(
      'exemplo.com/pagina\nwww.exemplo.org\nyoutu.be/abc\nnota.\nfim',
    );
    expect(links.map((one) => [one.url, one.kind])).toEqual([
      ['https://exemplo.com/pagina', 'page'],
      ['https://www.exemplo.org', 'page'],
      ['https://youtu.be/abc', 'recording'],
    ]);
    expect(refused).toEqual(['nota.', 'fim']);
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

  it.each([
    [
      'http://g1.globo.com/Noticias/SaoPaulo/0,,MUL1234-5605,00.html',
      ['http://g1.globo.com/Noticias/SaoPaulo/0,,MUL1234-5605,00.html'],
    ],
    [
      'https://a.org/1,https://a.org/2; https://a.org/3,',
      ['https://a.org/1', 'https://a.org/2', 'https://a.org/3'],
    ],
    ['https://a.org/x;v=1?a=1,2', ['https://a.org/x;v=1?a=1,2']],
  ])('a comma inside an address is its own: %s', (text, urls) => {
    const { links, refused } = parseLinks(text);
    expect(links.map((one) => one.url)).toEqual(urls);
    expect(refused).toEqual([]);
  });
});
