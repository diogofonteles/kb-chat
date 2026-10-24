import { citedSource, formatCost, renderAnswer } from './answer-format.js';

describe('answer formatting', () => {
  it('drops raw HTML, links and images from model output, keeping citations', () => {
    const html = renderAnswer(
      'Veja <img src="https://evil/x?q=1"> e [site](https://evil) e ![x](https://evil/i.png) [1].',
      [{ n: 1, id: 'a.md', title: 'A' }],
    );
    expect(html).not.toMatch(/<img|href="https:\/\/evil/);
    expect(html).toContain('&lt;img');
    expect(html).toContain('site');
    expect(html).toContain(
      '<a class="cite" href="#fonte-1" aria-label="Fonte 1: A"',
    );
    expect(renderAnswer('sem fonte [9]')).toContain('[9]');
  });

  it('wraps a Markdown table in a box that scrolls sideways, and only Markdown tables', () => {
    const html = renderAnswer(
      '| Princípio | Fonte |\n| --- | --- |\n| Ritmo | [1] |\n\n<table>x</table>',
    );
    expect(html).toContain('<div class="table-scroll"><table>');
    expect(html.match(/table-scroll/g)).toHaveLength(1);
    expect(html).toContain('&lt;table&gt;');
  });

  it('formats costs in pt-BR', () => {
    expect(formatCost(0.00042)).toMatch(/^US\$\s0,0004$/);
  });

  it('reads the source number of a clicked citation', () => {
    const host = document.createElement('div');
    host.innerHTML = renderAnswer('Texto [2].', [
      { n: 2, id: 'b.md', title: 'B' },
    ]);
    expect(citedSource(host.querySelector('a.cite'))).toBe(2);
    expect(citedSource(host)).toBeNull();
  });
});
