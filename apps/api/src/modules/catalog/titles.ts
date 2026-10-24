const LOWERCASE_WORDS = new Set([
  'a',
  'o',
  'as',
  'os',
  'e',
  'de',
  'da',
  'do',
  'das',
  'dos',
  'em',
  'na',
  'no',
  'nas',
  'nos',
  'um',
  'uma',
  'para',
  'por',
  'com',
  'ao',
  'aos',
  'à',
  'às',
  'ou',
]);

const collapseSpaces = (value: string): string =>
  value.replace(/\s+/g, ' ').trim();

const isShouting = (value: string): boolean =>
  /\p{L}/u.test(value) && value === value.toLocaleUpperCase('pt-BR');

function capitalize(word: string): string {
  return word.charAt(0).toLocaleUpperCase('pt-BR') + word.slice(1);
}

function toTitleCase(value: string): string {
  return value
    .toLocaleLowerCase('pt-BR')
    .split(' ')
    .map((word, index) =>
      index > 0 && LOWERCASE_WORDS.has(word) ? word : capitalize(word),
    )
    .join(' ');
}

/** Turns "A  NATUREZA  SÉTUPLA" into "A Natureza Sétupla"; mixed-case titles keep their casing. */
export function toDisplayTitle(raw: string): string {
  const collapsed = collapseSpaces(raw);
  return isShouting(collapsed) ? toTitleCase(collapsed) : collapsed;
}

/** Title from a file name such as "raw/articles/a-lei-do-ritmo-2.md" when frontmatter has none. */
export function titleFromId(id: string): string {
  const base = id.split('/').pop() ?? id;
  return capitalize(
    base.replace(/\.md$/, '').replace(/-\d+$/, '').replace(/-/g, ' '),
  );
}

/** "A  Natureza Sétupla" and "a natureza setupla" share one key: near-identical copies (KBC-002 BR-4). */
export const copyKey = (title: string): string =>
  title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
