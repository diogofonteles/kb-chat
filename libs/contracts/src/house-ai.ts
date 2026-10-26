import { z } from 'zod';
import { appAiSchema, dailyResearchesSchema } from './ai-access.js';
import { maskedKeySchema, modelIdSchema } from './settings.js';

/** OpenRouter's router that picks a free model: the last free option of the chain. */
export const OPENROUTER_FREE_ROUTER = 'openrouter/free';

/** A free OpenRouter model that supports tool calling (KBC-022 FR-3). */
export const freeModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  contextLength: z.number().int().nonnegative().nullable(),
});
export type FreeModel = z.infer<typeof freeModelSchema>;

/** GET /api/v1/ai/free-models. `updatedAt` null: the list could never be loaded. */
export const freeModelListSchema = z.object({
  items: z.array(freeModelSchema),
  updatedAt: z.iso.datetime().nullable(),
  /** The last refresh failed; the items are the previous list. */
  stale: z.boolean(),
});
export type FreeModelList = z.infer<typeof freeModelListSchema>;

/** How the house account was connected. */
export const connectionViaSchema = z.enum(['oauth', 'key']);

export const houseConnectionSchema = z.object({
  key: maskedKeySchema,
  via: connectionViaSchema,
  connectedAt: z.iso.datetime(),
  connectedBy: z.string(),
});
export type HouseConnection = z.infer<typeof houseConnectionSchema>;

/** Today's free requests of the house account (OpenRouter `GET /api/v1/key`). */
export const freeUsageSchema = z.object({
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
});
export type FreeUsage = z.infer<typeof freeUsageSchema>;

/** GET /api/v1/house-ai: the app's AI as masters see it (ADR 0016). Keys never come back. */
export const houseAiViewSchema = z.object({
  connection: houseConnectionSchema.nullable(),
  /** null: the first free models of the live list (recommended). */
  freeModels: z.array(modelIdSchema).nullable(),
  includeRouter: z.boolean(),
  /** The chain the house uses now (free models, then the router). */
  chain: z.array(z.string()),
  paidModel: modelIdSchema.nullable(),
  defaultAppAi: appAiSchema,
  defaultDailyResearches: dailyResearchesSchema,
  managementKey: maskedKeySchema.nullable(),
  /** null when not connected or OpenRouter could not be read. */
  freeUsage: freeUsageSchema.nullable(),
});
export type HouseAiView = z.infer<typeof houseAiViewSchema>;

const keySchema = z.string().trim().min(8).max(400);

/** PUT /api/v1/house-ai: a partial update; a key is write-only, `null` removes it. */
export const houseAiUpdateSchema = z.strictObject({
  key: keySchema.optional(),
  freeModels: z.array(modelIdSchema).max(20).nullable().optional(),
  includeRouter: z.boolean().optional(),
  paidModel: modelIdSchema.nullable().optional(),
  defaultAppAi: appAiSchema.optional(),
  defaultDailyResearches: dailyResearchesSchema.optional(),
  managementKey: keySchema.nullable().optional(),
});
export type HouseAiUpdate = z.infer<typeof houseAiUpdateSchema>;

/** Whose account an OpenRouter connection is for: the app's (house) or, KBC-023, one's own. */
export const OPENROUTER_PURPOSES = ['house'] as const;
export const openRouterPurposeSchema = z.enum(OPENROUTER_PURPOSES);
export type OpenRouterPurpose = z.infer<typeof openRouterPurposeSchema>;

/** POST /api/v1/openrouter/connect. */
export const openRouterConnectRequestSchema = z.strictObject({
  purpose: openRouterPurposeSchema,
});
export type OpenRouterConnectRequest = z.infer<
  typeof openRouterConnectRequestSchema
>;

export const openRouterConnectResponseSchema = z.object({
  authorizeUrl: z.url(),
});
export type OpenRouterConnectResponse = z.infer<
  typeof openRouterConnectResponseSchema
>;

/** The query of the page OpenRouter sends the person back to (shown by the web). */
export const OPENROUTER_RETURN_PARAM = 'openrouter';
export const openRouterReturnSchema = z.enum(['connected', 'error']);
