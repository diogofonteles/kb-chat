import {
  DEFAULT_OPENROUTER_PLAN,
  aiProviderSchema,
  geminiTierSchema,
  lastTestSchema,
  openRouterPlanSchema,
  isAllowedModel,
  keyProviderSchema,
  MAX_DAILY_CAP_USD,
  modelIdSchema,
  modelProviderSchema,
  preferencesSchema,
  type LastTest,
  type ModelProvider,
  type ProfileModels,
  type SettingsUpdate,
} from '@kb-chat/contracts';
import { z } from 'zod';

// A hand-edited model that could not go to a CLI's argv falls back to the default.
const storedModel = modelIdSchema.optional().catch(undefined);

type Models = Partial<Record<ModelProvider, ProfileModels>>;

/** Drops the models a provider does not offer (a hand-edited subscription model). */
function allowedModels(models: Models): Models {
  return Object.fromEntries(
    Object.entries(models).map(([provider, chosen]) => {
      const id = modelProviderSchema.parse(provider);
      const keep = (model: string | undefined) =>
        model !== undefined && isAllowedModel(id, model) ? model : undefined;
      return [id, { fast: keep(chosen?.fast), deep: keep(chosen?.deep) }];
    }),
  );
}

/** The single model of a file written before KBC-011 becomes both profiles of its provider. */
function migratedModels(ai: {
  provider: z.infer<typeof aiProviderSchema> | null;
  model?: string;
  models: Models;
}): Models {
  const { provider, model, models } = ai;
  if (!model || !provider || provider === 'none' || provider === 'app')
    return models;
  if (models[provider]) return models;
  return { ...models, [provider]: { fast: model, deep: model } };
}

/**
 * The last "Testar conexão" as kept on disk: which key it was about (a fingerprint, never the
 * key), so the status shows it only while that key is the one in use (KBC-023 review R2-03).
 */
export const storedLastTestSchema = lastTestSchema.extend({
  keyId: z.string().nullable().default(null),
});
export type StoredLastTest = z.infer<typeof storedLastTestSchema>;

/** The last test without the key's fingerprint, for responses. */
export const publicLastTest = (test: StoredLastTest | null): LastTest | null =>
  test && {
    provider: test.provider,
    ok: test.ok,
    code: test.code,
    at: test.at,
  };

/** settings.json as written on disk (ADR 0007). Keys are kept in full here, and only here. */
export const storedSettingsSchema = z.object({
  version: z.literal(1).default(1),
  preferences: preferencesSchema.prefault({}),
  ai: z
    .object({
      provider: aiProviderSchema.nullable().default(null),
      /** Before KBC-011: one model for the chosen provider. Read once, never written. */
      model: storedModel,
      models: z
        .partialRecord(
          modelProviderSchema,
          z.object({ fast: storedModel, deep: storedModel }),
        )
        .catch({})
        .default({}),
      keys: z.partialRecord(keyProviderSchema, z.string().min(1)).default({}),
      dailyCapUsd: z.number().min(0).max(MAX_DAILY_CAP_USD).optional(),
      /** One's own OpenRouter plan (KBC-023); absent in older files. */
      openrouter: openRouterPlanSchema.optional().catch(undefined),
      gemini: z
        .object({ tier: geminiTierSchema })
        .catch({ tier: 'free' })
        .default({ tier: 'free' }),
      lastTest: storedLastTestSchema.nullable().catch(null).default(null),
    })
    .prefault({})
    .transform(({ model, openrouter, ...ai }) => ({
      ...ai,
      // A key saved before KBC-023 keeps the chosen models it always used.
      openrouter:
        openrouter ??
        (ai.keys.openrouter
          ? { ...DEFAULT_OPENROUTER_PLAN, mode: 'models' as const }
          : DEFAULT_OPENROUTER_PLAN),
      models: allowedModels(migratedModels({ ...ai, model })),
    })),
});
export type StoredSettings = z.infer<typeof storedSettingsSchema>;

export const DEFAULT_SETTINGS: StoredSettings = storedSettingsSchema.parse({});

type Keys = StoredSettings['ai']['keys'];
type ModelsPatch = NonNullable<NonNullable<SettingsUpdate['ai']>['models']>;

/** A profile's model: `null` returns it to the default, undefined keeps it. */
const nextModel = (
  current: string | undefined,
  patch: string | null | undefined,
): string | undefined => (patch === undefined ? current : (patch ?? undefined));

function applyModels(current: Models, patch: ModelsPatch): Models {
  const next: Models = { ...current };
  for (const [provider, chosen] of Object.entries(patch)) {
    const id = modelProviderSchema.parse(provider);
    next[id] = {
      fast: nextModel(current[id]?.fast, chosen?.fast),
      deep: nextModel(current[id]?.deep, chosen?.deep),
    };
  }
  return next;
}

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
  const { models, keys, openrouter, ...rest } = patch;
  // Each provider keeps its own models, so switching back finds them again (KBC-011).
  return {
    ...current,
    ...rest,
    openrouter: { ...current.openrouter, ...openrouter },
    models: applyModels(current.models, models ?? {}),
    keys: applyKeys(current.keys, keys ?? {}),
  };
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
