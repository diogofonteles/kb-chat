/**
 * NFR-3 (ADR 0034 §6, "Compliance"): whatever was corrected, however the new version differs,
 * every correction in force ends carried or listed as not carried, and the new version is
 * always saved. Synthetic versions through the real routes and the real media database.
 */
import { randomUUID } from 'node:crypto';
import type { Occurrences } from '@kb-chat/contracts';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, type Call } from '../test/ai-app-harness.js';
import {
  correctionsUrl,
  dbRows,
  historyOf,
  transcriptUrl,
  wordsOf,
} from '../test/correction-harness.js';
import {
  say,
  startWorld,
  transcribed,
  type Spoken,
  type World,
} from '../test/track-items-harness.js';

const VOCABULARY = [
  'Tiuako',
  'Mariri',
  'mestre',
  'disse',
  'vegetal',
  'luz',
  'Hoasca',
  'sessão',
] as const;
const TYPED = ['Tiuaco', 'Mariri,', 'dois termos', 'luz!', ''] as const;

const word = fc.constantFrom(...VOCABULARY);

/** 2 to 4 segments of 3 to 6 words, 20 s apart. */
const speechArb = fc
  .array(fc.array(word, { minLength: 3, maxLength: 6 }), {
    minLength: 2,
    maxLength: 4,
  })
  .map((lines): Spoken[] =>
    lines.map((words, index) => ({
      at: 10 + index * 20,
      text: words.join(' '),
    })),
  );

/** What the person does on the first version: corrections, chained, grouped, undone. */
type Act =
  | {
      readonly kind: 'one';
      readonly segment: number;
      readonly at: number;
      readonly count: number;
      readonly text: string;
    }
  | { readonly kind: 'all'; readonly word: string; readonly text: string }
  | { readonly kind: 'undo'; readonly nth: number };

const actArb: fc.Arbitrary<Act> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('one' as const),
      segment: fc.nat(3),
      at: fc.nat(5),
      count: fc.integer({ min: 1, max: 3 }),
      text: fc.constantFrom(...TYPED),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('all' as const),
      word,
      text: fc.constantFrom('Tiuaco', 'Mestre', 'Luz'),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('undo' as const),
      nth: fc.nat(9),
    }),
  },
);

/** How the new version differs, word by word: the same, another word, another case, gone. */
const changeArb = fc.constantFrom(
  'same',
  'same',
  'same',
  'other',
  'case',
  'extra',
);

function nextVersion(speech: readonly Spoken[], changes: readonly string[]) {
  let at = 0;
  return speech.map((line) => ({
    ...line,
    text: line.text
      .split(' ')
      .flatMap((one, index) => {
        const change = changes[at++ % changes.length] ?? 'same';
        if (change === 'other')
          return [VOCABULARY[(index + 3) % VOCABULARY.length] ?? one];
        if (change === 'case') return [one.toUpperCase()];
        // A word more shifts the times of the rest of the segment.
        if (change === 'extra') return ['e', one];
        return [one];
      })
      .join(' '),
  }));
}

async function act(call: Call, id: string, step: Act): Promise<number> {
  if (step.kind === 'undo') {
    const history = await historyOf(call, id);
    const undoable = history.entries
      .flatMap((entry) => entry.items)
      .filter((item) => item.canUndo);
    const row = undoable[step.nth % Math.max(1, undoable.length)];
    if (!row) return 200;
    return (await call('POST', `${correctionsUrl(id)}/${row.id}/undo`))
      .statusCode;
  }
  if (step.kind === 'all') {
    const read = await call(
      'GET',
      `${transcriptUrl(id)}/occurrences?text=${encodeURIComponent(step.word)}&scope=recording`,
    );
    const preview = read.json<Occurrences>();
    if (preview.occurrences.length === 0) return read.statusCode;
    return (
      await call('POST', `${correctionsUrl(id)}/batch`, {
        version: 1,
        key: randomUUID(),
        text: step.text,
        items: preview.occurrences.map(({ position, count, expected }) => ({
          position,
          count,
          expected,
        })),
      })
    ).statusCode;
  }
  const { words } = await wordsOf(call, id);
  const segments = [...new Set(words.map((one) => one.segment))];
  const segment = segments[step.segment % segments.length];
  const own = words.filter((one) => one.segment === segment);
  const first = own[step.at % own.length];
  if (first?.position === undefined) return 200;
  const span = own
    .filter((one) => (one.position ?? -1) >= (first.position ?? 0))
    .slice(0, step.count);
  return (
    await call('POST', correctionsUrl(id), {
      version: 1,
      position: first.position,
      count: span.length,
      expected: span.map((one) => one.text),
      text: step.text,
    })
  ).statusCode;
}

interface LogRow {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly carried_to: string | null;
  readonly checked_version: number | null;
  readonly found: string | null;
  readonly group_id: string | null;
  readonly version: number;
}

const logOf = (world: World, mediaId: string) =>
  dbRows(
    world.media,
    `SELECT id, kind, state, carried_to, checked_version, found, group_id, version
       FROM transcript_corrections WHERE media_id = ?`,
    mediaId,
  ) as unknown as LogRow[];

/** A correction in force on version 1 once version 2 came: carried there, or not carried. */
function settled(
  after: ReadonlyMap<string, LogRow>,
  id: string,
  groupsBefore: ReadonlySet<string | null>,
): void {
  const row = after.get(id);
  expect(row?.checked_version, id).toBe(2);
  if (row?.state !== 'carried') {
    expect(row?.state, id).toBe('not-carried');
    expect(row?.found).not.toBeNull();
    return;
  }
  const landed = after.get(row.carried_to ?? '');
  expect(landed).toMatchObject({ version: 2, state: 'active' });
  // A carried group is a group of its own on the new version (BR-14).
  if (landed?.group_id) expect(groupsBefore.has(landed.group_id)).toBe(false);
}

describe('carry-over to a new version (KBC-093 NFR-3)', () => {
  let world: World;
  beforeAll(async () => {
    world = await startWorld();
  });
  afterAll(closeApp);

  it('every correction in force ends carried or not carried, and the new version is saved', async () => {
    await fc.assert(
      fc.asyncProperty(
        speechArb,
        fc.array(actArb, { minLength: 1, maxLength: 8 }),
        fc.array(changeArb, { minLength: 1, maxLength: 12 }),
        async (speech, acts, changes) => {
          const { owner } = world.media;
          const recording = await transcribed(world, speech);
          for (const step of acts)
            expect(await act(owner, recording.id, step)).toBeLessThan(500);
          // An undo row stays "active" but is not a correction to carry (ADR 0034 §6).
          const inForce = logOf(world, recording.id).filter(
            (row) => row.state === 'active' && row.kind !== 'undo',
          );
          const groupsBefore = new Set(
            inForce.map((row) => row.group_id).filter(Boolean),
          );

          const asked = await owner(
            'POST',
            `/api/v1/media/${recording.id}/transcription`,
            {},
          );
          expect(asked.statusCode, asked.body).toBeLessThan(300);
          // `say` asserts the new version is accepted (204): a carry never fails it.
          await say(world, nextVersion(speech, changes));

          const after = new Map(
            logOf(world, recording.id).map((row) => [row.id, row]),
          );
          for (const { id } of inForce) settled(after, id, groupsBefore);
          // Each line of the history is one version (BR-14).
          for (const entry of (await historyOf(owner, recording.id)).entries)
            expect(new Set(entry.items.map((item) => item.version)).size).toBe(
              1,
            );
        },
      ),
      { numRuns: 15, seed: 93_034, endOnFailure: true },
    );
  }, 180_000);
});
