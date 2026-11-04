import {
  speakerKeyOf,
  speakerNameSchema,
  type Author,
  type CollectionSpeaker,
} from '@kb-chat/contracts';
import { audienceLabel } from './speaker-names.js';

/** What choosing an option of the field means. */
export type SpeakerChoice =
  | { readonly kind: 'speaker'; readonly id: string }
  | { readonly kind: 'author'; readonly author: Author }
  | { readonly kind: 'audience' }
  | { readonly kind: 'none' }
  | { readonly kind: 'new'; readonly name: string };

/** One line of the list. */
export interface SpeakerOption {
  readonly key: string;
  readonly label: string;
  readonly main: boolean;
  readonly choice: SpeakerChoice;
}

/** At most this many people, so the list is scanned at a glance (SL-11). */
export const MAX_SPEAKER_SUGGESTIONS = 8;

/** A typed text that is no valid name (FR-1, AC-7); a blank field is said on Enter. */
export const isInvalidSpeakerName = (text: string): boolean =>
  text.trim() !== '' && !speakerNameSchema.safeParse(text).success;

interface Person {
  readonly key: string;
  readonly nameKey: string;
  readonly label: string;
  readonly main: boolean;
  readonly choice: SpeakerChoice;
}

/**
 * The speakers, then the authors no speaker is linked to, each once. A speaker with the name
 * of a free author is that author's option: choosing it links the two (BR-2).
 */
function peopleOf(
  speakers: readonly CollectionSpeaker[],
  authors: readonly Author[],
): Person[] {
  const linked = new Set(speakers.map((one) => one.authorSlug));
  const free = authors.filter((author) => !linked.has(author.slug));
  const freeNames = new Set(free.map((author) => speakerKeyOf(author.name)));
  const named = speakers.filter(
    (one) => one.authorSlug !== null || !freeNames.has(speakerKeyOf(one.name)),
  );
  return [
    ...named.map((one): Person => ({
      key: one.id,
      nameKey: speakerKeyOf(one.name),
      label: one.name,
      main: one.main,
      choice: { kind: 'speaker', id: one.id },
    })),
    ...free.map((author): Person => ({
      key: `author:${author.slug}`,
      nameKey: speakerKeyOf(author.name),
      label: author.name,
      main: author.main,
      choice: { kind: 'author', author },
    })),
  ];
}

/** The main one first; the exact name next, so a short list never leaves it out. */
function rankOf(person: Person, query: string): number {
  if (person.main) return 0;
  if (person.nameKey === query) return 1;
  return person.nameKey.startsWith(query) ? 2 : 3;
}

/**
 * What the field offers (screens.md T15, KBC-065): "Pergunta da plateia", the people whose
 * name holds the text (accents and case aside), the main one first, "Sem nome" while the
 * voice has one, and "Cadastrar «nome»" for a valid name the list does not have. `text` equal
 * to what the voice is now shows everything, as a field just opened does.
 */
export function suggestSpeakers(input: {
  readonly speakers: readonly CollectionSpeaker[];
  readonly authors: readonly Author[];
  readonly text: string;
  /** What the field shows for the voice now; '' with no name. */
  readonly current: string;
}): SpeakerOption[] {
  const { current } = input;
  const typed = input.text.trim() === current.trim() ? '' : input.text;
  const query = speakerKeyOf(typed);
  const people = peopleOf(input.speakers, input.authors);
  const matching = people
    .filter((person) => person.nameKey.includes(query))
    .sort((a, b) => rankOf(a, query) - rankOf(b, query))
    .slice(0, MAX_SPEAKER_SUGGESTIONS)
    .map(({ key, label, main, choice }) => ({ key, label, main, choice }));
  return [
    ...audienceOption(query),
    ...matching,
    ...noNameOption(query, current),
    ...registerOption(typed, query, people),
  ];
}

/**
 * What Enter takes from a typed text with no option active: the name it spells, or the
 * registration when nothing on the list holds that text. Part of a name means nothing yet:
 * a speaker cannot be removed, so one is not registered by accident (UP-06).
 */
export function optionForText(
  options: readonly SpeakerOption[],
  text: string,
): SpeakerOption | undefined {
  const query = speakerKeyOf(text);
  const exact = options.find(
    (option) => query !== '' && speakerKeyOf(option.label) === query,
  );
  const [only, ...others] = options;
  return (
    exact ?? (only?.key === '+new' && others.length === 0 ? only : undefined)
  );
}

function audienceOption(query: string): SpeakerOption[] {
  const label = audienceLabel();
  return speakerKeyOf(label).includes(query)
    ? [{ key: '+audience', label, main: false, choice: { kind: 'audience' } }]
    : [];
}

const noNameOption = (query: string, current: string): SpeakerOption[] =>
  query === '' && current !== ''
    ? [
        {
          key: '+none',
          label: $localize`:@@voices.noName:Sem nome`,
          main: false,
          choice: { kind: 'none' },
        },
      ]
    : [];

/** "Cadastrar «nome»": a valid name that is nobody on the list. */
function registerOption(
  typed: string,
  query: string,
  people: readonly Person[],
): SpeakerOption[] {
  const known =
    query === speakerKeyOf(audienceLabel()) ||
    people.some((one) => one.nameKey === query);
  if (query === '' || known || isInvalidSpeakerName(typed)) return [];
  const name = typed.trim();
  return [
    {
      key: '+new',
      label: $localize`:@@voices.register:Cadastrar «${name}:name:»`,
      main: false,
      choice: { kind: 'new', name },
    },
  ];
}
