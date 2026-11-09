import { z } from 'zod';
import { topicSlugSchema } from './topics.js';

/**
 * Access levels per collection (KBC-103, ADR 0036): a top-level collection may hold an
 * ordered scale (lowest first); a person sees the items at their level and below. A
 * sub-collection uses its parent's scale.
 */

/** A level's code as people read it: "QS", "QM+" (BR-2: up to 12 characters). */
export const LEVEL_CODE_MAX = 12;
export const LEVEL_DESCRIPTION_MAX = 200;
/** The most levels one scale holds (T24 "conteúdo extremo": 20). */
export const LEVELS_PER_SCALE_MAX = 20;

export const levelCodeSchema = z.string().trim().min(1).max(LEVEL_CODE_MAX);
export const levelDescriptionSchema = z
  .string()
  .trim()
  .max(LEVEL_DESCRIPTION_MAX);
/** A new level's fixed id, derived from its first code (`qm-plus`). */
export const levelIdSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export type LevelId = z.infer<typeof levelIdSchema>;

/**
 * A reference to a level that exists: the scale decides whether it does. Looser than a new id
 * so that a scale written before ids were bounded still reads and answers (QA-3).
 */
export const levelRefSchema = z.string().min(1).max(200);

/** The longest base an id takes from its code, leaving room for a `-n` suffix. */
const LEVEL_ID_BASE_MAX = 32;

/** Lower case, no accents: two codes that fold the same are the same code (BR-2). */
export const foldLevelCode = (code: string): string =>
  code
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .trim()
    .toLocaleLowerCase('pt-BR');

/** The id a code gets once, when the level is created: "QM+" → "qm-plus", "C.I." → "c-i". */
export const levelIdOf = (code: string): string =>
  foldLevelCode(code)
    .replace(/\+/g, '-plus-')
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, LEVEL_ID_BASE_MAX)
    .replace(/^-+|-+$/g, '');

/** One level of a scale, as masters see it on T24. */
export const accessLevelSchema = z.object({
  id: levelRefSchema,
  code: levelCodeSchema,
  description: z.string(),
  /** Vault documents at this level, in the collection and its sub-collections. */
  documents: z.number().int().nonnegative(),
  /** People with access who hold this level (an unknown or missing one counts as the lowest). */
  people: z.number().int().nonnegative(),
});
export type AccessLevel = z.infer<typeof accessLevelSchema>;

/** GET /api/v1/topics/:topic/levels: the scale of the collection's top level. */
export const topicLevelsSchema = z.object({
  /** The top-level collection whose scale this is (the parent, for a sub-collection). */
  collection: topicSlugSchema,
  /** True when asked about a sub-collection: it uses its parent's scale (BR-1). */
  inherited: z.boolean(),
  /** Lowest first; empty: the collection has no levels and everyone with access sees all. */
  levels: z.array(accessLevelSchema),
  /** Vault documents of the collection and its sub-collections (the first scale's count). */
  documents: z.number().int().nonnegative(),
  /** People (not masters) with access to the collection or one of its sub-collections. */
  people: z.number().int().nonnegative(),
  /** Documents with no level ("Sem nível"): visible to masters only (BR-6). */
  unassigned: z.number().int().nonnegative(),
});
export type TopicLevels = z.infer<typeof topicLevelsSchema>;

/** A level as a choice (the person editor's "Nível em <acervo>"). */
export const levelChoiceSchema = z.object({
  id: levelRefSchema,
  code: levelCodeSchema,
});
export type LevelChoice = z.infer<typeof levelChoiceSchema>;

/** GET /api/v1/levels (masters): every top-level collection that has a scale. */
export const levelScalesSchema = z.object({
  items: z.array(
    z.object({
      collection: topicSlugSchema,
      levels: z.array(levelChoiceSchema),
    }),
  ),
});
export type LevelScales = z.infer<typeof levelScalesSchema>;

/** POST …/levels: a new level enters at the top of the scale (the highest). */
export const levelCreateSchema = z.strictObject({
  code: levelCodeSchema,
  description: levelDescriptionSchema.default(''),
});
export type LevelCreate = z.input<typeof levelCreateSchema>;

/** PATCH …/levels/:level: a new code or description; the id stays (AC-11). */
export const levelRenameSchema = z
  .strictObject({
    code: levelCodeSchema,
    description: levelDescriptionSchema,
  })
  .partial()
  .refine((body) => body.code !== undefined || body.description !== undefined);
export type LevelRename = z.infer<typeof levelRenameSchema>;

/** PATCH …/levels: the whole scale in its new order, lowest first (AC-12). */
export const levelOrderSchema = z.strictObject({
  order: z.array(levelRefSchema).min(1).max(LEVELS_PER_SCALE_MAX),
});
export type LevelOrder = z.infer<typeof levelOrderSchema>;

/** PUT …/documents/:id/level (masters, FR-4). */
export const documentLevelUpdateSchema = z.strictObject({
  level: levelRefSchema,
});
export type DocumentLevelUpdate = z.infer<typeof documentLevelUpdateSchema>;

/**
 * An item's level as masters see it: the level, or null for "Sem nível". Absent for whoever
 * does not manage levels and in a collection without a scale (members see no badges).
 */
export const contentLevelSchema = z
  .object({ id: levelRefSchema, code: levelCodeSchema })
  .nullable();
export type ContentLevel = z.infer<typeof contentLevelSchema>;

/** The answer of PUT …/documents/:id/level. */
export const documentLevelSchema = z.object({ level: contentLevelSchema });

/** A person's level per top-level collection with a scale: `{ hermetismo: "ci" }`. */
export const personLevelsSchema = z.record(topicSlugSchema, levelRefSchema);
export type PersonLevels = z.infer<typeof personLevelsSchema>;

/** One line of `audit/levels-YYYY-MM.jsonl` (FR-10, ADR 0036 §11). */
export const levelAuditEntrySchema = z.object({
  at: z.iso.datetime(),
  /** Whoever did it: the master acting, when acting as a person. */
  by: z.string(),
  /** The person a master was acting as, if any. */
  actingAs: z.string().optional(),
  kind: z.enum([
    'scale.create',
    'scale.rename',
    'scale.reorder',
    'person.level',
    'item.level',
    'bulk',
  ]),
  /** The top-level collection (or the document's own collection for `item.level`). */
  collection: topicSlugSchema,
  /** What changed: a level id, a document id, a person id. */
  target: z.string().optional(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  /** For `bulk`: how many items and people the first scale placed. */
  count: z
    .object({
      documents: z.number().int().nonnegative(),
      people: z.number().int().nonnegative(),
    })
    .optional(),
});
export type LevelAuditEntry = z.infer<typeof levelAuditEntrySchema>;
