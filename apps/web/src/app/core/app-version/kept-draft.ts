/**
 * A draft written down right before the app reloads into a new version (KBC-123), and read
 * back once by the new app. sessionStorage: it stays in this tab only, and its access can
 * throw (blocked site data), in which case the draft is simply not kept.
 */
export function keepDraft(
  view: Window | null,
  key: string,
  text: string,
): void {
  try {
    if (text.trim()) view?.sessionStorage.setItem(key, text);
    else view?.sessionStorage.removeItem(key);
  } catch {
    // Storage refused: the reload goes on without the draft.
  }
}

/** The draft kept for `key`, once: reading it removes it. */
export function takeKeptDraft(view: Window | null, key: string): string {
  try {
    const text = view?.sessionStorage.getItem(key) ?? '';
    view?.sessionStorage.removeItem(key);
    return text;
  } catch {
    return '';
  }
}
