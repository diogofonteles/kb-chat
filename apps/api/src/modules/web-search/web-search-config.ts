import { z } from 'zod';

/** web-search.json: the house's Firecrawl key, sealed (ADR 0017). */
export const webSearchConfigSchema = z.object({
  version: z.literal(1).default(1),
  connection: z
    .object({
      /** `enc:v1:…`, never the key itself. */
      key: z.string().min(1),
      last4: z.string().length(4),
      /** Firecrawl refused it: unused until it answers again or a master pastes another. */
      keyRejected: z.boolean().default(false),
      connectedAt: z.iso.datetime(),
      connectedBy: z.string(),
    })
    .nullable()
    .default(null),
});
export type WebSearchConfig = z.infer<typeof webSearchConfigSchema>;

export const DEFAULT_WEB_SEARCH_CONFIG: WebSearchConfig =
  webSearchConfigSchema.parse({});
