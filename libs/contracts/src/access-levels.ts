import { z } from 'zod';
import { authorshipSchema } from './facets.js';
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
  /**
   * For `bulk`: how many documents, people and audios the first scale placed (and, KBC-107, a bulk placed or skipped); for a media
   * `item.level`, the recording and the tracks that followed it (KBC-105 BR-7).
   */
  count: z
    .object({
      documents: z.number().int().nonnegative().optional(),
      people: z.number().int().nonnegative().optional(),
      media: z.number().int().nonnegative().optional(),
      recordings: z.number().int().nonnegative().optional(),
      tracks: z.number().int().nonnegative().optional(),
      /** KBC-107: named documents a bulk left as they were. */
      skipped: z.number().int().nonnegative().optional(),
    })
    .optional(),
  /** For a `bulk` of KBC-107: the filter it applied, or `{ ids: n }` for a selection. */
  filter: z.unknown().optional(),
});
export type LevelAuditEntry = z.infer<typeof levelAuditEntrySchema>;

/* ---------- "Sem nível" and bulk levels (KBC-107, ADR 0036 §5, §9) ---------- */

/** How a document reached the vault, as a filter: typed text, an audio or an OCR. */
export const UNASSIGNED_ORIGINS = ['text', 'audio', 'ocr'] as const;
export const unassignedOriginSchema = z.enum(UNASSIGNED_ORIGINS);
export type UnassignedOrigin = z.infer<typeof unassignedOriginSchema>;

export const UNASSIGNED_PAGE_DEFAULT = 10;
export const UNASSIGNED_PAGE_MAX = 50;
/** The most documents one bulk request names (BR-3). */
export const BULK_IDS_MAX = 5000;

/** The filters of the "Sem nível" list, as the query and the bulk filter carry them. */
export const unassignedFilterSchema = z.strictObject({
  /** One collection of the scope (the collection itself or a sub-collection). */
  collection: topicSlugSchema.optional(),
  origin: unassignedOriginSchema.optional(),
  authorship: authorshipSchema.optional(),
  /** The folder of the document in its collection (`raw`, `wiki/concepts`); `` for the root. */
  folder: z.string().max(1024).optional(),
  /** Arrived on or after this day (`YYYY-MM-DD`, UTC). */
  since: z.iso.date().optional(),
});
export type UnassignedFilter = z.infer<typeof unassignedFilterSchema>;

/** GET …/levels/unassigned: the filters, the opaque cursor and the page size (FR-1). */
export const unassignedQuerySchema = unassignedFilterSchema.extend({
  cursor: z.string().max(200).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(UNASSIGNED_PAGE_MAX)
    .default(UNASSIGNED_PAGE_DEFAULT),
});
export type UnassignedQuery = z.input<typeof unassignedQuerySchema>;

/** One document waiting for a level. */
export const unassignedDocumentSchema = z.object({
  /** Its own collection (a sub-collection's slug when it is in one). */
  topic: topicSlugSchema,
  id: z.string(),
  title: z.string(),
  origin: unassignedOriginSchema,
  authorship: authorshipSchema,
  author: z.string().nullable(),
  folder: z.string(),
  /** When the app first saw it in a collection with a scale (FR-5). */
  firstSeenAt: z.iso.datetime(),
});
export type UnassignedDocument = z.infer<typeof unassignedDocumentSchema>;

const facetValuesSchema = <T extends z.ZodType>(value: T) =>
  z.array(z.object({ value, count: z.number().int().nonnegative() }));

/** The answer of GET …/levels/unassigned. */
export const unassignedPageSchema = z.object({
  /** The top-level collection whose queue this is. */
  collection: topicSlugSchema,
  /** Every document without a level the caller may classify, before the filters. */
  total: z.number().int().nonnegative(),
  /** The documents the filters keep, over every page. */
  matched: z.number().int().nonnegative(),
  /** The moment the list was made: a bulk by filter takes only what had arrived (BR-3). */
  asOf: z.iso.datetime(),
  items: z.array(unassignedDocumentSchema),
  nextCursor: z.string().nullable(),
  /** The values each filter can take, over the whole queue. */
  facets: z.object({
    collections: facetValuesSchema(topicSlugSchema),
    origins: facetValuesSchema(unassignedOriginSchema),
    authorships: facetValuesSchema(authorshipSchema),
    folders: facetValuesSchema(z.string()),
  }),
  /** The levels the caller may give: up to their own (masters: every one). */
  levels: z.array(levelChoiceSchema),
});
export type UnassignedPage = z.infer<typeof unassignedPageSchema>;

/** GET …/levels/choices: the levels the caller may give in this collection (T3, search). */
export const levelChoicesSchema = z.object({
  collection: topicSlugSchema,
  levels: z.array(levelChoiceSchema),
});
export type LevelChoices = z.infer<typeof levelChoicesSchema>;

/** A document of the scope, by its own collection. */
export const documentKeySchema = z.strictObject({
  topic: topicSlugSchema,
  id: z.string().min(1).max(1024),
});
export type DocumentKey = z.infer<typeof documentKeySchema>;

/**
 * POST …/document-levels (FR-2): a level for a selection, or for the "Sem nível" documents
 * the filter keeps among those that had arrived at `asOf` (BR-3).
 */
export const bulkLevelRequestSchema = z.union([
  z.strictObject({
    level: levelRefSchema,
    ids: z.array(documentKeySchema).min(1).max(BULK_IDS_MAX),
  }),
  z.strictObject({
    level: levelRefSchema,
    filter: unassignedFilterSchema.extend({ asOf: z.iso.datetime() }),
  }),
]);
export type BulkLevelRequest = z.infer<typeof bulkLevelRequestSchema>;

export const bulkLevelResultSchema = z.object({
  level: levelChoiceSchema,
  updated: z.number().int().nonnegative(),
  /** Named documents the caller may not see, unknown or tracks: left as they were. */
  skipped: z.number().int().nonnegative(),
});
export type BulkLevelResult = z.infer<typeof bulkLevelResultSchema>;

/** GET /api/v1/levels/unassigned: the sidebar's "N documentos sem nível" per collection. */
export const unassignedCountsSchema = z.object({
  items: z.array(
    z.object({
      collection: topicSlugSchema,
      unassigned: z.number().int().nonnegative(),
    }),
  ),
});
export type UnassignedCounts = z.infer<typeof unassignedCountsSchema>;
