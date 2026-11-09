import type {
  LearningLogRow,
  LearningSource,
  RuleTally,
} from '../../ports/transcript-correction-store.js';
import { occurrenceKey } from './word-rewrite.js';

/** What the correction log teaches (KBC-113 BR-1, BR-8, ADR 0037 §1, §3). */
export interface LogReading {
  readonly sources: readonly LearningSource[];
  /** Per rule: its replacements written, and undone (by Desfazer or a correction over it). */
  readonly tallies: ReadonlyMap<string, RuleTally>;
  /** The learning's rows a person corrected over: their words no longer hold their text. */
  readonly overwritten: ReadonlySet<string>;
}

const isPersons = (row: LearningLogRow): boolean =>
  row.kind === 'correct' && row.ruleId === null;

const overlaps = (a: LearningLogRow, b: LearningLogRow): boolean =>
  a.position < b.position + b.count && b.position < a.position + a.count;

const covers = (row: LearningLogRow, position: number): boolean =>
  position >= row.position && position < row.position + row.count;

/** The rows on each transcript that still hold their text there (not undone), in order. */
function liveByTranscript(
  rows: readonly LearningLogRow[],
): Map<string, LearningLogRow[]> {
  const byTranscript = new Map<string, LearningLogRow[]>();
  for (const row of rows) {
    if (row.state === 'undone') continue;
    const list = byTranscript.get(row.transcriptId);
    if (list) list.push(row);
    else byTranscript.set(row.transcriptId, [row]);
  }
  return byTranscript;
}

/** The person's correction each carried row came from, through any chain. */
function originsOf(rows: readonly LearningLogRow[]): Map<string, string> {
  const origins = new Map<string, string>();
  for (const row of rows)
    if (row.carriedTo !== null)
      origins.set(row.carriedTo, origins.get(row.id) ?? row.id);
  return origins;
}

/** Whether a correction's chain of carried rows ends in force (not undone). */
function inForce(
  row: LearningLogRow,
  byId: ReadonlyMap<string, LearningLogRow>,
): boolean {
  let at: LearningLogRow | undefined = row;
  const seen = new Set<string>();
  while (at?.state === 'carried' && at.carriedTo !== null) {
    if (seen.has(at.carriedTo)) return true;
    seen.add(at.carriedTo);
    const next = byId.get(at.carriedTo);
    if (!next) return true;
    at = next;
  }
  return at.state !== 'undone';
}

/**
 * What the transcriber said under a correction (review round 1): over its words and those of
 * the older rows still in force that it overlaps, the text before the oldest row that wrote
 * each word, its own otherwise.
 */
function originalBefore(
  row: LearningLogRow,
  live: readonly LearningLogRow[],
): string[] {
  const earlier = live.slice(0, live.indexOf(row) + 1);
  const touched = earlier.filter((one) => overlaps(one, row));
  const start = Math.min(row.position, ...touched.map((one) => one.position));
  const end = Math.max(
    row.position + row.count,
    ...touched.map((one) => one.position + one.count),
  );
  return Array.from({ length: end - start }, (_, index) => {
    const position = start + index;
    const first = earlier.find((one) => covers(one, position)) ?? row;
    return first.before[position - first.position] ?? '';
  });
}

interface Overrides {
  readonly superseded: Set<string>;
  readonly overwritten: Set<string>;
  readonly undoneBy: Map<string, number>;
}

/** A person's correction over a row of one transcript: what it replaces (BR-1, BR-8). */
function override(
  row: LearningLogRow,
  later: LearningLogRow,
  context: Overrides & { readonly origins: ReadonlyMap<string, string> },
): void {
  if (isPersons(row)) context.superseded.add(row.id);
  if (row.kind === 'carried')
    context.superseded.add(context.origins.get(row.id) ?? row.id);
  if (row.ruleId === null || context.overwritten.has(row.id)) return;
  // Punctuation or case over the learned text keeps it: no undo.
  if (occurrenceKey(later.after) === occurrenceKey(row.after)) return;
  context.overwritten.add(row.id);
  context.undoneBy.set(row.ruleId, (context.undoneBy.get(row.ruleId) ?? 0) + 1);
}

function overridesOf(
  live: ReadonlyMap<string, readonly LearningLogRow[]>,
  origins: ReadonlyMap<string, string>,
): Overrides {
  const context = {
    superseded: new Set<string>(),
    overwritten: new Set<string>(),
    undoneBy: new Map<string, number>(),
    origins,
  };
  for (const rows of live.values())
    rows.forEach((row, index) => {
      const later = rows
        .slice(index + 1)
        .find((one) => isPersons(one) && overlaps(one, row));
      if (later) override(row, later, context);
    });
  return context;
}

function talliesOf(
  rows: readonly LearningLogRow[],
  undoneBy: ReadonlyMap<string, number>,
): Map<string, RuleTally> {
  const tallies = new Map<string, RuleTally>();
  for (const row of rows) {
    if (row.ruleId === null) continue;
    const seen = tallies.get(row.ruleId) ?? {
      applied: 0,
      undone: undoneBy.get(row.ruleId) ?? 0,
    };
    tallies.set(row.ruleId, {
      applied: seen.applied + (row.kind === 'correct' ? 1 : 0),
      undone: seen.undone + (row.state === 'undone' ? 1 : 0),
    });
  }
  return tallies;
}

/**
 * Reads the log once (oldest first, undo rows left out): the people's corrections that
 * teach, each from what the transcriber said; a correction superseded by a newer one over
 * the same words stops teaching; a person's correction over a learned replacement counts as
 * an undo of its rule and never teaches from the learned text.
 */
export function readLog(rows: readonly LearningLogRow[]): LogReading {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const live = liveByTranscript(rows);
  const { superseded, overwritten, undoneBy } = overridesOf(
    live,
    originsOf(rows),
  );
  const sources = rows
    .filter(
      (row) => isPersons(row) && !superseded.has(row.id) && inForce(row, byId),
    )
    .map((row): LearningSource => ({
      id: row.id,
      mediaId: row.mediaId,
      mediaTitle: row.mediaTitle,
      startMs: row.startMs,
      before: originalBefore(row, live.get(row.transcriptId) ?? [row]),
      after: row.after,
      contextBefore: row.contextBefore,
      contextAfter: row.contextAfter,
      createdAt: row.createdAt,
      authorName: row.authorName,
    }));
  return { sources, tallies: talliesOf(rows, undoneBy), overwritten };
}
