import { z } from 'zod';
import { researchProfileSchema } from './research.js';
import { searchModeSchema } from './search.js';
import { topicSlugSchema } from './topics.js';

/** How the AI answers (KBC-007, ADR 0007); `none` means search only. */
export const AI_PROVIDERS = [
  'openrouter',
  'anthropic',
  'openai',
  'claude-subscription',
  'chatgpt-subscription',
  'none',
] as const;
export const aiProviderSchema = z.enum(AI_PROVIDERS);
export type AiProvider = z.infer<typeof aiProviderSchema>;

/** Providers paid per token, each with its own API key. */
export const KEY_PROVIDERS = ['openrouter', 'anthropic', 'openai'] as const;
export const keyProviderSchema = z.enum(KEY_PROVIDERS);
export type KeyProvider = z.infer<typeof keyProviderSchema>;

/** Providers that answer with a model (every one but `none`). */
export const MODEL_PROVIDERS = [
  'openrouter',
  'anthropic',
  'openai',
  'claude-subscription',
  'chatgpt-subscription',
] as const;
export const modelProviderSchema = z.enum(MODEL_PROVIDERS);
export type ModelProvider = z.infer<typeof modelProviderSchema>;

/**
 * The only models a subscription CLI accepts from Settings (KBC-011): its aliases and full
 * ids. Per-token providers take any id that passes modelIdSchema (free text).
 */
export const MODEL_ALLOWLISTS: Partial<
  Record<ModelProvider, readonly string[]>
> = {
  'claude-subscription': [
    'sonnet',
    'opus',
    'haiku',
    'fable',
    'claude-sonnet-5-5',
    'claude-opus-5-5',
    'claude-haiku-5-5',
    'claude-fable-5-1',
  ],
  'chatgpt-subscription': ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'],
};

/** True when the provider takes this model: in its allowlist, or any id when it has none. */
export function isAllowedModel(
  provider: ModelProvider,
  model: string,
): boolean {
  const allowed = MODEL_ALLOWLISTS[provider];
  return allowed === undefined || allowed.includes(model);
}

export const THEMES = ['auto', 'light', 'dark', 'esoteric'] as const;
export const themeSchema = z.enum(THEMES);
export type Theme = z.infer<typeof themeSchema>;

export const DEFAULT_VIEWS = ['research', 'search'] as const;
export const defaultViewSchema = z.enum(DEFAULT_VIEWS);
export type DefaultView = z.infer<typeof defaultViewSchema>;

/** The daily cap accepted from Settings, in US$ (per-token providers only, BR-2). */
export const MAX_DAILY_CAP_USD = 100;

export const preferencesSchema = z.object({
  defaultTopic: topicSlugSchema.optional(),
  searchMode: searchModeSchema.default('all'),
  theme: themeSchema.default('auto'),
  defaultView: defaultViewSchema.default('research'),
  /** The research composer's profile until this browser picks one (KBC-011). */
  researchProfile: researchProfileSchema.default('fast'),
  /** A fast answer that the collection could not settle goes on with the deep profile. */
  autoDeepen: z.boolean().default(true),
});
export type Preferences = z.infer<typeof preferencesSchema>;

/** A saved key as the API shows it: never the key, only its last 4 characters (BR-1). */
export const maskedKeySchema = z.object({
  set: z.literal(true),
  last4: z.string().max(4),
});
export type MaskedKey = z.infer<typeof maskedKeySchema>;

/**
 * A model id or CLI alias ("opus", "deepseek/deepseek-v4-pro", "gpt-5.5"). It reaches a
 * CLI's argv, so it never starts with "-" and has no spaces or shell characters.
 */
export const modelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/, { error: 'Invalid model id' });

/** The models of one provider per research profile; a missing one is the provider's default. */
export const profileModelsSchema = z.object({
  fast: modelIdSchema.optional(),
  deep: modelIdSchema.optional(),
});
export type ProfileModels = z.infer<typeof profileModelsSchema>;

/** GET /api/v1/settings. `exists: false` until settings.json is first written (BR-5). */
export const settingsViewSchema = z.object({
  exists: z.boolean(),
  preferences: preferencesSchema,
  ai: z.object({
    /** null: not chosen, the server's environment decides (BR-4). */
    provider: aiProviderSchema.nullable(),
    /** The fast and deep model chosen for each provider (KBC-011). */
    models: z.partialRecord(modelProviderSchema, profileModelsSchema),
    keys: z.partialRecord(keyProviderSchema, maskedKeySchema),
    dailyCapUsd: z.number().nonnegative(),
  }),
});
export type SettingsView = z.infer<typeof settingsViewSchema>;

const apiKeySchema = z.string().trim().min(8).max(400);

const modelUpdateSchema = modelIdSchema.nullable().optional();

/** A model id the provider refuses (a subscription CLI outside its allowlist) is a 400. */
const modelsUpdateSchema = z
  .partialRecord(
    modelProviderSchema,
    z.strictObject({ fast: modelUpdateSchema, deep: modelUpdateSchema }),
  )
  .superRefine((models, context) => {
    const refused = Object.entries(models).flatMap(([provider, chosen]) =>
      Object.entries(chosen ?? {})
        .filter(
          ([, model]) =>
            typeof model === 'string' &&
            !isAllowedModel(modelProviderSchema.parse(provider), model),
        )
        .map(([profile]) => [provider, profile]),
    );
    for (const path of refused)
      context.addIssue({
        code: 'custom',
        path,
        message: `Model not offered by ${path[0]}`,
      });
  });

/**
 * PUT /api/v1/settings: a partial update. A key is write-only; `null` removes it, and a
 * model set to `null` returns that profile to the provider's default.
 */
export const settingsUpdateSchema = z.strictObject({
  preferences: z
    .strictObject({
      defaultTopic: topicSlugSchema.nullable().optional(),
      searchMode: searchModeSchema.optional(),
      theme: themeSchema.optional(),
      defaultView: defaultViewSchema.optional(),
      researchProfile: researchProfileSchema.optional(),
      autoDeepen: z.boolean().optional(),
    })
    .optional(),
  ai: z
    .strictObject({
      provider: aiProviderSchema.nullable().optional(),
      models: modelsUpdateSchema.optional(),
      keys: z
        .partialRecord(keyProviderSchema, apiKeySchema.nullable())
        .optional(),
      dailyCapUsd: z.number().min(0).max(MAX_DAILY_CAP_USD).optional(),
    })
    .optional(),
});
export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

export const providerBillingSchema = z.enum([
  'per-token',
  'subscription',
  'none',
]);
export type ProviderBilling = z.infer<typeof providerBillingSchema>;

/** Why a provider cannot answer yet; the web shows the matching instruction (BR-3). */
export const providerUnavailableReasonSchema = z.enum([
  'key-missing',
  'cli-missing',
  /** Off on this server until the owner enables it (Codex, ADR 0007). */
  'not-enabled',
]);
export type ProviderUnavailableReason = z.infer<
  typeof providerUnavailableReasonSchema
>;

export const providerInfoSchema = z.object({
  id: aiProviderSchema,
  billing: providerBillingSchema,
  available: z.boolean(),
  reason: providerUnavailableReasonSchema.nullable(),
  /** Where the key comes from: Settings, the server's environment (BR-4) or nowhere. */
  keySource: z.enum(['settings', 'env']).nullable(),
  /** Models used when none is chosen, per profile; null lets the CLI pick its own. */
  defaultModels: z.object({
    fast: z.string().nullable(),
    deep: z.string().nullable(),
  }),
  /** Suggested models; when `freeModel`, any other id may be typed. */
  models: z.array(z.string()),
  /** False for a subscription CLI: only `models` are accepted. */
  freeModel: z.boolean(),
});
export type ProviderInfo = z.infer<typeof providerInfoSchema>;

/**
 * GET /api/v1/ai/providers. `active` is the provider answering now (Settings or the
 * environment); "stub" is the deterministic model of tests and E2E (KB_CHAT_LLM=stub).
 */
export const providerListSchema = z.object({
  items: z.array(providerInfoSchema),
  active: z.union([aiProviderSchema, z.literal('stub')]),
});
export type ProviderList = z.infer<typeof providerListSchema>;

/** POST /api/v1/settings/ai/test: tries a provider, with a typed key or the saved one. */
export const aiTestRequestSchema = z
  .strictObject({
    provider: modelProviderSchema,
    key: apiKeySchema.optional(),
    model: modelIdSchema.optional(),
  })
  .refine(
    (request) =>
      request.model === undefined ||
      isAllowedModel(request.provider, request.model),
    { path: ['model'], error: 'Model not offered by this provider' },
  );
export type AiTestRequest = z.infer<typeof aiTestRequestSchema>;

/** Why a connection test failed; each maps to one pt-BR message in the web. */
export const AI_TEST_CODES = [
  'LLM_KEY_REJECTED',
  'LLM_NOT_CONFIGURED',
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'CLI_MISSING',
  'CLI_LOGIN_REQUIRED',
] as const;
export const aiTestCodeSchema = z.enum(AI_TEST_CODES);
export type AiTestCode = z.infer<typeof aiTestCodeSchema>;

/** The outcome of a connection test is data, not an API error: "failed" is a valid answer. */
export const aiTestResultSchema = z.object({
  ok: z.boolean(),
  code: aiTestCodeSchema.nullable(),
  model: z.string(),
  latencyMs: z.number().int().nonnegative(),
});
export type AiTestResult = z.infer<typeof aiTestResultSchema>;
