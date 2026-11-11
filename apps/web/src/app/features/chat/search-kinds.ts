import {
  SEARCH_KINDS,
  searchKindSchema,
  type SearchKind,
} from '@kb-chat/contracts';
const STORAGE_KEY = 'kb-chat.search-kinds';
const storedSchema = searchKindSchema.array().min(1);

/** Every kind: the default reach of a search (KBC-039 BR-4). */
export const ALL_KINDS: readonly SearchKind[] = SEARCH_KINDS;

/** The remembered "Buscar em" choice; storage may be blocked or hold junk, so it never throws. */
export function readKindsPreference(
  storage: Pick<Storage, 'getItem'> | undefined,
): readonly SearchKind[] {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const parsed = storedSchema.safeParse(raw ? JSON.parse(raw) : null);
    return parsed.success ? orderKinds(parsed.data) : ALL_KINDS;
  } catch {
    return ALL_KINDS;
  }
}

export function writeKindsPreference(
  storage: Pick<Storage, 'setItem'> | undefined,
  kinds: readonly SearchKind[],
): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(kinds));
  } catch {
    // Storage unavailable: the choice lasts only for this page.
  }
}

/** The kinds in the control's order, without repeats. */
export const orderKinds = (kinds: readonly SearchKind[]): SearchKind[] =>
  SEARCH_KINDS.filter((kind) => kinds.includes(kind));

/** Turns one kind on or off; the last one chosen stays on (BR-4). */
export function toggleKind(
  kinds: readonly SearchKind[],
  kind: SearchKind,
): SearchKind[] {
  if (!kinds.includes(kind)) return orderKinds([...kinds, kind]);
  const rest = kinds.filter((one) => one !== kind);
  return rest.length > 0 ? rest : [...kinds];
}
