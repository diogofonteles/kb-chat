/** Words that carry no meaning to highlight in Portuguese questions. */
const STOPWORDS = new Set([
  'que',
  'qual',
  'quais',
  'como',
  'para',
  'por',
  'com',
  'sem',
  'uma',
  'umas',
  'uns',
  'dos',
  'das',
  'nos',
  'nas',
  'pelo',
  'pela',
  'pelos',
  'pelas',
  'sobre',
  'entre',
  'ser',
  'sao',
  'são',
  'esta',
  'está',
  'este',
  'essa',
  'esse',
  'isso',
  'isto',
  'aquilo',
  'onde',
  'quando',
  'porque',
  'mais',
  'menos',
  'muito',
  'pode',
  'the',
  'and',
  'what',
  'how',
]);

const ACCENT_CLASSES: Record<string, string> = {
  a: '[aàáâãä]',
  e: '[eèéêë]',
  i: '[iìíîï]',
  o: '[oòóôõö]',
  u: '[uùúûü]',
  c: '[cç]',
  n: '[nñ]',
};

const fold = (text: string): string =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Meaningful words of a question (3+ letters, no stopwords), accent-folded and unique. */
export function highlightTerms(question: string): string[] {
  const words = fold(question)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
  return [...new Set(words)];
}

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "setupla" → /s[eè…]t[uù…]pl[aà…]/: matches "sétupla", "SETUPLA" and so on. */
function accentInsensitive(term: string): string {
  return [...term]
    .map((char) => ACCENT_CLASSES[char] ?? escapeRegExp(char))
    .join('');
}

/**
 * Wraps each occurrence of the terms in <mark> (case and accent insensitive), at word
 * starts only. The markdown is rendered afterwards and sanitized by Angular, which keeps <mark>.
 */
export function markTerms(markdown: string, terms: readonly string[]): string {
  if (terms.length === 0) return markdown;
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(${terms.map(accentInsensitive).join('|')})`,
    'giu',
  );
  return markdown.replace(pattern, '<mark>$1</mark>');
}
