import {
  DEFAULT_DAILY_RESEARCHES,
  defaultableAppAiSchema,
  connectionViaSchema,
  dailyResearchesSchema,
  modelIdSchema,
} from '@kb-chat/contracts';
import { z } from 'zod';

/** A key kept sealed (ADR 0017): `value` is `enc:v1:…`, never the key itself. */
const sealedSchema = z.string().min(1);

const connectionSchema = z.object({
  key: sealedSchema,
  last4: z.string().max(4),
  via: connectionViaSchema,
  connectedAt: z.iso.datetime(),
  connectedBy: z.string(),
});

/** A person's own OpenRouter key with a monthly limit, made with the management key. */
const personKeySchema = z.object({
  hash: z.string().min(1),
  key: sealedSchema,
  limitUsd: z.number().nonnegative(),
});
export type StoredPersonKey = z.infer<typeof personKeySchema>;

/** house-ai.json (KBC-022, ADR 0016). */
export const houseConfigSchema = z.object({
  version: z.literal(1).default(1),
  connection: connectionSchema.nullable().default(null),
  freeModels: z.array(modelIdSchema).nullable().default(null),
  includeRouter: z.boolean().default(true),
  paidModel: modelIdSchema.nullable().default(null),
  // A subscription is never a default (ADR 0019): a hand-edited one reads as no AI.
  defaultAppAi: defaultableAppAiSchema.default('house').catch('none'),
  /** Who last changed the default, and when (the audit trail of KBC-022). */
  defaultChange: z
    .object({ by: z.string(), at: z.iso.datetime() })
    .nullable()
    .default(null),
  defaultDailyResearches: dailyResearchesSchema.default(
    DEFAULT_DAILY_RESEARCHES,
  ),
  managementKey: z
    .object({ key: sealedSchema, last4: z.string().max(4) })
    .nullable()
    .default(null),
  /** By person id: the keys provisioned with the management key. */
  personKeys: z.record(z.string(), personKeySchema).default({}),
});
export type HouseConfig = z.infer<typeof houseConfigSchema>;

export const DEFAULT_HOUSE_CONFIG: HouseConfig = houseConfigSchema.parse({});
