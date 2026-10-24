import {
  aiProviderSchema,
  keyProviderSchema,
  MAX_DAILY_CAP_USD,
  modelIdSchema,
  preferencesSchema,
  type SettingsUpdate,
} from '@kb-chat/contracts';
import { z } from 'zod';

/** settings.json as written on disk (ADR 0007). Keys are kept in full here, and only here. */
export const storedSettingsSchema = z.object({
  version: z.literal(1).default(1),
  preferences: preferencesSchema.prefault({}),
  ai: z
    .object({
      provider: aiProviderSchema.nullable().default(null),
      // A hand-edited model that could not go to a CLI's argv falls back to the default.
      model: modelIdSchema.optional().catch(undefined),
      keys: z.partialRecord(keyProviderSchema, z.string().min(1)).default({}),
      dailyCapUsd: z.number().min(0).max(MAX_DAILY_CAP_USD).optional(),
    })
    .prefault({}),
});
export type StoredSettings = z.infer<typeof storedSettingsSchema>;

export const DEFAULT_SETTINGS: StoredSettings = storedSettingsSchema.parse({});

type Keys = StoredSettings['ai']['keys'];

function applyKeys(
  keys: Keys,
  patch: Readonly<Record<string, string | null | undefined>>,
): Keys {
  const merged: Record<string, string | null | undefined> = {
    ...keys,
    ...patch,
  };
  return Object.fromEntries(
    Object.entries(merged).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function applyPreferences(
  current: StoredSettings['preferences'],
  patch: NonNullable<SettingsUpdate['preferences']>,
): StoredSettings['preferences'] {
  const { defaultTopic, ...rest } = patch;
  const next = { ...current, ...rest };
  if (defaultTopic === null) delete next.defaultTopic;
  else if (defaultTopic !== undefined) next.defaultTopic = defaultTopic;
  return next;
}

function applyAi(
  current: StoredSettings['ai'],
  patch: NonNullable<SettingsUpdate['ai']>,
): StoredSettings['ai'] {
  const { model, keys, ...rest } = patch;
  const next = {
    ...current,
    ...rest,
    keys: applyKeys(current.keys, keys ?? {}),
  };
  // A model belongs to its provider: switching providers returns to the new one's default.
  const switched =
    rest.provider !== undefined && rest.provider !== current.provider;
  if (model === null || (switched && model === undefined)) delete next.model;
  else if (model !== undefined) next.model = model;
  return next;
}

/** Merges a partial update into the saved settings; the input is never mutated. */
export function applySettingsUpdate(
  current: StoredSettings,
  patch: SettingsUpdate,
): StoredSettings {
  return {
    version: 1,
    preferences: patch.preferences
      ? applyPreferences(current.preferences, patch.preferences)
      : current.preferences,
    ai: patch.ai ? applyAi(current.ai, patch.ai) : current.ai,
  };
}
