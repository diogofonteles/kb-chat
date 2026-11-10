import {
  levelCodeSchema,
  levelIdSchema,
  levelRefSchema,
} from '@kb-chat/contracts';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import type { DocumentStorePort } from '../../ports/document-store.js';
import { SerialDocument } from '../../serial-document.js';

/**
 * A level as read: its id is only a reference, so a scale written before ids were bounded
 * still loads (QA-3: a bad file must never stop the API from starting). New levels are held
 * to `levelIdSchema` before they are written (`newLevelsSchema`).
 */
const storedLevelSchema = z.strictObject({
  id: levelRefSchema,
  code: z.string().min(1).max(64),
  description: z.string(),
  /** Who created it (the master, also when acting as a person). */
  createdBy: z.string(),
  createdAt: z.string(),
});
export type StoredLevel = z.infer<typeof storedLevelSchema>;

/** What a write may put in a scale: every id a proper level id, every code a proper code. */
const newLevelsSchema = z.array(
  storedLevelSchema.extend({ id: levelIdSchema, code: levelCodeSchema }),
);

const scalesSchema = z.strictObject({
  version: z.literal(1),
  /** By top-level collection slug, lowest level first (ADR 0036 §1). */
  scales: z.record(z.string(), z.array(storedLevelSchema)),
});
type Scales = z.infer<typeof scalesSchema>;

const placedSchema = z.strictObject({
  level: levelRefSchema,
  setBy: z.string(),
  setAt: z.string(),
});
export type PlacedDocument = z.infer<typeof placedSchema>;

const placementsSchema = z.strictObject({
  version: z.literal(1),
  /** By the document's own collection (a sub-collection included), then by document id. */
  collections: z.record(z.string(), z.record(z.string(), placedSchema)),
});
type Placements = z.infer<typeof placementsSchema>;

/** One collection's documents and their levels. */
export type CollectionPlacements = Readonly<Record<string, PlacedDocument>>;

export interface LevelStores {
  /** `access-levels.json`. */
  readonly scales: DocumentStorePort;
  /** `document-levels.json`. */
  readonly documents: DocumentStorePort;
}

const NO_LEVELS: readonly StoredLevel[] = [];

/** The levels a write adds or renames must be proper; ones already stored stay as they are. */
function assertWritable(
  before: readonly StoredLevel[],
  next: readonly StoredLevel[],
): void {
  const changed = next.filter(
    (level) =>
      !before.some((one) => one.id === level.id && one.code === level.code),
  );
  if (!newLevelsSchema.safeParse(changed).success)
    throw new AppError('VALIDATION_FAILED', 'Invalid level', {
      details: { field: 'code' },
    });
}
const NONE: CollectionPlacements = {};

const serial = <T extends object>(
  store: DocumentStorePort,
  file: {
    readonly schema: z.ZodType<T>;
    readonly empty: () => T;
    readonly name: string;
  },
) =>
  new SerialDocument<T>({
    store,
    empty: file.empty,
    parse: (raw) => {
      const parsed = file.schema.safeParse(raw);
      if (!parsed.success)
        throw new AppError('INTERNAL', `${file.name} is invalid`);
      return parsed.data;
    },
  });

/**
 * The scales and the document levels (ADR 0036 §1, §3), in the state folder, never in the
 * vault (Q7). Read from memory, loaded once and kept in step with each write; `version`
 * grows on every write so views can memoize per state.
 */
export class LevelDirectory {
  private readonly scaleDoc: SerialDocument<Scales>;
  private readonly placementDoc: SerialDocument<Placements>;
  private scales: Scales = { version: 1, scales: {} };
  private placements: Placements = { version: 1, collections: {} };
  private changes = 0;

  constructor(stores: LevelStores) {
    this.scaleDoc = serial(stores.scales, {
      schema: scalesSchema,
      empty: () => ({ version: 1, scales: {} }),
      name: 'access-levels.json',
    });
    this.placementDoc = serial(stores.documents, {
      schema: placementsSchema,
      empty: () => ({ version: 1, collections: {} }),
      name: 'document-levels.json',
    });
  }

  async load(): Promise<void> {
    this.scales = await this.scaleDoc.read();
    this.placements = await this.placementDoc.read();
    this.changes += 1;
  }

  /** Grows on every write: what a memo keys on. */
  get version(): number {
    return this.changes;
  }

  /** A top-level collection's levels, lowest first; empty when it has none. */
  scaleOf(root: string): readonly StoredLevel[] {
    return this.scales.scales[root] ?? NO_LEVELS;
  }

  /** The documents of one collection that hold a level. */
  placementsOf(collection: string): CollectionPlacements {
    return this.placements.collections[collection] ?? NONE;
  }

  /** Replaces a scale; the result is what `apply` returns. */
  async changeScale<R>(
    root: string,
    apply: (levels: readonly StoredLevel[]) => {
      readonly next: readonly StoredLevel[];
      readonly result: R;
    },
  ): Promise<R> {
    const written: { doc?: Scales } = {};
    const result = await this.scaleDoc.change((doc) => {
      const { next, result: answer } = apply(doc.scales[root] ?? NO_LEVELS);
      assertWritable(doc.scales[root] ?? NO_LEVELS, next);
      const changed = { ...doc, scales: { ...doc.scales, [root]: [...next] } };
      written.doc = changed;
      return { doc: changed, result: answer };
    });
    // Only once the file holds it: a failed write leaves memory as the file is.
    if (written.doc) this.scales = written.doc;
    this.changes += 1;
    return result;
  }

  /** Sets the level of documents, collection by collection, in one write. */
  async place(
    byCollection: Readonly<Record<string, CollectionPlacements>>,
  ): Promise<void> {
    const written: { doc?: Placements } = {};
    await this.placementDoc.change((doc) => {
      const collections = { ...doc.collections };
      for (const [collection, placed] of Object.entries(byCollection))
        collections[collection] = { ...collections[collection], ...placed };
      written.doc = { ...doc, collections };
      return { doc: written.doc, result: undefined };
    });
    if (written.doc) this.placements = written.doc;
    this.changes += 1;
  }
}
