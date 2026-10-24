const MAX_SNIPPET_CHARS = 320;
const LINE_NUMBER_PREFIX = /^\d+:\s?/;
const HUNK_HEADER = /^@@ .* @@/;
const TRAILING_ELLIPSIS = /(\.\.\.|…)$/;

function truncate(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_SNIPPET_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_SNIPPET_CHARS).replace(/\s+\S*$/, '')}…`;
}

function snippetLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.replace(LINE_NUMBER_PREFIX, ''))
    .filter((line) => !HUNK_HEADER.test(line));
}

function isBodyLine(line: string, body: string): boolean {
  const probe = line.trim().replace(TRAILING_ELLIPSIS, '').trim();
  return probe.length > 0 && body.includes(probe);
}

export interface SnippetSource {
  readonly body: string;
  readonly summary: string | null;
}

/**
 * Keeps only the snippet lines that belong to the document body, so a hit that
 * landed in the YAML frontmatter never shows `title:`/`type:` (KBC-001 BR-3).
 * Falls back to the summary, then to the start of the body.
 */
export function cleanSnippet(raw: string, source: SnippetSource): string {
  const bodyLines = snippetLines(raw).filter((line) =>
    isBodyLine(line, source.body),
  );
  if (bodyLines.length > 0) return truncate(bodyLines.join(' '));
  return truncate(source.summary ?? source.body);
}
