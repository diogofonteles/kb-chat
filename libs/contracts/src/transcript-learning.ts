import { z } from 'zod';

/**
 * Learning from word corrections (KBC-113, ADR 0037): rules with context applied to new
 * transcripts and learned terms appended to the term list; masters see and switch them.
 */

/** `auto-off`: its undone replacements reached its corrections (BR-8). */
export const learnedRuleStateSchema = z.enum([
  'on',
  'off',
  'auto-off',
  'conflict',
]);
export type LearnedRuleState = z.infer<typeof learnedRuleStateSchema>;

/** `no-room`: does not fit in what the masters' terms leave of the limit (BR-9). */
export const learnedTermStateSchema = z.enum(['in-list', 'no-room', 'off']);
export type LearnedTermState = z.infer<typeof learnedTermStateSchema>;

/** A rule or term id: a hash of what it is, stable across reads. */
export const learningIdSchema = z.string().regex(/^[0-9a-f]{32}$/);

export const learnedExampleSchema = z.object({
  mediaId: z.string(),
  title: z.string(),
  startMs: z.number().int().min(0),
  before: z.string(),
  after: z.string(),
  contextBefore: z.string(),
  contextAfter: z.string(),
  authorName: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type LearnedExample = z.infer<typeof learnedExampleSchema>;

export const learnedRuleSchema = z.object({
  id: learningIdSchema,
  before: z.string(),
  after: z.string(),
  /** Null: the rule applies in any context (BR-3). '' is a segment's edge. */
  contextBefore: z.string().nullable(),
  contextAfter: z.string().nullable(),
  corrections: z.number().int().min(1),
  recordings: z.number().int().min(1),
  applied: z.number().int().min(0),
  undone: z.number().int().min(0),
  state: learnedRuleStateSchema,
  /** The master who switched it, when one did. */
  switchedBy: z.string().nullable(),
  conflictWith: z.string().nullable(),
  /** At most 3, newest first. */
  examples: z.array(learnedExampleSchema).max(3),
});
export type LearnedRule = z.infer<typeof learnedRuleSchema>;

export const learnedTermSchema = z.object({
  id: learningIdSchema,
  term: z.string(),
  corrections: z.number().int().min(1),
  recordings: z.number().int().min(1),
  state: learnedTermStateSchema,
  switchedBy: z.string().nullable(),
});
export type LearnedTerm = z.infer<typeof learnedTermSchema>;

/** GET /api/v1/media/learning (masters). */
export const transcriptLearningSchema = z.object({
  rules: z.array(learnedRuleSchema),
  terms: z.array(learnedTermSchema),
  /** The prompt's use: the masters' terms, the learned ones in the list, the limit. */
  tokens: z.object({
    manual: z.number().int().min(0),
    learned: z.number().int().min(0),
    limit: z.number().int().min(1),
  }),
});
export type TranscriptLearning = z.infer<typeof transcriptLearningSchema>;

/** PUT /api/v1/media/learning/{rules|terms}/:id: null goes back to automatic (BR-11). */
export const learningSwitchRequestSchema = z.strictObject({
  enabled: z.boolean().nullable(),
});
export type LearningSwitchRequest = z.infer<typeof learningSwitchRequestSchema>;

export const learningSwitchParamsSchema = z.object({ id: learningIdSchema });

/** A span of words the learning replaced on the current version (FR-5). */
export const learnedSpanSchema = z.object({
  position: z.number().int().min(0),
  count: z.number().int().min(1),
  correctionId: z.uuid(),
  /** What the transcript said there before. */
  before: z.string(),
});
export type LearnedSpan = z.infer<typeof learnedSpanSchema>;
