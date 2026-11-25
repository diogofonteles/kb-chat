import { z } from 'zod';
import { topicSlugSchema } from './topics.js';
import { uploadedDocumentRefSchema } from './document-uploads.js';

/* ---------- A document out of its collection, and back (KBC-187) ---------- */

/**
 * Where a removal is: hidden in the app at once (`removing`) and then moved by the Mac to kb's
 * quarantine (`removed`); asked back (`restoring`) until the Mac moved it back, when it ends.
 * `failed`: the Mac could not do what was asked; the app keeps hiding what it hid.
 */
export const DOCUMENT_REMOVAL_STATES = [
  'removing',
  'removed',
  'restoring',
  'failed',
] as const;
export const documentRemovalStateSchema = z.enum(DOCUMENT_REMOVAL_STATES);
export type DocumentRemovalState = z.infer<typeof documentRemovalStateSchema>;

export const documentRemovalSchema = z.object({
  id: z.uuid(),
  topic: topicSlugSchema,
  document: uploadedDocumentRefSchema,
  state: documentRemovalStateSchema,
  /** The Mac's words, when it failed. */
  detail: z.string().nullable(),
  /** Who removed it. */
  by: z.string(),
  removedAt: z.iso.datetime(),
});
export type DocumentRemoval = z.infer<typeof documentRemovalSchema>;

export const documentRemovalListSchema = z.object({
  items: z.array(documentRemovalSchema),
});
export type DocumentRemovalList = z.infer<typeof documentRemovalListSchema>;
