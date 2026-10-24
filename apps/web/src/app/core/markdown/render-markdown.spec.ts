import { renderMarkdown } from './render-markdown.js';

describe('renderMarkdown', () => {
  it('renders headings and keeps single line breaks', () => {
    const html = renderMarkdown('# Título\n\nlinha 1\nlinha 2');
    expect(html).toContain('<h3>Título</h3>');
    expect(html).toContain('linha 1<br>linha 2');
  });
});

describe('renderMarkdown with converted text', () => {
  it('treats indented lines as paragraphs, not code blocks', () => {
    const html = renderMarkdown(
      'Título\n\n    Dois pontos ficaram patentes nos dois temas.',
    );
    expect(html).not.toContain('<pre>');
    expect(html).toContain('Dois pontos ficaram patentes');
  });

  it('keeps fenced code blocks', () => {
    expect(renderMarkdown('```\nx = 1\n```')).toContain('<pre><code>');
  });
});
