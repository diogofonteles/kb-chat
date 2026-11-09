import { createHash } from 'node:crypto';
import {
  CORRECTION_MAX_WORDS,
  termSchema,
  type LearnedRuleState,
  type LearnedTermState,
} from '@kb-chat/contracts';
import {
  edgesOf,
  occurrenceKey,
  occurrenceReplacement,
  replacedTexts,
  type PlacedWord,
} from './word-rewrite.js';
import type {
  LearningSource,
  LearningSwitch,
  RuleTally,
} from '../../ports/transcript-correction-store.js';

export type { LearningSource, LearningSwitch, RuleTally };

/** Who writes the learning's replacements and term-list versions (ADR 0037 §2, §5). */
export const LEARNING_PRINCIPAL = 'system:learning';
export const LEARNING_NAME = 'Aprendizado das correções';

/** The same change in this many contexts also applies in any context (BR-3). */
export const GENERAL_CONTEXTS = 3;

/** A learned term has at most this many words (BR-9). */
const TERM_MAX_WORDS = 3;

export interface Rule {
  readonly id: string;
  /** The span as people saw it, edge punctuation off. */
  readonly before: string;
  readonly beforeKey: string;
  readonly after: string;
  /** Null: in any context (BR-3). */
  readonly contextBefore: string | null;
  readonly contextAfter: string | null;
  readonly sources: readonly LearningSource[];
  readonly corrections: number;
  readonly recordings: number;
  readonly applied: number;
  readonly undone: number;
  readonly state: LearnedRuleState;
  readonly enabled: boolean;
  readonly switchedBy: string | null;
  readonly conflictWith: string | null;
  /**
   * Another rule in force for the same words, with as many corrections, that may match the
   * same occurrence by another side of its context: there, neither applies (BR-4, QA F1).
   */
  readonly tiesWith: string | null;
}

/** A replacement a rule makes on a new version (BR-5). */
export interface RuleChange {
  readonly rule: Rule;
  readonly words: readonly PlacedWord[];
  readonly texts: readonly string[];
}

export interface LearnedTermRow {
  readonly id: string;
  readonly term: string;
  readonly corrections: number;
  readonly recordings: number;
  readonly state: LearnedTermState;
  readonly switchedBy: string | null;
}

const spokenOf = (texts: readonly string[]): string =>
  texts.filter((text) => text !== '').join(' ');

const coreOf = (text: string): string =>
  edgesOf(text.replace(/\s+/g, ' ').trim()).core.trim();

const hashOf = (parts: readonly string[]): string =>
  createHash('sha256').update(parts.join('␟')).digest('hex').slice(0, 32);

const newestFirst = (a: LearningSource, b: LearningSource): number =>
  b.createdAt.localeCompare(a.createdAt);

const recordingsOf = (sources: readonly LearningSource[]): number =>
  new Set(sources.map((one) => one.mediaId)).size;

/**
 * BR-1: a change of words or of case teaches; a deletion or a change of punctuation only
 * does not.
 */
export function learnable(source: LearningSource): boolean {
  const after = coreOf(source.after);
  if (after === '') return false;
  const before = spokenOf(source.before);
  return (
    coreOf(before) !== after &&
    occurrenceKey(before) !== '' &&
    occurrenceKey(before).split(' ').length <= CORRECTION_MAX_WORDS
  );
}

interface Draft {
  readonly key: string;
  readonly beforeKey: string;
  readonly after: string;
  readonly contextBefore: string | null;
  readonly contextAfter: string | null;
  readonly sources: LearningSource[];
}

/** The place a rule competes for: its span and its context (BR-4). */
const placeOf = (
  draft: Pick<Draft, 'beforeKey' | 'contextBefore' | 'contextAfter'>,
) =>
  `${draft.beforeKey}␟${draft.contextBefore ?? '*'}␟${draft.contextAfter ?? '*'}`;

function contextualDrafts(sources: readonly LearningSource[]): Draft[] {
  const drafts = new Map<string, Draft>();
  for (const source of sources) {
    const beforeKey = occurrenceKey(spokenOf(source.before));
    const after = coreOf(source.after);
    const contextBefore = occurrenceKey(source.contextBefore);
    const contextAfter = occurrenceKey(source.contextAfter);
    const key = hashOf(['c', beforeKey, contextBefore, contextAfter, after]);
    const known = drafts.get(key);
    if (known) known.sources.push(source);
    else
      drafts.set(key, {
        key,
        beforeKey,
        after,
        contextBefore,
        contextAfter,
        sources: [source],
      });
  }
  return [...drafts.values()];
}

/** The same change in GENERAL_CONTEXTS contexts or more (BR-3). */
function generalDrafts(contextual: readonly Draft[]): Draft[] {
  const byChange = new Map<string, Draft[]>();
  for (const draft of contextual) {
    const change = `${draft.beforeKey}␟${draft.after}`;
    byChange.set(change, [...(byChange.get(change) ?? []), draft]);
  }
  return [...byChange.values()]
    .filter((drafts) => drafts.length >= GENERAL_CONTEXTS)
    .flatMap(([first, ...rest]) =>
      first
        ? [
            {
              key: hashOf(['*', first.beforeKey, first.after]),
              beforeKey: first.beforeKey,
              after: first.after,
              contextBefore: null,
              contextAfter: null,
              sources: [first, ...rest].flatMap((one) => one.sources),
            },
          ]
        : [],
    );
}

/** Items by a key, in order. */
function grouped<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

const groupBy = <T>(items: readonly T[], keyOf: (item: T) => string): T[][] => [
  ...grouped(items, keyOf).values(),
];

/** The losers of one place, with the text that beat them; all of them on a tie (BR-4). */
function losersOf(rivals: readonly Draft[]): [string, string | null][] {
  if (rivals.length < 2) return [];
  const sorted = [...rivals].sort(
    (a, b) => b.sources.length - a.sources.length,
  );
  const [top, second] = sorted;
  const tie = top?.sources.length === second?.sources.length;
  return sorted
    .filter((draft) => tie || draft !== top)
    .map((draft) => [
      draft.key,
      sorted.find((one) => one !== draft)?.after ?? null,
    ]);
}

/** The winner of each place: the most corrections; a tie has none (BR-4). */
function conflictsOf(drafts: readonly Draft[]): Map<string, string | null> {
  return new Map(groupBy(drafts, placeOf).flatMap(losersOf));
}

function stateOf(input: {
  readonly switched: LearningSwitch | undefined;
  readonly conflict: boolean;
  readonly corrections: number;
  readonly undone: number;
}): { state: LearnedRuleState; enabled: boolean } {
  const { switched } = input;
  if (switched)
    return switched.enabled
      ? { state: 'on', enabled: true }
      : { state: 'off', enabled: false };
  if (input.conflict) return { state: 'conflict', enabled: false };
  if (input.undone >= input.corrections)
    return { state: 'auto-off', enabled: false };
  return { state: 'on', enabled: true };
}

interface RuleOptions {
  readonly tallies?: ReadonlyMap<string, RuleTally>;
  readonly switches?: ReadonlyMap<string, LearningSwitch>;
}

/** Whether a draft still competes for its place: on by a master, or not undone away (BR-8). */
function isEligible(draft: Draft, options: RuleOptions): boolean {
  const switched = options.switches?.get(`rule:${draft.key}`);
  if (switched) return switched.enabled;
  const undone = options.tallies?.get(draft.key)?.undone ?? 0;
  return undone < draft.sources.length;
}

function ruleOf(
  draft: Draft,
  options: RuleOptions & {
    readonly losers: ReadonlyMap<string, string | null>;
  },
): Omit<Rule, 'tiesWith'> {
  const tally = options.tallies?.get(draft.key) ?? { applied: 0, undone: 0 };
  const switched = options.switches?.get(`rule:${draft.key}`);
  const ordered = [...draft.sources].sort(newestFirst);
  return {
    id: draft.key,
    before: coreOf(spokenOf(ordered[0]?.before ?? [])),
    beforeKey: draft.beforeKey,
    after: draft.after,
    contextBefore: draft.contextBefore,
    contextAfter: draft.contextAfter,
    sources: ordered,
    corrections: ordered.length,
    recordings: recordingsOf(ordered),
    ...tally,
    ...stateOf({
      switched,
      conflict: options.losers.has(draft.key),
      corrections: ordered.length,
      undone: tally.undone,
    }),
    switchedBy: switched?.authorName ?? null,
    conflictWith: options.losers.get(draft.key) ?? null,
  };
}

type Sided = Pick<Rule, 'contextBefore' | 'contextAfter'>;

/** Whether one occurrence can match both rules, each by a real word of its context. */
function canMeet(a: Sided, b: Sided): boolean {
  const word = (side: string | null): side is string =>
    side !== null && side !== '';
  const byBefore =
    word(a.contextBefore) &&
    (word(b.contextAfter) || b.contextBefore === a.contextBefore);
  const byAfter =
    word(a.contextAfter) &&
    (word(b.contextBefore) || b.contextAfter === a.contextAfter);
  return byBefore || byAfter;
}

/** The first rival a rule ties with on some occurrence (BR-4, QA F1). */
function tieOf(
  rule: Omit<Rule, 'tiesWith'>,
  sameWords: readonly Omit<Rule, 'tiesWith'>[],
): string | null {
  if (!rule.enabled || rule.contextBefore === null) return null;
  const rival = sameWords.find(
    (other) =>
      other.enabled &&
      other.contextBefore !== null &&
      other.after !== rule.after &&
      other.corrections === rule.corrections &&
      canMeet(rule, other),
  );
  return rival?.after ?? null;
}

const newestOf = (sources: readonly LearningSource[]): string =>
  sources.reduce(
    (newest, one) => (one.createdAt > newest ? one.createdAt : newest),
    '',
  );

/**
 * The rules the corrections in force teach (BR-2 to BR-4, BR-8), the most corrected first.
 * Pure: the store gives the sources, the tallies of the learning's rows and the switches.
 */
export function deriveRules(
  sources: readonly LearningSource[],
  options: RuleOptions = {},
): Rule[] {
  const contextual = contextualDrafts(sources.filter(learnable));
  const drafts = [...contextual, ...generalDrafts(contextual)];
  // A rule turned off, by a master or by undos, is out of its place (review round 1).
  const losers = conflictsOf(
    drafts.filter((draft) => isEligible(draft, options)),
  );
  const rules = drafts.map((draft) => ruleOf(draft, { ...options, losers }));
  const byWords = grouped(rules, (rule) => rule.beforeKey);
  return rules
    .map((rule): Rule => ({
      ...rule,
      tiesWith: tieOf(rule, byWords.get(rule.beforeKey) ?? []),
    }))
    .sort(
      (a, b) =>
        b.corrections - a.corrections ||
        newestOf(b.sources).localeCompare(newestOf(a.sources)) ||
        a.id.localeCompare(b.id),
    );
}

/** A rule's text with the occurrence's edge punctuation and leading capital (BR-5). */
function replacementFor(said: string, after: string): string {
  const text = occurrenceReplacement(said, after);
  const saidCore = edgesOf(said).core;
  const startsUpper = /^\p{Lu}/u.test(saidCore);
  const { lead, core, trail } = edgesOf(text);
  if (!startsUpper || !/^\p{Ll}/u.test(core)) return text;
  return `${lead}${core.charAt(0).toLocaleUpperCase('pt-BR')}${core.slice(1)}${trail}`;
}

/**
 * The candidate a place keeps: the most corrections, then the most sides of context that
 * match (QA F7: both sides beat one); none on a tie of both with another text (BR-4).
 */
function bestOf(
  candidates: readonly Rule[],
  sidesOf: (rule: Rule) => number = () => 0,
): Rule | null {
  const rank = (a: Rule, b: Rule) =>
    b.corrections - a.corrections || sidesOf(b) - sidesOf(a);
  const [top, second] = [...candidates].sort(rank);
  if (!top) return null;
  const tie =
    second !== undefined &&
    rank(top, second) === 0 &&
    second.after !== top.after;
  return tie ? null : top;
}

interface Neighbours {
  readonly before: string;
  readonly after: string;
}

/** How many sides of a rule's context match, each a real word (review round 1). */
const sidesMatching = (rule: Rule, around: Neighbours): number =>
  Number(rule.contextBefore !== '' && rule.contextBefore === around.before) +
  Number(rule.contextAfter !== '' && rule.contextAfter === around.after);

/** The rule for a span: a contextual one that matches a side, else one in any context. */
function ruleFor(rules: readonly Rule[], around: Neighbours): Rule | null {
  const contextual = rules.filter(
    (rule) => rule.contextBefore !== null && sidesMatching(rule, around) > 0,
  );
  if (contextual.length > 0)
    return bestOf(contextual, (rule) => sidesMatching(rule, around));
  return bestOf(rules.filter((rule) => rule.contextBefore === null));
}

/** Spoken words of each segment, in order. */
const segmentsOf = (words: readonly PlacedWord[]): PlacedWord[][] =>
  groupBy(
    words.filter((word) => word.text !== ''),
    (word) => String(word.segment),
  );

interface Scan {
  readonly byKey: ReadonlyMap<string, readonly Rule[]>;
  readonly byPosition: ReadonlyMap<number, PlacedWord>;
  readonly skip: ReadonlySet<number>;
  /** The first word of every rule, punctuation aside: a quick no (NFR-1). */
  readonly firsts: ReadonlySet<string>;
  readonly longest: number;
}

const wordsOfKey = (key: string): string[] => key.split(' ');

/** Every word from the first to the last position, empty ones too (BR-5). */
function wordsBetween(
  scan: Scan,
  first: PlacedWord,
  last: PlacedWord,
): PlacedWord[] {
  return Array.from({ length: last.position - first.position + 1 }, (_, at) =>
    scan.byPosition.get(first.position + at),
  ).filter((word): word is PlacedWord => word !== undefined);
}

/** What a run of `size` spoken words from `index` becomes; null when no rule takes it. */
function changeOf(
  scan: Scan,
  spoken: readonly PlacedWord[],
  at: { readonly index: number; readonly size: number },
): { change: RuleChange | null } | null {
  const run = spoken.slice(at.index, at.index + at.size);
  const first = run[0];
  const last = run.at(-1);
  if (!first || !last) return null;
  if (last.position - first.position + 1 > CORRECTION_MAX_WORDS) return null;
  const said = run.map((word) => word.text).join(' ');
  const rules = scan.byKey.get(occurrenceKey(said));
  const rule = rules
    ? ruleFor(rules, {
        before: occurrenceKey(spoken[at.index - 1]?.text ?? ''),
        after: occurrenceKey(spoken[at.index + at.size]?.text ?? ''),
      })
    : null;
  if (!rule) return null;
  const words = wordsBetween(scan, first, last);
  const untouched =
    words.some((word) => scan.skip.has(word.position)) ||
    edgesOf(said).core === rule.after;
  if (untouched) return { change: null };
  const texts = replacedTexts(words.length, replacementFor(said, rule.after));
  return { change: { rule, words, texts } };
}

/** The change at `index` of a segment's spoken words, the longest first, and its size. */
function changeAt(
  scan: Scan,
  spoken: readonly PlacedWord[],
  index: number,
): { change: RuleChange | null; size: number } | null {
  const first = spoken[index];
  if (!first || !scan.firsts.has(occurrenceKey(first.text))) return null;
  const longest = Math.min(scan.longest, spoken.length - index);
  for (let size = longest; size >= 1; size--) {
    const found = changeOf(scan, spoken, { index, size });
    if (found) return { ...found, size };
  }
  return null;
}

/** The changes along one segment, left to right, never overlapping. */
function changesIn(scan: Scan, spoken: readonly PlacedWord[]): RuleChange[] {
  const changes: RuleChange[] = [];
  let index = 0;
  while (index < spoken.length) {
    const found = changeAt(scan, spoken, index);
    if (found?.change) changes.push(found.change);
    index += found?.size ?? 1;
  }
  return changes;
}

/**
 * BR-3 to BR-6: on a new version's words, every span of one segment that an enabled rule
 * matches, left to right, the longest first, never overlapping, never on `skip` (the words
 * the carry-over wrote).
 */
export function applyRules(
  words: readonly PlacedWord[],
  rules: readonly Rule[],
  skip: ReadonlySet<number>,
): RuleChange[] {
  const enabled = rules.filter((one) => one.enabled);
  if (enabled.length === 0) return [];
  const scan: Scan = {
    byKey: grouped(enabled, (rule) => rule.beforeKey),
    byPosition: new Map(words.map((word) => [word.position, word])),
    skip,
    firsts: new Set(
      enabled.map((rule) => occurrenceKey(wordsOfKey(rule.beforeKey)[0] ?? '')),
    ),
    longest: Math.min(
      CORRECTION_MAX_WORDS,
      Math.max(...enabled.map((rule) => wordsOfKey(rule.beforeKey).length)),
    ),
  };
  return segmentsOf(words).flatMap((spoken) => changesIn(scan, spoken));
}

interface TermDraft {
  readonly key: string;
  readonly sources: LearningSource[];
}

/** The spelling used most, the newest on a tie. */
function spellingOf(sources: readonly LearningSource[]): string {
  const counts = new Map<string, { n: number; at: string }>();
  for (const source of sources) {
    const term = coreOf(source.after);
    const seen = counts.get(term);
    counts.set(term, {
      n: (seen?.n ?? 0) + 1,
      at: seen && seen.at > source.createdAt ? seen.at : source.createdAt,
    });
  }
  const [best] = [...counts].sort(
    ([, a], [, b]) => b.n - a.n || b.at.localeCompare(a.at),
  );
  return best?.[0] ?? '';
}

const isTerm = (text: string): boolean =>
  text.split(' ').length <= TERM_MAX_WORDS &&
  termSchema.safeParse(text).success;

/** Corrections grouped by their new text, case aside, but the masters' terms (BR-9). */
function termDrafts(
  sources: readonly LearningSource[],
  manual: ReadonlySet<string>,
): TermDraft[] {
  const keyOf = (source: LearningSource) =>
    coreOf(source.after).toLocaleLowerCase('pt-BR');
  const eligible = sources.filter(
    (source) => learnable(source) && !manual.has(keyOf(source)),
  );
  return [...grouped(eligible, keyOf)].map(([key, group]) => ({
    key,
    sources: group,
  }));
}

interface TermCandidate {
  readonly draft: TermDraft;
  readonly term: string;
}

const byMostCorrected = (a: TermCandidate, b: TermCandidate): number =>
  b.draft.sources.length - a.draft.sources.length ||
  newestOf(b.draft.sources).localeCompare(newestOf(a.draft.sources)) ||
  a.term.localeCompare(b.term);

interface TermOptions {
  readonly manual: readonly string[];
  readonly fits: (list: readonly string[]) => boolean;
  readonly switches?: ReadonlyMap<string, LearningSwitch>;
}

const isCandidate = ({ draft, term }: TermCandidate): boolean =>
  isTerm(term) && (/\p{Lu}/u.test(term) || draft.sources.length >= 2);

/** A term's row; `list` grows with the terms that fit, in order (BR-9). */
function termRowOf(
  { draft, term }: TermCandidate,
  options: TermOptions & { readonly list: string[] },
): LearnedTermRow {
  const id = hashOf(['term', draft.key]);
  const switched = options.switches?.get(`term:${id}`);
  const base = {
    id,
    term,
    corrections: draft.sources.length,
    recordings: recordingsOf(draft.sources),
    switchedBy: switched?.authorName ?? null,
  };
  if (switched && !switched.enabled) return { ...base, state: 'off' };
  if (!options.fits([...options.list, term]))
    return { ...base, state: 'no-room' };
  options.list.push(term);
  return { ...base, state: 'in-list' };
}

/**
 * BR-9: the texts people corrected that are names (a capital letter) or were corrected twice,
 * not in the masters' list, the most corrected first, in the list while `fits` says so.
 */
export function learnedTerms(
  sources: readonly LearningSource[],
  options: TermOptions,
): LearnedTermRow[] {
  const manual = new Set(
    options.manual.map((term) => term.toLocaleLowerCase('pt-BR')),
  );
  const list = [...options.manual];
  return termDrafts(sources, manual)
    .map((draft) => ({ draft, term: spellingOf(draft.sources) }))
    .filter(isCandidate)
    .sort(byMostCorrected)
    .map((candidate) => termRowOf(candidate, { ...options, list }));
}
