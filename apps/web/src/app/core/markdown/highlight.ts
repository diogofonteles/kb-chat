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

/** Tags whose content is never highlighted: code keeps its text, links keep their target. */
const SKIPPED = new Set(['code', 'pre', 'a', 'script', 'style']);
const TAG = /^<\/?([a-z0-9]+)/i;

function wordPattern(terms: readonly string[]): RegExp {
  // Whole words that start with a term: "sétupla" also marks "sétuplas".
  return new RegExp(
    `(?<![\\p{L}\\p{N}])((?:${terms.map(accentInsensitive).join('|')})[\\p{L}\\p{N}]*)`,
    'giu',
  );
}

/**
 * Wraps occurrences of the terms in <mark> inside the rendered HTML, only in text nodes
 * outside code, pre and links (case and accent insensitive). Angular sanitizes the result.
 */
export function markTerms(html: string, terms: readonly string[]): string {
  if (terms.length === 0) return html;
  const pattern = wordPattern(terms);
  let skipped = 0;
  return html
    .split(/(<[^>]+>)/)
    .map((part) => {
      const tag = TAG.exec(part);
      if (tag) {
        const name = (tag[1] ?? '').toLowerCase();
        if (SKIPPED.has(name)) skipped += part.startsWith('</') ? -1 : 1;
        return part;
      }
      return skipped > 0 ? part : part.replace(pattern, '<mark>$1</mark>');
    })
    .join('');
}
