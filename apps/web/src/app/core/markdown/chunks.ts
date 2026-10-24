/** Markdown rendered per step for long documents (KBC-003: progressive rendering above ~200 KB). */
export const CHUNK_CHARS = 150_000;

/** Splits a document at paragraph boundaries into chunks of about CHUNK_CHARS. */
export function splitIntoChunks(
  markdown: string,
  size = CHUNK_CHARS,
): string[] {
  if (markdown.length <= size) return [markdown];
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of markdown.split(/\n\s*\n/)) {
    if (current && current.length + paragraph.length > size) {
      chunks.push(current);
      current = '';
    }
    current += `${paragraph}\n\n`;
  }
  if (current) chunks.push(current);
  return chunks;
}

export interface SectionLink {
  readonly title: string;
  readonly chunk: number;
}

/** Markdown headings (#, ##, ###) and the chunk each one lives in, for the section index. */
export function sectionIndex(chunks: readonly string[]): SectionLink[] {
  return chunks.flatMap((chunk, index) =>
    [...chunk.matchAll(/^#{1,3}\s+(.+?)\s*#*\s*$/gm)].map((match) => ({
      title: (match[1] ?? '').trim(),
      chunk: index,
    })),
  );
}
