import { z } from 'zod';
import { documentFacetsSchema } from './facets.js';

export const documentSchema = documentFacetsSchema.extend({
  id: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  body: z.string(),
});
export type KbDocument = z.infer<typeof documentSchema>;
