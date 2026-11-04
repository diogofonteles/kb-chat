import { z } from 'zod';
import { mediaIdSchema } from './media.js';
import {
  TRACK_TITLE_MAX,
  proposalEstimateSchema,
  proposalFailureSchema,
  proposalStatusSchema,
} from './track-proposals.js';

/**
 * Subjects of a track (KBC-069, ADR 0029 §6): a concept of the collection, read-only from the
 * catalog, or a free subject kept in `media.db`. The vault is never written (Q7), and a
 * suggestion of the app's AI counts only once a person accepted it (BR-3).
 */

/** The most subjects a track holds (BR-1). */
export const MAX_TRACK_SUBJECTS = 5;

/** Longest subject name (FR-1). */
export const SUBJECT_NAME_MAX = 80;

/** A summary of one or two sentences. */
export const TRACK_SUMMARY_MAX = 400;

const COMBINING_MARKS = /\p{M}/gu;

/** The form two names are compared in: no accent, no capitals, single spaces (FR-1). */
export const subjectKey = (name: string): string =>
  name
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');

const subjectNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(SUBJECT_NAME_MAX)
  .refine((name) => !/[\r\n\t]/.test(name), { error: 'One line only' });

/** A free subject of a collection; a sub-collection uses its parent's (BR-1). */
export const freeSubjectSchema = z.object({
  id: z.uuid(),
  name: z.string(),
});
export type FreeSubject = z.infer<typeof freeSubjectSchema>;

/** GET /api/v1/topics/{slug}/subjects: everything a track of that collection can link to. */
export const collectionSubjectsSchema = z.object({
  /** Concept names, as the catalog resolves them (BR-1). */
  concepts: z.array(z.string()),
  free: z.array(freeSubjectSchema),
});
export type CollectionSubjects = z.infer<typeof collectionSubjectsSchema>;

/** POST /api/v1/topics/{slug}/subjects. */
export const createSubjectRequestSchema = z.strictObject({
  name: subjectNameSchema,
});
export type CreateSubjectRequest = z.input<typeof createSubjectRequestSchema>;

/** A subject as a write names it. */
export const subjectRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('concept'), name: z.string().min(1) }),
  z.strictObject({ kind: z.literal('free'), id: z.uuid() }),
]);
export type SubjectRef = z.infer<typeof subjectRefSchema>;

/** A subject accepted on a track, as who edits reads it. */
export const trackSubjectSchema = z.object({
  kind: z.enum(['concept', 'free']),
  /** The concept's name or the free subject's. */
  name: z.string(),
  /** The free subject's id; null for a concept. */
  id: z.uuid().nullable(),
  /** It is no longer in the collection: the link stays, flagged (BR-4). */
  missing: z.boolean(),
});
export type TrackSubject = z.infer<typeof trackSubjectSchema>;

/** A chip "Sugerido" waiting for a person (FR-4); `new` is "Novo assunto: «nome»" (BR-2). */
export const subjectSuggestionSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['concept', 'free', 'new']),
  name: z.string(),
});
export type SubjectSuggestion = z.infer<typeof subjectSuggestionSchema>;

/** A track with what is accepted on it and what still waits for a person. */
export const trackSubjectsSchema = z.object({
  mediaId: mediaIdSchema,
  title: z.string().max(TRACK_TITLE_MAX),
  /** Its place among the approved tracks; null on a track that left them. */
  ordinal: z.number().int().positive().nullable(),
  /** `If-Match` of the next write to this track (0 before the first). */
  version: z.number().int().nonnegative(),
  summary: z.string().nullable(),
  subjects: z.array(trackSubjectSchema),
  suggestions: z.array(subjectSuggestionSchema),
  suggestedSummary: z.string().nullable(),
});
export type TrackSubjects = z.infer<typeof trackSubjectsSchema>;

/** PUT /api/v1/media/{id}/subjects: the whole accepted list, with `If-Match` (FR-2). */
export const saveTrackSubjectsRequestSchema = z.strictObject({
  subjects: z
    .array(subjectRefSchema)
    .max(MAX_TRACK_SUBJECTS, { error: 'Too many subjects' }),
  summary: z
    .string()
    .max(TRACK_SUMMARY_MAX)
    .nullable()
    .transform((summary) => summary?.trim() || null),
});
export type SaveTrackSubjectsRequest = z.input<
  typeof saveTrackSubjectsRequestSchema
>;

/** POST /api/v1/media/{id}/subjects/decisions: chips one by one or a whole track (FR-4). */
export const decideSuggestionsRequestSchema = z
  .strictObject({
    accept: z.array(z.uuid()).max(MAX_TRACK_SUBJECTS).default([]),
    refuse: z.array(z.uuid()).max(MAX_TRACK_SUBJECTS).default([]),
    summary: z.enum(['accept', 'refuse']).nullable().default(null),
  })
  .refine(
    ({ accept, refuse, summary }) =>
      accept.length + refuse.length > 0 || summary !== null,
    { error: 'Nothing was decided' },
  )
  .refine(({ accept, refuse }) => !accept.some((id) => refuse.includes(id)), {
    error: 'A suggestion cannot be both accepted and refused',
  });
export type DecideSuggestionsRequest = z.input<
  typeof decideSuggestionsRequestSchema
>;

/** One "Sugerir assuntos com IA" (FR-3): a single model call over every track. */
export const subjectRunSchema = z.object({
  id: z.uuid(),
  mediaId: mediaIdSchema,
  status: proposalStatusSchema,
  model: z.string(),
  estimateUsd: z.number().nonnegative(),
  spentUsd: z.number().nonnegative(),
  failure: proposalFailureSchema.nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type SubjectRun = z.infer<typeof subjectRunSchema>;

/** GET /api/v1/media/{id}/edit/subjects: the step 4 of the approved recording. */
export const editSubjectsSchema = z.object({
  tracks: z.array(trackSubjectsSchema),
  /** The newest run, whatever its end. */
  run: subjectRunSchema.nullable(),
  /** False once this approval has its suggestions, or when no track is approved. */
  canSuggest: z.boolean(),
});
export type EditSubjects = z.infer<typeof editSubjectsSchema>;

/** POST /api/v1/media/{id}/edit/subject-proposals: `dryRun` is explicit, a run spends money. */
export const subjectProposalRequestSchema = z.strictObject({
  dryRun: z.boolean(),
});
export const subjectEstimateSchema = proposalEstimateSchema;
