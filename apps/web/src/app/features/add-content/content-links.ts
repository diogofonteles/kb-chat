import { documentLinkSchema, isYoutubeUrl } from '@kb-chat/contracts';

/** A pasted line that is a web address, and what it becomes in the collection. */
export interface ContentLink {
  readonly url: string;
  /** A page becomes text; a video's speech is transcribed. */
  readonly kind: 'page' | 'video';
}

export interface ParsedLinks {
  readonly links: readonly ContentLink[];
  /** Lines that are not a web address, as typed (the screen names them). */
  readonly refused: readonly string[];
}

/** The most links one inclusion takes (the ceiling bounds the rest). */
export const MAX_LINKS = 50;

/** One address per line (spaces and commas too); a repeated one counts once. */
export function parseLinks(text: string): ParsedLinks {
  const parts = text.split(/[\s,;]+/).filter((part) => part !== '');
  const links = new Map<string, ContentLink>();
  const refused: string[] = [];
  for (const part of new Set(parts)) {
    const parsed = documentLinkSchema.safeParse(part);
    if (!parsed.success) {
      refused.push(part);
      continue;
    }
    const url = parsed.data;
    links.set(url, { url, kind: isYoutubeUrl(url) ? 'video' : 'page' });
  }
  return { links: [...links.values()], refused };
}
