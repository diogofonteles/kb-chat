import { parse } from 'yaml';

export interface SplitDocument {
  readonly data: Readonly<Record<string, unknown>>;
  readonly body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseYamlObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Splits a kb markdown file into its YAML frontmatter and its body. */
export function splitFrontmatter(text: string): SplitDocument {
  const match = FRONTMATTER.exec(text);
  if (!match) return { data: {}, body: text };
  return {
    data: parseYamlObject(match[1] ?? ''),
    body: text.slice(match[0].length),
  };
}
