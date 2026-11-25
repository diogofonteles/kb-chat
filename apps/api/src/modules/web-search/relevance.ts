/** Words that say nothing of a subject, in the languages searched. */
const EMPTY_WORDS = new Set(
  'a o as os e de da do das dos em no na nos nas um uma para por com sem que ao aos the of and in on for to an la el los las y en del'.split(
    ' ',
  ),
);

const folded = (text: string): string =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const wordsOf = (text: string): string[] =>
  folded(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '');

/** Of the same family: "cocriação" and "cocriar". */
export const isKin = (one: string, other: string): boolean =>
  one.startsWith(rootOf(other, 0.5)) || other.startsWith(rootOf(one, 0.5));

/** The start of a word its family shares: "cocriação", "cocriar", "cocriador". */
const rootOf = (word: string, share: number): string =>
  word.slice(0, Math.max(4, Math.ceil(word.length * share)));

/** The words that say something of a text, as compared: no accents, no short or empty ones. */
export const telling = (text: string): string[] =>
  wordsOf(text).filter((word) => word.length > 2 && !EMPTY_WORDS.has(word));

/** A text to look in: its words, also with the hyphens joined ("co-criação"), and all as one. */
interface Read {
  readonly words: readonly string[];
  readonly whole: string;
}

function read(text: string): Read {
  const plain = wordsOf(text);
  const joined = wordsOf(text.replace(/(\p{L})-(\p{L})/gu, '$1$2'));
  return { words: [...plain, ...joined], whole: plain.join('') };
}

const has = ({ words }: Read, root: string): boolean =>
  words.some((word) => word.startsWith(root));

/** Half of the subject's words, at least one, in the words the engine shows of a result. */
function isAbout(text: Read, subject: string): boolean {
  const roots = telling(subject).map((word) => rootOf(word, 0.5));
  if (roots.length === 0) return true;
  const found = roots.filter((root) => has(text, root)).length;
  return found >= Math.ceil(roots.length / 2);
}

/** The first and the last name, as words or run together (`#heliocouto`, `heliocouto.com`). */
function names(text: Read, author: string): boolean {
  const parts = telling(author);
  const ends = [parts[0], parts.at(-1)].filter((part) => part !== undefined);
  if (ends.length === 0) return false;
  return (
    ends.every((part) => has(text, rootOf(part, 0.8))) ||
    text.whole.includes([...new Set(ends)].join(''))
  );
}

export interface Relevance {
  readonly subject: boolean;
  readonly author: boolean;
}

/**
 * What a result has to do with what was asked, by what the engine shows of it: its title, its
 * extract and its address. Neither means it only filled the engine's list.
 */
export function relevanceOf(
  shown: {
    readonly title: string;
    readonly snippet: string;
    readonly url: string;
  },
  asked: { readonly subject: string; readonly author: string | null },
): Relevance {
  const text = read(`${shown.title} ${shown.snippet} ${addressOf(shown.url)}`);
  return {
    subject: isAbout(text, asked.subject),
    author: asked.author !== null && names(text, asked.author),
  };
}

function addressOf(url: string): string {
  try {
    const { hostname, pathname } = new URL(url);
    return `${hostname} ${decodeURIComponent(pathname)}`;
  } catch {
    return url;
  }
}
