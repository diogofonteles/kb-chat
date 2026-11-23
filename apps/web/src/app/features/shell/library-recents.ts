import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject, linkedSignal } from '@angular/core';
import { personStorageKey } from '@core/auth/person-key.js';
import { SessionStore } from '@core/auth/session-store.js';
import { z } from 'zod';

const STORAGE_PREFIX = 'kb-chat.library-recents';
/** The documents "Sua biblioteca" lists under "Documentos": the last ones opened. */
const MAX_DOCUMENTS = 20;

const recentDocumentSchema = z.object({
  topic: z.string(),
  id: z.string(),
  title: z.string(),
  at: z.number(),
});
export type RecentDocument = z.infer<typeof recentDocumentSchema>;

const recentsSchema = z.object({
  /** When each collection was last chosen (epoch ms), by slug. */
  collections: z.record(z.string(), z.number()).default({}),
  documents: z.array(recentDocumentSchema).default([]),
});
type Recents = z.infer<typeof recentsSchema>;

const EMPTY: Recents = { collections: {}, documents: [] };

/**
 * The "Recentes" order of "Sua biblioteca" (KBC-125 FR-5): when each collection was last
 * chosen and the documents last opened, kept in this browser only (a per-viewer
 * convenience; conversations carry their own date from the server). Each account has its
 * own list, so the next person in the same browser never sees another one's titles; with no
 * one signed in nothing is read or kept on disk.
 */
@Injectable({ providedIn: 'root' })
export class LibraryRecents {
  private readonly storage = storageOf(inject(DOCUMENT).defaultView);
  private readonly session = inject(SessionStore);
  private readonly key = computed(() => {
    const email = this.session.me()?.email;
    return email ? personStorageKey(STORAGE_PREFIX, email) : null;
  });
  private readonly state = linkedSignal(() => this.read(this.key()));
  readonly collections = () => this.state().collections;
  readonly documents = () => this.state().documents;

  constructor() {
    // The list of one browser before it was kept per account: whose it was is unknown.
    try {
      this.storage?.removeItem(STORAGE_PREFIX);
    } catch {
      // Storage unavailable: there is nothing to remove.
    }
  }

  noteCollection(slug: string, at = Date.now()): void {
    this.save({
      ...this.state(),
      collections: { ...this.state().collections, [slug]: at },
    });
  }

  noteDocument(doc: Omit<RecentDocument, 'at'>, at = Date.now()): void {
    const others = this.state().documents.filter(
      (d) => d.topic !== doc.topic || d.id !== doc.id,
    );
    this.save({
      ...this.state(),
      documents: [{ ...doc, at }, ...others].slice(0, MAX_DOCUMENTS),
    });
  }

  private save(next: Recents): void {
    this.state.set(next);
    const key = this.key();
    if (!key) return;
    try {
      this.storage?.setItem(key, JSON.stringify(next));
    } catch {
      // Storage unavailable: the order lasts for this page only.
    }
  }

  private read(key: string | null): Recents {
    if (!key) return EMPTY;
    try {
      const raw = this.storage?.getItem(key);
      const parsed = recentsSchema.safeParse(raw ? JSON.parse(raw) : {});
      return parsed.success ? parsed.data : EMPTY;
    } catch {
      return EMPTY;
    }
  }
}

function storageOf(view: Window | null): Storage | undefined {
  try {
    return view?.localStorage;
  } catch {
    return undefined;
  }
}
