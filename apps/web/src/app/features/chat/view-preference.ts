/** The two views of the page (KBC-008): the free search engine and the research agent. */
export type ChatView = 'search' | 'research';

const STORAGE_KEY = 'kb-chat.view';
const VIEWS: readonly ChatView[] = ['search', 'research'];

/** The view remembered in this browser; storage may be blocked (private mode), so it never throws. */
export function readViewPreference(
  storage: Pick<Storage, 'getItem'> | undefined,
): ChatView | null {
  try {
    const stored = storage?.getItem(STORAGE_KEY);
    return VIEWS.find((view) => view === stored) ?? null;
  } catch {
    return null;
  }
}

/** Remembers the view; Settings write it too when the default view is saved (KBC-007). */
export function writeViewPreference(
  storage: Pick<Storage, 'setItem'> | undefined,
  view: ChatView,
): void {
  try {
    storage?.setItem(STORAGE_KEY, view);
  } catch {
    // Storage unavailable: the choice lasts only for this page.
  }
}
