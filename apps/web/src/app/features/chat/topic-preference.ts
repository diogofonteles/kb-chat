import { topicSlugSchema } from '@kb-chat/contracts';
import { personStorageKey } from '@core/auth/person-key.js';

const STORAGE_PREFIX = 'kb-chat.topic';

/** The storage key of a person's collection in use (KBC-157 BR-1); none without a person. */
export function topicPreferenceKey(
  email: string | null | undefined,
): string | null {
  return email ? personStorageKey(STORAGE_PREFIX, email) : null;
}

/**
 * The collection the person last chose in this browser (KBC-157 FR-2); storage may be
 * blocked (private mode), so it never throws (BR-4).
 */
export function readTopicPreference(
  storage: Pick<Storage, 'getItem'> | undefined,
  key: string | null,
): string | null {
  if (!key) return null;
  try {
    const parsed = topicSlugSchema.safeParse(storage?.getItem(key));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeTopicPreference(
  storage: Pick<Storage, 'setItem'> | undefined,
  key: string | null,
  slug: string,
): void {
  if (!key) return;
  try {
    storage?.setItem(key, slug);
  } catch {
    // Storage unavailable: the choice lasts only for this page.
  }
}
