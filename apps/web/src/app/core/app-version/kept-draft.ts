import { InjectionToken, Injector, inject } from '@angular/core';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { SessionStore } from '@core/auth/session-store.js';
import { z } from 'zod';

/**
 * A draft written down right before the app reloads into a new version (KBC-123), and read
 * back once by the new app. sessionStorage: it stays in this tab only, and its access can
 * throw (blocked site data), in which case the draft is simply not kept. It belongs to the
 * person who typed it and lasts a few minutes: a reload that lands on the login, with
 * someone else signing in on the same tab, or a page opened much later never shows it.
 */
export const KEPT_DRAFT_TTL_MS = 10 * 60_000;

const keptDraftSchema = z.object({
  owner: z.string(),
  text: z.string(),
  at: z.number(),
});

/** Who is signed in, as a short hash (never the e-mail itself in storage); null signed out. */
export const DRAFT_OWNER = new InjectionToken<() => string | null>(
  'DRAFT_OWNER',
  {
    providedIn: 'root',
    factory: () => {
      // Read when needed: the store is only built once the session is.
      const injector = inject(Injector);
      return () => {
        const email = injector.get(SessionStore).me()?.email;
        return email ? ownerOf(email) : null;
      };
    },
  },
);

export const ownerOf = (identity: string): string =>
  bytesToHex(sha256(utf8ToBytes(identity))).slice(0, 16);

/** Writes `text` down for `owner`; an empty text or nobody signed in removes it. */
export function keepDraft(
  view: Window | null,
  key: string,
  draft: { readonly owner: string | null; readonly text: string },
): void {
  try {
    if (draft.owner && draft.text.trim())
      view?.sessionStorage.setItem(
        key,
        JSON.stringify({
          owner: draft.owner,
          text: draft.text,
          at: Date.now(),
        }),
      );
    else view?.sessionStorage.removeItem(key);
  } catch {
    // Storage refused: the reload goes on without the draft.
  }
}

/** The draft kept for `key`, once (reading it removes it), only for its owner and while fresh. */
export function takeKeptDraft(
  view: Window | null,
  key: string,
  owner: string | null,
): string {
  try {
    const raw = view?.sessionStorage.getItem(key) ?? null;
    view?.sessionStorage.removeItem(key);
    const kept = keptDraftSchema.safeParse(JSON.parse(raw ?? 'null'));
    if (!kept.success || owner === null || kept.data.owner !== owner) return '';
    return Date.now() - kept.data.at <= KEPT_DRAFT_TTL_MS ? kept.data.text : '';
  } catch {
    return '';
  }
}
