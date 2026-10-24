import { searchModeSchema, type SearchMode } from '@kb-chat/contracts';

const STORAGE_KEY = 'kb-chat.search-mode';

/** Reads the remembered search mode; storage may be blocked (private mode), so it never throws. */
export function readModePreference(
  storage: Pick<Storage, 'getItem'> | undefined,
): SearchMode {
  try {
    const parsed = searchModeSchema.safeParse(storage?.getItem(STORAGE_KEY));
    return parsed.success ? parsed.data : 'all';
  } catch {
    return 'all';
  }
}

export function writeModePreference(
  storage: Pick<Storage, 'setItem'> | undefined,
  mode: SearchMode,
): void {
  try {
    storage?.setItem(STORAGE_KEY, mode);
  } catch {
    // Storage unavailable: the choice lasts only for this page.
  }
}
