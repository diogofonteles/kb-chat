import { describe, expect, it } from 'vitest';
import {
  researchEventSchema,
  researchRequestSchema,
  type ResearchEvent,
} from './research.js';
import { savedResearchTurnSchema } from './conversations.js';
import {
  MAX_COVERED_DOCUMENTS,
  mergeFindings,
  sweepCoverageSchema,
  sweepCursorSchema,
  sweepPlanSchema,
  type SweepCursor,
} from './sweep.js';

const plan = {
  target: { authorship: 'mestre-laercio' },
  phrases: ['livro', 'obra'],
  extract: 'livros citados de forma positiva, com trecho e documento',
} as const;

const cursor: SweepCursor = {
  plan: sweepPlanSchema.parse(plan),
  after: 'raw/temas/b.md',
  totals: { documents: 10, scanned: 4, withHits: 2, read: 2, batches: 1 },
  findings: [{ id: 'raw/temas/a.md', text: 'O Caibalion — “leiam”' }],
};

const coverage = {
  target: plan.target,
  phrases: ['livro'],
  documents: 10,
  scanned: 10,
  withHits: 3,
  read: 3,
  needed: 3,
  missing: 0,
  batches: 2,
};

describe('sweep contracts (KBC-030)', () => {
  it('defaults a plan without phrases to a full read and refuses an empty extraction', () => {
    expect(
      sweepPlanSchema.parse({ target: {}, extract: 'livros citados' }).phrases,
    ).toEqual([]);
    expect(
      sweepPlanSchema.safeParse({ target: {}, extract: ' ' }).success,
    ).toBe(false);
    expect(
      sweepPlanSchema.safeParse({
        target: { authorship: 'nobody' },
        extract: 'x y z',
      }).success,
    ).toBe(false);
  });

  it('takes a sweep cursor on an exhaustive request (Continuar varredura)', () => {
    const request = researchRequestSchema.parse({
      question: 'livros',
      profile: 'exhaustive',
      sweep: cursor,
    });
    expect(request.sweep?.after).toBe('raw/temas/b.md');
  });

  it('refuses a cursor on a fast or deep request', () => {
    expect(
      researchRequestSchema.safeParse({
        question: 'livros',
        profile: 'deep',
        sweep: cursor,
      }).success,
    ).toBe(false);
  });

  it('carries the findings so far, and refuses more than the cap', () => {
    expect(
      sweepCursorSchema.parse({ ...cursor, findings: undefined }).findings,
    ).toEqual([]);
    const many = Array.from({ length: 601 }, (_, i) => ({
      id: `d${i}`,
      text: 'x',
    }));
    expect(
      sweepCursorSchema.safeParse({ ...cursor, findings: many }).success,
    ).toBe(false);
  });

  it('takes the covered mark as bounded base64, and cursors without it (KBC-101)', () => {
    expect(sweepCursorSchema.parse(cursor).covered).toBeUndefined();
    expect(
      sweepCursorSchema.parse({ ...cursor, covered: 'AAAAAQ==' }).covered,
    ).toBe('AAAAAQ==');
    expect(
      sweepCursorSchema.safeParse({ ...cursor, covered: 'não é base64' })
        .success,
    ).toBe(false);
    const tooMany = 'A'.repeat(Math.ceil((MAX_COVERED_DOCUMENTS * 4) / 3) + 8);
    expect(
      sweepCursorSchema.safeParse({ ...cursor, covered: tooMany }).success,
    ).toBe(false);
  });

  it('refuses cursor totals that do not add up', () => {
    const bad = { ...cursor, totals: { ...cursor.totals, read: 11 } };
    expect(sweepCursorSchema.safeParse(bad).success).toBe(false);
  });

  it('streams sweep progress and a done event with coverage and cursor', () => {
    const events: ResearchEvent[] = [
      {
        type: 'sweep',
        sweep: {
          status: 'planned',
          documents: 10,
          needed: 10,
          minutes: 1,
          documentsDone: 0,
          batches: 4,
          batchesDone: 0,
          requests: 6,
          free: true,
        },
      },
      {
        type: 'sweep',
        sweep: {
          status: 'running',
          documents: 10,
          needed: 10,
          documentsDone: 4,
          batches: 4,
          batchesDone: 1,
          requests: 6,
          free: true,
          cursor,
        },
      },
      {
        type: 'done',
        usd: 0,
        billing: 'free',
        model: 'm',
        interrupted: false,
        steps: 2,
        coverage: { ...coverage, needed: 9, missing: 6, reason: 'requests' },
        sweep: cursor,
      },
    ];
    for (const event of events)
      expect(researchEventSchema.parse(event)).toEqual(event);
  });

  it('keeps coverage and the cursor with a saved turn; older turns stay valid', () => {
    const turn = {
      question: 'q',
      answer: 'a',
      sources: [],
      steps: 1,
      usd: 0,
      model: 'm',
      interrupted: false,
      at: '2026-10-27T10:00:00.000Z',
    };
    expect(savedResearchTurnSchema.parse(turn).coverage).toBeUndefined();
    const saved = savedResearchTurnSchema.parse({
      ...turn,
      coverage,
      sweep: cursor,
    });
    expect(saved.coverage?.documents).toBe(10);
    expect(saved.sweep?.after).toBe('raw/temas/b.md');
  });

  it('refuses a coverage that counts more than the set', () => {
    expect(
      sweepCoverageSchema.safeParse({ ...coverage, scanned: 11 }).success,
    ).toBe(false);
  });

  it('merges findings without repeats and within the cap', () => {
    const a = { id: 'd1', text: 'A' };
    const b = { id: 'd2', text: 'B' };
    expect(mergeFindings([a], [b, a])).toEqual([a, b]);
    const many = Array.from({ length: 700 }, (_, i) => ({
      id: `d${i}`,
      text: 'x',
    }));
    expect(mergeFindings(many)).toHaveLength(600);
  });
});
