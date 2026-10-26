/**
 * Text prepared for literal phrase search (find_text, ADR 0006): one line, markdown
 * emphasis removed, so a phrase matches across line breaks and `**bold**` words.
 */
export function flatText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Typographic characters folded to their ASCII look-alike; anything else past Latin-1 becomes a space. */
const LOOK_ALIKES: Readonly<Record<string, string>> = {
  '\u2018': "'",
  '\u2019': "'",
  '\u201c': '"',
  '\u201d': '"',
  '\u2013': '-',
  '\u2014': '-',
};

const foldChar = (char: string): string =>
  char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()[0] ?? ' ';

/** Keeps the folded text in Latin-1, which V8 stores in one byte per character. */
const toLatin1 = (text: string): string =>
  text.replace(/[^ -\xff]/g, (char) => LOOK_ALIKES[char] ?? ' ');

/**
 * Accent- and case-insensitive folding of `flatText` output that keeps its length, so a
 * position in the folded text is the same position in the flat text (for snippets).
 */
export function foldText(flat: string): string {
  const quick = flat.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  if (quick.length === flat.length) return toLatin1(quick);
  let folded = '';
  for (const char of flat.split('')) folded += foldChar(char);
  return toLatin1(folded);
}

/** How many times `needle` occurs in `haystack` (non-overlapping) and where it first does. */
export function countOccurrences(
  haystack: string,
  needle: string,
): { count: number; first: number } {
  const first = haystack.indexOf(needle);
  let count = 0;
  for (
    let at = first;
    at >= 0;
    at = haystack.indexOf(needle, at + needle.length)
  )
    count += 1;
  return { count, first };
}
