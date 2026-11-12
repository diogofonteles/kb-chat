import { speakerKeyOf } from './speakers.js';

const escaped = (text: string): string =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** A name as a whole, in any case; accents count, however they are stored. */
export const nameIn = (name: string): RegExp =>
  new RegExp(
    `(?<![\\p{L}\\p{N}\\p{M}])${escaped(name.normalize('NFC'))}(?![\\p{L}\\p{N}\\p{M}])`,
    'giu',
  );

/** Whether a text still says this name, apart from where it is part of the right one. */
export function mentionsName(
  text: string,
  name: string,
  right: string | null,
): boolean {
  const normal = text.normalize('NFC');
  const rest = right ? normal.replace(nameIn(right), ' ') : normal;
  return nameIn(name).test(rest);
}

/** A name's words as the catalog compares them, split where `nameIn` sees a word end. */
const wordsOf = (name: string): string[] =>
  speakerKeyOf(name)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * Whether `name` holds `part` whole, word after word ("Laércio" in "Fonseca, Laércio" or
 * "Laércio-Fonseca"), never a piece of a word nor words that are apart (KBC-102).
 */
export function holdsName(name: string, part: string): boolean {
  const words = wordsOf(name);
  const wanted = wordsOf(part);
  if (wanted.length === 0) return false;
  return words.some((_, at) =>
    wanted.every((word, offset) => words[at + offset] === word),
  );
}
