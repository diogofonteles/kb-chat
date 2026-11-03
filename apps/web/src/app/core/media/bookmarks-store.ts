import { DOCUMENT } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import type { MediaBookmark } from '@kb-chat/contracts';
import {
  bookmarkPosition,
  cleanNote,
  formatClock,
  sortBookmarks,
} from '@kb-chat/player-core';
import {
  EMPTY,
  Subject,
  catchError,
  concatMap,
  distinctUntilChanged,
  of,
  switchMap,
  tap,
  type Observable,
} from 'rxjs';
import { BookmarksApi } from './bookmarks-api.js';
import { MediaEngine } from './media-engine.js';
import { PlayerAnnouncer } from './player-announcer.js';

/** How long "Desfazer" stays after a bookmark is deleted (FR-4). */
export const UNDO_MS = 8_000;

/** A new bookmark's id, made here so the mark shows at once with its final id. */
export const BOOKMARK_ID = new InjectionToken<() => string>('BOOKMARK_ID', {
  providedIn: 'root',
  factory: () => () => crypto.randomUUID(),
});

/**
 * What went wrong in the media on screen (NFR-1): bookmarks not saved (with "Tentar de
 * novo"), a deletion that did not go, or the cap of bookmarks reached (nothing to retry).
 */
export type BookmarkFailure =
  | { readonly kind: 'save'; readonly count: number }
  | { readonly kind: 'delete' }
  | { readonly kind: 'limit' };

/** A bookmark the server does not fully have yet: itself, or its latest note. */
interface Outgoing {
  readonly bookmark: MediaBookmark;
  readonly created: boolean;
  readonly noteToSend: boolean;
  readonly failed: boolean;
}

type Write =
  | { readonly kind: 'create'; readonly id: string }
  | { readonly kind: 'note'; readonly id: string }
  | { readonly kind: 'delete'; readonly bookmark: MediaBookmark };

const isLimit = (err: unknown): boolean =>
  err instanceof HttpErrorResponse &&
  err.status === 409 &&
  (err.error as { error?: { code?: unknown } } | null)?.error?.code ===
    'BOOKMARK_LIMIT';

/**
 * The person's bookmarks in the media that is loaded (KBC-042): shown at once when made
 * (NFR-1). Every write (create, note, delete) goes through one queue, in order, so a note
 * never arrives before its bookmark and a deletion never before its creation. What the
 * server does not have yet stays in an outbox for the whole session, per bookmark: leaving
 * the media and coming back shows it again, with "Tentar de novo" when it failed. A deleted
 * bookmark can come back for 8 s ("Desfazer", FR-4): the deletion is queued only then, or
 * as the media changes, or sent at once as the page goes.
 */
@Injectable({ providedIn: 'root' })
export class BookmarksStore {
  private readonly api = inject(BookmarksApi);
  private readonly engine = inject(MediaEngine);
  private readonly announcer = inject(PlayerAnnouncer);
  private readonly newId = inject(BOOKMARK_ID);
  private readonly list = signal<readonly MediaBookmark[]>([]);
  private readonly outbox = signal<ReadonlyMap<string, Outgoing>>(new Map());
  private readonly deleteFailedId = signal<string | null>(null);
  private readonly limitReached = signal(false);
  private readonly editingId = signal<string | null>(null);
  private readonly deletedOne = signal<MediaBookmark | null>(null);
  private readonly loadedFor = signal<string | null>(null);
  private readonly writes = new Subject<Write>();
  private undoTimer: ReturnType<typeof setTimeout> | null = null;

  /** By position (FR-3). */
  readonly bookmarks = computed(() => sortBookmarks(this.list()));
  /** Where the marks go on the time slider (FR-3). */
  readonly positions = computed(() =>
    this.bookmarks().map((b) => b.positionMs),
  );
  /** The media whose bookmarks are listed (null while they load). */
  readonly mediaId = this.loadedFor.asReadonly();
  /** Bookmarks the server does not have yet ("salvando…"). */
  readonly unsaved = computed(
    () =>
      new Set(
        [...this.outbox().values()]
          .filter((out) => !out.created)
          .map((out) => out.bookmark.id),
      ),
  );
  readonly failed = computed<BookmarkFailure | null>(() => {
    if (this.limitReached()) return { kind: 'limit' };
    if (this.deleteFailedId() !== null) return { kind: 'delete' };
    const count = this.failedHere().length;
    return count > 0 ? { kind: 'save', count } : null;
  });
  /** The bookmark whose note is open under the player (FR-2). */
  readonly editing = this.editingId.asReadonly();
  /** The bookmark "Desfazer" would bring back. */
  readonly deleted = this.deletedOne.asReadonly();

  constructor() {
    this.writes
      .pipe(
        concatMap((write) => this.send(write)),
        takeUntilDestroyed(),
      )
      .subscribe();
    toObservable(computed(() => this.engine.source()?.id ?? null))
      .pipe(
        distinctUntilChanged(),
        tap(() => this.leave()),
        switchMap((id) => (id ? this.load(id) : of(null))),
        takeUntilDestroyed(),
      )
      .subscribe();
    const view = inject(DOCUMENT).defaultView;
    const leaving = () => this.commitDelete(true);
    view?.addEventListener('pagehide', leaving);
    inject(DestroyRef).onDestroy(() => {
      view?.removeEventListener('pagehide', leaving);
      this.commitDelete(true);
    });
  }

  /**
   * "Marcar este trecho" (FR-2): a bookmark 2 s before now (BR-2), without pausing, and
   * its note opens. Nothing while no media is loaded.
   */
  mark(): void {
    const mediaId = this.loadedFor();
    if (!mediaId) return;
    const now = new Date().toISOString();
    const bookmark: MediaBookmark = {
      id: this.newId(),
      mediaId,
      positionMs: bookmarkPosition(this.engine.playback().currentMs),
      note: null,
      createdAt: now,
      updatedAt: now,
    };
    this.list.update((list) => [...list, bookmark]);
    this.track(bookmark, { created: false, noteToSend: false, failed: false });
    this.editingId.set(bookmark.id);
    this.announcer.say(
      $localize`:@@bookmarks.marked:Marcador em ${formatClock(bookmark.positionMs)}:time:`,
    );
    this.writes.next({ kind: 'create', id: bookmark.id });
  }

  /** The note as typed (trimmed; blank clears it), shown at once and then sent. */
  saveNote(id: string, text: string): void {
    const found = this.list().find((b) => b.id === id);
    if (!found) return;
    const note = cleanNote(text);
    this.editingId.set(null);
    if (note === found.note) return;
    const bookmark = { ...found, note };
    this.list.update((list) => list.map((b) => (b.id === id ? bookmark : b)));
    const out = this.outbox().get(id);
    this.track(bookmark, {
      created: out?.created ?? true,
      noteToSend: true,
      failed: false,
    });
    this.writes.next({ kind: 'note', id });
  }

  editNote(id: string | null): void {
    this.editingId.set(id);
  }

  /** "Tentar de novo": every bookmark of this media that did not go is sent again. */
  retry(): void {
    if (this.deleteFailedId() !== null) {
      this.retryDelete();
      return;
    }
    for (const out of this.failedHere()) {
      this.track(out.bookmark, { ...out, failed: false });
      if (!out.created)
        this.writes.next({ kind: 'create', id: out.bookmark.id });
      if (out.noteToSend)
        this.writes.next({ kind: 'note', id: out.bookmark.id });
    }
  }

  /** "Fechar" on the alert: the cap notice or a failed deletion goes away. */
  dismissFailure(): void {
    this.limitReached.set(false);
    this.deleteFailedId.set(null);
  }

  /** Deletes at once on screen; "Desfazer" can bring it back for 8 s (FR-4). */
  remove(id: string): void {
    const bookmark = this.list().find((b) => b.id === id);
    if (!bookmark) return;
    this.commitDelete(false);
    this.list.update((list) => list.filter((b) => b.id !== id));
    if (this.editingId() === id) this.editingId.set(null);
    this.deletedOne.set(bookmark);
    this.announcer.say($localize`:@@bookmarks.deleted:Marcador apagado`);
    this.undoTimer = setTimeout(() => this.commitDelete(false), UNDO_MS);
  }

  /** "Desfazer": the same bookmark, with its note, comes back. */
  undo(): void {
    const bookmark = this.deletedOne();
    if (!bookmark) return;
    this.clearUndo();
    this.deletedOne.set(null);
    this.list.update((list) => [...list, bookmark]);
    this.announcer.say($localize`:@@bookmarks.restored:Marcador de volta`);
  }

  /** The server's list, with what this session still has to send for this media. */
  private load(mediaId: string): Observable<unknown> {
    const shown = (saved: readonly MediaBookmark[]) => {
      const local = [...this.outbox().values()]
        .filter((out) => out.bookmark.mediaId === mediaId)
        .map((out) => out.bookmark);
      const ids = new Set(local.map((b) => b.id));
      this.list.set([...saved.filter((b) => !ids.has(b.id)), ...local]);
      this.loadedFor.set(mediaId);
    };
    return this.api.list(mediaId).pipe(
      tap(shown),
      // Listed or not, marking still works: the new ones show and are sent.
      catchError(() => {
        shown([]);
        return EMPTY;
      }),
    );
  }

  /** The media changes (or closes): a pending deletion is queued, the screen starts over. */
  private leave(): void {
    this.commitDelete(false);
    this.list.set([]);
    this.deleteFailedId.set(null);
    this.limitReached.set(false);
    this.editingId.set(null);
    this.loadedFor.set(null);
  }

  private send(write: Write): Observable<unknown> {
    if (write.kind === 'delete') return this.sendDelete(write.bookmark, false);
    const out = this.outbox().get(write.id);
    // Deleted meanwhile, or already done: nothing to send.
    if (!out || (write.kind === 'note' && !out.noteToSend)) return EMPTY;
    const { bookmark } = out;
    const request =
      write.kind === 'create'
        ? this.api.create(bookmark.mediaId, {
            id: bookmark.id,
            positionMs: bookmark.positionMs,
          })
        : this.api.updateNote(bookmark.mediaId, bookmark.id, bookmark.note);
    return request.pipe(
      tap(() => this.delivered(write.kind, bookmark.id)),
      catchError((err: unknown) => {
        this.notDelivered(bookmark, err);
        return EMPTY;
      }),
    );
  }

  private delivered(kind: 'create' | 'note', id: string): void {
    const out = this.outbox().get(id);
    if (!out) return;
    const next = {
      ...out,
      created: out.created || kind === 'create',
      // A newer note may have come while this one was on its way: it is queued too.
      noteToSend: kind === 'note' ? false : out.noteToSend,
    };
    if (next.created && !next.noteToSend) this.untrack(id);
    else this.track(out.bookmark, next);
  }

  private notDelivered(bookmark: MediaBookmark, err: unknown): void {
    if (isLimit(err)) {
      // Over the cap: this one cannot be kept; trying again would fail the same way.
      this.untrack(bookmark.id);
      this.list.update((list) => list.filter((b) => b.id !== bookmark.id));
      if (this.editingId() === bookmark.id) this.editingId.set(null);
      if (this.loadedFor() === bookmark.mediaId) this.limitReached.set(true);
      return;
    }
    const out = this.outbox().get(bookmark.id);
    if (out) this.track(out.bookmark, { ...out, failed: true });
    // The note stays where the person typed it (NFR-1).
    if (this.list().some((b) => b.id === bookmark.id))
      this.editingId.set(bookmark.id);
  }

  private commitDelete(keepalive: boolean): void {
    const bookmark = this.deletedOne();
    if (!bookmark) return;
    this.clearUndo();
    this.deletedOne.set(null);
    this.untrack(bookmark.id);
    // Always asked of the server: a creation whose answer was lost may be there (a 404 is
    // done). As the page goes, the deletion cannot wait for a creation still on its way;
    // that one stays, the rare price of a page closed within a second of marking.
    if (keepalive) this.sendDelete(bookmark, true).subscribe();
    else this.writes.next({ kind: 'delete', bookmark });
  }

  private sendDelete(
    bookmark: MediaBookmark,
    keepalive: boolean,
  ): Observable<unknown> {
    return this.api.remove(bookmark.mediaId, bookmark.id, { keepalive }).pipe(
      catchError((err: unknown) => {
        // Already gone on the server (deleted elsewhere): done.
        const gone = err instanceof HttpErrorResponse && err.status === 404;
        if (!gone && !keepalive && this.loadedFor() === bookmark.mediaId) {
          this.list.update((list) => [...list, bookmark]);
          this.deleteFailedId.set(bookmark.id);
        }
        return EMPTY;
      }),
    );
  }

  /** Deleted again, now: the person already chose it once. */
  private retryDelete(): void {
    const id = this.deleteFailedId();
    this.deleteFailedId.set(null);
    const bookmark = this.list().find((b) => b.id === id);
    if (!bookmark) return;
    this.commitDelete(false);
    this.list.update((list) => list.filter((b) => b.id !== bookmark.id));
    this.writes.next({ kind: 'delete', bookmark });
  }

  /** The bookmarks of the media on screen that failed to go. */
  private failedHere(): Outgoing[] {
    const mediaId = this.loadedFor();
    return [...this.outbox().values()].filter(
      (out) => out.failed && out.bookmark.mediaId === mediaId,
    );
  }

  private clearUndo(): void {
    if (this.undoTimer) clearTimeout(this.undoTimer);
    this.undoTimer = null;
  }

  private track(
    bookmark: MediaBookmark,
    state: Omit<Outgoing, 'bookmark'>,
  ): void {
    this.outbox.update((map) =>
      new Map(map).set(bookmark.id, { bookmark, ...state }),
    );
  }

  private untrack(id: string): void {
    this.outbox.update((map) => {
      if (!map.has(id)) return map;
      const next = new Map(map);
      next.delete(id);
      return next;
    });
  }
}
