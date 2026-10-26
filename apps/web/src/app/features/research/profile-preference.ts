import {
  researchProfileSchema,
  type ResearchProfile,
} from '@kb-chat/contracts';

const STORAGE_KEY = 'kb-chat.research-profile';

/** This browser's research profile (KBC-011), or null while it never chose one. */
export function readProfilePreference(
  storage: Pick<Storage, 'getItem'> | undefined,
): ResearchProfile | null {
  try {
    const parsed = researchProfileSchema.safeParse(
      storage?.getItem(STORAGE_KEY),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeProfilePreference(
  storage: Pick<Storage, 'setItem'> | undefined,
  profile: ResearchProfile,
): void {
  try {
    storage?.setItem(STORAGE_KEY, profile);
  } catch {
    // Storage unavailable: the choice lasts only for this page.
  }
}
