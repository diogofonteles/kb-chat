import { Marked } from 'marked';

const marked = new Marked({
  gfm: true,
  breaks: true,
  async: false,
  // Vault documents are mostly converted .doc/.pdf text where tabs and leading
  // spaces are layout, not code: indented code blocks are disabled (fenced code stays).
  tokenizer: {
    code() {
      return undefined;
    },
  },
  renderer: {
    // Document headings sit under the panel's h2 (axe heading-order).
    heading({ tokens, depth }) {
      const level = Math.min(6, depth + 2);
      const text = this.parser.parseInline(tokens);
      return `<h${level}>${text}</h${level}>\n`;
    },
  },
});

/** Stable id for a heading's HTML text: "Os Sete Princípios" → "secao-os-sete-principios". */
export function headingId(html: string): string {
  const plain = html
    .replace(/<[^>]+>/g, '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
  return `secao-${plain.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

/**
 * Markdown → HTML. The result is bound with [innerHTML], which Angular sanitizes
 * (no scripts, handlers or javascript: URLs), so vault content cannot run code.
 */
export function renderMarkdown(source: string): string {
  return marked.parse(source) as string;
}
