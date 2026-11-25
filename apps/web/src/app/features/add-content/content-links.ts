import { documentLinkSchema, recordingLinkKind } from '@kb-chat/contracts';

/** A pasted line that is a web address, and what it becomes in the collection. */
export interface ContentLink {
  readonly url: string;
  /** A page becomes text; a recording is transcribed; a list is chosen from. */
  readonly kind: 'page' | 'recording' | 'list';
}

export interface ParsedLinks {
  readonly links: readonly ContentLink[];
  /** Lines that are not a web address, as typed (the screen names them). */
  readonly refused: readonly string[];
}

/**
 * One address per line; several on one line (spaces, commas) count each. A line with no
 * address in it is refused whole, as typed; a repeated address counts once.
 */
export function parseLinks(text: string): ParsedLinks {
  const parts = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .flatMap((line) =>
      /https?:\/\//i.test(line)
        ? line.split(/[\s,;]+/).filter(Boolean)
        : [line],
    );
  const links = new Map<string, ContentLink>();
  const refused: string[] = [];
  for (const part of new Set(parts)) {
    const parsed = documentLinkSchema.safeParse(part);
    if (!parsed.success) {
      refused.push(part);
      continue;
    }
    const url = parsed.data;
    links.set(url, { url, kind: recordingLinkKind(url) ?? 'page' });
  }
  return { links: [...links.values()], refused };
}
