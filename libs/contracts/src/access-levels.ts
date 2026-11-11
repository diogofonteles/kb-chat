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
  /** Audios of media.db at this level, recordings and tracks (KBC-108). */
  media: z.number().int().nonnegative(),
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
  /** The scale's version: a reorder or a delete applies only while it holds (KBC-108 BR-3). */
  version: z.lazy(() => levelsVersionSchema),
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

/** A scale's version, as `GET …/levels` and a preview give it (KBC-108 FR-5). */
export const levelsVersionSchema = z.string().min(1).max(64);

/**
 * PATCH …/levels: the whole scale in its new order, lowest first (AC-12), applied only while
 * the scale is still at the version its preview was made on (KBC-108 BR-3).
 */
export const levelOrderSchema = z.strictObject({
  order: z.array(levelRefSchema).min(1).max(LEVELS_PER_SCALE_MAX),
  version: levelsVersionSchema,
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
  kind: z.lazy(() => levelAuditKindSchema),
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
  filter: z.lazy(() => bulkAuditFilterSchema).optional(),
  /**
   * Where a person's level was set (KBC-109 BR-4): the person editor (a grant included), an
   * invitation, "Aplicar perfil" or the people bulk. Absent on older lines.
   */
  via: z.lazy(() => personLevelViaSchema).optional(),
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

/** What a `bulk` line records of its request: the filter as of `asOf`, or how many ids. */
export const bulkAuditFilterSchema = z.union([
  unassignedFilterSchema.extend({ asOf: z.iso.datetime() }),
  z.strictObject({ ids: z.number().int().positive() }),
]);
export type BulkAuditFilter = z.infer<typeof bulkAuditFilterSchema>;

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

/* ---------- People's levels in invitations, profiles and in bulk (KBC-109) ---------- */

export const PERSON_LEVEL_VIAS = [
  'editor',
  'invite',
  'profile',
  'bulk',
  /** KBC-108: a level deleted, or every level taken away. */
  'scale',
] as const;
export const personLevelViaSchema = z.enum(PERSON_LEVEL_VIAS);
export type PersonLevelVia = z.infer<typeof personLevelViaSchema>;

/** The most people one bulk names (as the documents' bulk, BR-3 of KBC-107). */
export const PEOPLE_BULK_MAX = 5000;

const peopleBulkTargetSchema = {
  /** A top-level collection with a scale. */
  topic: topicSlugSchema,
  level: levelRefSchema,
};

/** POST /api/v1/people/levels (masters, FR-3): a level for the people named, or everyone. */
export const peopleLevelRequestSchema = z.union([
  z.strictObject({
    ...peopleBulkTargetSchema,
    ids: z.array(z.uuid()).min(1).max(PEOPLE_BULK_MAX),
  }),
  z.strictObject({ ...peopleBulkTargetSchema, all: z.literal(true) }),
]);
export type PeopleLevelRequest = z.infer<typeof peopleLevelRequestSchema>;

export const peopleLevelResultSchema = z.object({
  collection: topicSlugSchema,
  level: levelChoiceSchema,
  /** People whose level changed. */
  updated: z.number().int().nonnegative(),
  /** People already at that level. */
  unchanged: z.number().int().nonnegative(),
  /** Masters named: they see every level and are left as they are. */
  masters: z.number().int().nonnegative(),
  /** People who do not reach the collection: no level is given ahead of the access. */
  withoutAccess: z.number().int().nonnegative(),
  /** Ids of nobody (revoked meanwhile). */
  unknown: z.number().int().nonnegative(),
});
export type PeopleLevelResult = z.infer<typeof peopleLevelResultSchema>;

/* ---------- Managing the scale and its history (KBC-108, ADR 0036 §10, §11) ---------- */

/** What the levels audit records; `scale.delete` and `scale.clear` since KBC-108. */
export const LEVEL_AUDIT_KINDS = [
  'scale.create',
  'scale.rename',
  'scale.reorder',
  'scale.delete',
  'scale.clear',
  'person.level',
  'item.level',
  'bulk',
] as const;
export const levelAuditKindSchema = z.enum(LEVEL_AUDIT_KINDS);
export type LevelAuditKind = z.infer<typeof levelAuditKindSchema>;

/** POST …/levels/preview (FR-2): a new order, or the removal of one level. */
export const levelPreviewRequestSchema = z.union([
  z.strictObject({
    order: z.array(levelRefSchema).min(1).max(LEVELS_PER_SCALE_MAX),
    version: levelsVersionSchema,
  }),
  z.strictObject({ remove: levelRefSchema, version: levelsVersionSchema }),
]);
export type LevelPreviewRequest = z.infer<typeof levelPreviewRequestSchema>;

/** How many people gain (or lose) sight of how many items: counts, never names or titles. */
export const levelImpactSchema = z.object({
  people: z.number().int().nonnegative(),
  documents: z.number().int().nonnegative(),
  media: z.number().int().nonnegative(),
});
export type LevelImpact = z.infer<typeof levelImpactSchema>;

/** What a removal holds and where it goes by default (BR-2). */
export const levelRemovalSchema = z.object({
  level: levelChoiceSchema,
  documents: z.number().int().nonnegative(),
  media: z.number().int().nonnegative(),
  people: z.number().int().nonnegative(),
  /** The next higher level (the next lower, for the highest); null when it is the only one. */
  moveContentTo: levelRefSchema.nullable(),
  /** The next lower level (the next higher, for the lowest); null when it is the only one. */
  movePeopleTo: levelRefSchema.nullable(),
  /** The only level: removing it is "Tirar todos os níveis" (AC-6). */
  last: z.boolean(),
  /**
   * Invite profiles that name the level (KBC-109): they are not rewritten and read as
   * `staleLevels` afterwards, asking for a choice.
   */
  profiles: z.number().int().nonnegative(),
});
export type LevelRemoval = z.infer<typeof levelRemovalSchema>;

/** The answer of a preview, computed on the server (BR-3). */
export const levelPreviewSchema = z.object({
  version: levelsVersionSchema,
  gaining: levelImpactSchema,
  losing: levelImpactSchema,
  removal: levelRemovalSchema.nullable(),
});
export type LevelPreview = z.infer<typeof levelPreviewSchema>;

/** DELETE …/levels/:level (FR-1): where its content and its people go, in one operation. */
export const levelDeleteSchema = z.strictObject({
  moveContentTo: levelRefSchema,
  movePeopleTo: levelRefSchema,
  version: levelsVersionSchema,
});
export type LevelDelete = z.infer<typeof levelDeleteSchema>;

/** DELETE …/levels (FR-3): every level goes, confirmed by the collection's slug. */
export const levelsClearSchema = z.strictObject({
  confirm: topicSlugSchema,
  version: levelsVersionSchema,
});
export type LevelsClear = z.infer<typeof levelsClearSchema>;

export const LEVEL_AUDIT_PAGE_DEFAULT = 20;
export const LEVEL_AUDIT_PAGE_MAX = 50;

/** GET /api/v1/levels/audit (FR-4): the filters of "Histórico de níveis". */
export const levelAuditQuerySchema = z.strictObject({
  /** A top-level collection: its lines and those of its sub-collections. */
  topic: topicSlugSchema.optional(),
  /** Who did it, or whom they acted as (part of an e-mail, any case). */
  actor: z.string().trim().min(1).max(320).optional(),
  kind: levelAuditKindSchema.optional(),
  /** One item or person: a document's, an audio's or a person's id. */
  target: z.string().min(1).max(1024).optional(),
  /** From and to this day (`YYYY-MM-DD`, UTC, inclusive). */
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(LEVEL_AUDIT_PAGE_MAX)
    .default(LEVEL_AUDIT_PAGE_DEFAULT),
});
export type LevelAuditQuery = z.input<typeof levelAuditQuerySchema>;

/** One line of the history as masters read it: names and codes in place of ids. */
export const levelAuditItemSchema = z.object({
  at: z.iso.datetime(),
  by: z.string(),
  /** The person's name, or the e-mail when there is none (`kb-chat` for the app). */
  byName: z.string(),
  actingAs: z.string().nullable(),
  actingAsName: z.string().nullable(),
  kind: levelAuditKindSchema,
  collection: topicSlugSchema,
  /** The id the line is about (item, person or level), for "Só este item". */
  target: z.string().nullable(),
  /** The item's title, the person's name or the level's code; null when it is gone. */
  targetLabel: z.string().nullable(),
  /** Before → after in codes ("CI", "QS, CI, CDC"); null when there was none. */
  before: z.string().nullable(),
  after: z.string().nullable(),
  /** For `scale.delete`: the codes its content and its people went to. */
  moves: z.object({ content: z.string(), people: z.string() }).nullable(),
  /** Whether the target is a document, an audio, a person or a level. */
  subject: z.enum(['document', 'media', 'person', 'level']).nullable(),
  count: levelAuditEntrySchema.shape.count,
});
export type LevelAuditItem = z.infer<typeof levelAuditItemSchema>;

export const levelAuditPageSchema = z.object({
  items: z.array(levelAuditItemSchema),
  nextCursor: z.string().nullable(),
});
export type LevelAuditPage = z.infer<typeof levelAuditPageSchema>;
