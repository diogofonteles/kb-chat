import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { draftTrackSchema, type DraftTrack } from '@kb-chat/contracts';
import { SessionStore } from '@core/auth/session-store.js';
import { z } from 'zod';

const keptDraftSchema = z.object({
  /** The version these changes were made over: it decides if they still fit. */
  version: z.number().int().nonnegative(),
  tracks: z.array(draftTrackSchema),
  /** Sent with no answer yet: the server moved on by these, it is not someone else (BUG-6). */
  sent: z.array(z.array(draftTrackSchema)).default([]),
});
export type KeptDraft = Readonly<z.infer<typeof keptDraftSchema>>;

/**
 * What was changed and is not on the server yet, in this browser (BR-6): it survives a
 * reload, a closed tab and leaving without a network. It holds no action, only tracks: an
 * approval or a paid run never waits here. Per person: a shared browser mixes nothing.
 */
@Injectable({ providedIn: 'root' })
export class DraftJournal {
  private readonly session = inject(SessionStore);
  private readonly storage = inject(DOCUMENT).defaultView;

  private key(mediaId: string): string {
    return `kb-chat.track-draft.${this.session.me()?.email ?? ''}.${mediaId}`;
  }

  read(mediaId: string): KeptDraft | null {
    try {
      const raw = this.storage?.localStorage.getItem(this.key(mediaId));
      if (!raw) return null;
      const kept = keptDraftSchema.safeParse(JSON.parse(raw));
      return kept.success ? kept.data : null;
    } catch {
      return null;
    }
  }

  /** False when this browser refuses to keep it: a private window, a full disk. */
  keep(
    mediaId: string,
    draft: {
      readonly version: number;
      readonly tracks: readonly DraftTrack[];
      readonly sent: readonly (readonly DraftTrack[])[];
    },
  ): boolean {
    try {
      this.storage?.localStorage.setItem(
        this.key(mediaId),
        JSON.stringify(draft),
      );
      return this.storage !== null;
    } catch {
      return false;
    }
  }

  forget(mediaId: string): void {
    try {
      this.storage?.localStorage.removeItem(this.key(mediaId));
    } catch {
      // Nothing was kept where storage is blocked.
    }
  }
}
