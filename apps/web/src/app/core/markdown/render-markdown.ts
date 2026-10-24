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
});

/**
 * Markdown → HTML. The result is bound with [innerHTML], which Angular sanitizes
 * (no scripts, handlers or javascript: URLs), so vault content cannot run code.
 */
export function renderMarkdown(source: string): string {
  return marked.parse(source) as string;
}
