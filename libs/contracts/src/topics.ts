import { z } from 'zod';

export const topicSlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/, {
    error: 'invalid topic slug',
  });

export const topicSchema = z.object({
  slug: topicSlugSchema,
  title: z.string(),
  documentCount: z.number().int().nonnegative(),
});
export type Topic = z.infer<typeof topicSchema>;

export const topicListSchema = z.object({
  items: z.array(topicSchema),
  /** Topic configured to open by default (KB_TOPIC), or null. */
  defaultSlug: topicSlugSchema.nullable(),
});
export type TopicList = z.infer<typeof topicListSchema>;
