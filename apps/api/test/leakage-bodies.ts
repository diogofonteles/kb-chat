/**
 * Bodies for the writes the leakage suite probes (KBC-111 review IMP-3), built from each
 * route's own zod schema: valid enough for the handler to run, with every id field naming a
 * hidden item (or, in the twin variant, an unknown one), so the answer to a hidden id can be
 * compared with the answer to an id that does not exist.
 */
import { z } from 'zod';

/** What fills the id-like fields of one body. */
export interface BodyIds {
  /** Any uuid field: a recording, a track, a bookmark, a transcriber… */
  readonly uuid: string;
  /** A field naming a document (`id`, `ids`, `document`, `documents`, `cited`…). */
  readonly document: string;
}

type Json = Record<string, unknown>;

const DOCUMENT_KEY = /^(documents?|ids?|docIds?|cited|citedIds|after)$/i;
const NOW = '2026-11-12T12:00:00.000Z';

const firstOption = (options: readonly Json[]): Json =>
  options.find((one) => one['type'] !== 'null') ?? options[0] ?? {};

function sampleString(schema: Json, key: string, ids: BodyIds): string {
  if (Array.isArray(schema['enum'])) return String(schema['enum'][0]);
  if (schema['format'] === 'uuid') return ids.uuid;
  if (schema['format'] === 'date-time') return NOW;
  if (schema['format'] === 'email') return 'bia@example.com';
  if (schema['format'] === 'uri' || schema['format'] === 'url')
    return 'https://example.com/';
  if (DOCUMENT_KEY.test(key)) return ids.document;
  const min = Number(schema['minLength'] ?? 0);
  return 'lua'.padEnd(Math.max(3, min), 'a');
}

function sampleNumber(schema: Json): number {
  if (typeof schema['minimum'] === 'number') return schema['minimum'];
  if (typeof schema['exclusiveMinimum'] === 'number')
    return schema['exclusiveMinimum'] + 1;
  return schema['type'] === 'integer' ? 1 : 1;
}

/** One value for a JSON schema node; `key` is the property it fills. */
function sample(schema: Json, key: string, ids: BodyIds): unknown {
  if ('const' in schema) return schema['const'];
  if ('default' in schema) return schema['default'];
  const union = (schema['anyOf'] ?? schema['oneOf']) as Json[] | undefined;
  if (union) return sample(firstOption(union), key, ids);
  const allOf = schema['allOf'] as Json[] | undefined;
  if (allOf?.[0]) return sample(allOf[0], key, ids);
  const byType: Record<string, () => unknown> = {
    object: () => sampleObject(schema, ids),
    array: () => [sample((schema['items'] as Json) ?? {}, key, ids)],
    string: () => sampleString(schema, key, ids),
    number: () => sampleNumber(schema),
    integer: () => sampleNumber(schema),
    boolean: () => false,
    null: () => null,
  };
  const type = Array.isArray(schema['type'])
    ? (schema['type'].find((one) => one !== 'null') as string)
    : (schema['type'] as string | undefined);
  return byType[type ?? 'string']?.() ?? 'lua';
}

function sampleObject(schema: Json, ids: BodyIds): Json {
  const properties = (schema['properties'] ?? {}) as Record<string, Json>;
  const required = new Set((schema['required'] ?? []) as string[]);
  return Object.fromEntries(
    Object.entries(properties)
      // Every required field, and the optional ones that may name an item.
      .filter(([key]) => required.has(key) || DOCUMENT_KEY.test(key))
      .map(([key, inner]) => [key, sample(inner, key, ids)]),
  );
}

/** A body the route's schema accepts, or `{}` when it has none or cannot be drawn. */
export function bodyFor(schema: unknown, ids: BodyIds): object {
  if (!(schema instanceof z.ZodType)) return {};
  try {
    const json = z.toJSONSchema(schema, {
      io: 'input',
      unrepresentable: 'any',
    }) as Json;
    const body = sample(json, '', ids);
    return body && typeof body === 'object' ? body : {};
  } catch {
    // A schema with transforms the converter refuses: the empty body still probes the route.
    return {};
  }
}
