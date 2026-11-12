import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { writeJsonFile } from '../atomic-json.js';

/**
 * What the import reads from an environment's app state (ADR 0038 §5, §6, §8): people,
 * level scales, app collections and authors. Loose schemas: a field this image does not know
 * never stops the import, and nothing here is written back but `authors.json`.
 */
const peopleSchema = z.object({
  people: z.array(
    z.looseObject({
      id: z.string(),
      email: z.string(),
      sub: z.string().nullish(),
      principal: z.string().nullish(),
    }),
  ),
});
const scalesSchema = z.object({
  scales: z.record(z.string(), z.array(z.looseObject({ id: z.string() }))),
});
const collectionsSchema = z.object({
  collections: z.array(
    z.looseObject({ slug: z.string(), parent: z.string().nullish() }),
  ),
});
const authorsSchema = z.looseObject({
  version: z.literal(1),
  collections: z.record(
    z.string(),
    z.looseObject({
      main: z.string().nullable(),
      authors: z.array(z.looseObject({ slug: z.string() })),
    }),
  ),
});
export type AuthorsFile = z.infer<typeof authorsSchema>;

/** The owner's principal on every side (ADR 0008). */
export const OWNER = 'owner';

function readJson<T>(path: string, schema: z.ZodType<T>, empty: T): T {
  if (!existsSync(path)) return empty;
  const parsed = schema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success)
    throw new Error(`${path} is not what the import expects`);
  return parsed.data;
}

export interface PrincipalEmail {
  readonly principal: string;
  readonly email: string;
}

/** Each person's principal and e-mail, as the API derives the principal (people-service). */
export function principalsOf(
  stateDir: string,
  ownerEmail: string,
): PrincipalEmail[] {
  const { people } = readJson(join(stateDir, 'people.json'), peopleSchema, {
    people: [],
  });
  const owner = ownerEmail.toLowerCase();
  return people.map((person) => ({
    principal:
      person.email.toLowerCase() === owner
        ? OWNER
        : (person.principal ?? person.sub ?? person.id),
    email: person.email.toLowerCase(),
  }));
}

/** The level ids of each top-level collection's scale; a collection without one is absent. */
export function scalesOf(
  stateDir: string,
): ReadonlyMap<string, ReadonlySet<string>> {
  const { scales } = readJson(
    join(stateDir, 'access-levels.json'),
    scalesSchema,
    {
      scales: {},
    },
  );
  return new Map(
    Object.entries(scales)
      .filter(([, levels]) => levels.length > 0)
      .map(([root, levels]) => [
        root,
        new Set(levels.map((level) => level.id)),
      ]),
  );
}

/** Each level id's code, by top-level collection: the report names a level that did not map. */
export function levelCodesOf(stateDir: string): Record<string, string> {
  const { scales } = readJson(
    join(stateDir, 'access-levels.json'),
    scalesSchema,
    {
      scales: {},
    },
  );
  return Object.fromEntries(
    Object.entries(scales).flatMap(([root, levels]) =>
      levels.map((level): [string, string] => [
        `${root}/${level.id}`,
        String(level.code ?? level.id),
      ]),
    ),
  );
}

export interface Collections {
  readonly vaultDir: string;
  readonly parents: ReadonlyMap<string, string | null>;
}

export function collectionsOf(stateDir: string, vaultDir: string): Collections {
  const { collections } = readJson(
    join(stateDir, 'collections.json'),
    collectionsSchema,
    {
      collections: [],
    },
  );
  return {
    vaultDir,
    parents: new Map(collections.map((one) => [one.slug, one.parent ?? null])),
  };
}

/** A collection production knows: an app collection, or a vault folder with topic.yaml. */
export function hasCollection(collections: Collections, slug: string): boolean {
  if (collections.parents.has(slug)) return true;
  return existsSync(join(collections.vaultDir, slug, 'topic.yaml'));
}

/** The top-level collection: the app's parent, else the vault folder holding it. */
export function rootOf(collections: Collections, slug: string): string {
  const parent = collections.parents.get(slug);
  if (parent) return parent;
  return slug.split('/')[0] ?? slug;
}

export function readAuthors(path: string): AuthorsFile {
  return readJson(path, authorsSchema, { version: 1, collections: {} });
}

/**
 * Production's authors with the package's missing ones appended for `roots` (BR-7): an
 * author production has is never changed, and `main` is only set on a new collection.
 */
export function mergeAuthors(
  target: AuthorsFile,
  source: AuthorsFile,
  roots: Iterable<string>,
): { readonly next: AuthorsFile; readonly added: readonly string[] } {
  const collections = { ...target.collections };
  const added: string[] = [];
  for (const root of roots) {
    const from = source.collections[root];
    if (!from) continue;
    const into = collections[root] ?? { main: from.main, authors: [] };
    const known = new Set(into.authors.map((author) => author.slug));
    const missing = from.authors.filter((author) => !known.has(author.slug));
    if (missing.length === 0 && collections[root]) continue;
    collections[root] = { ...into, authors: [...into.authors, ...missing] };
    added.push(...missing.map((author) => `${root}/${author.slug}`));
  }
  return { next: { ...target, collections }, added };
}

export function writeAuthors(
  path: string,
  authors: AuthorsFile,
): Promise<void> {
  return writeJsonFile(path, authors);
}
