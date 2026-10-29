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
  map,
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

/** What went wrong with a bookmark, for the alert with "Tentar de novo" (NFR-1). */
export interface BookmarkFailure {
  readonly id: string;
  readonly kind: 'save' | 'delete';
}

type Write =
  | { readonly kind: 'create'; readonly bookmark: MediaBookmark }
  | { readonly kind: 'note'; readonly mediaId: string; readonly id: string };

/**
 * The person's bookmarks in the media that is loaded (KBC-042): shown at once when made
 * (NFR-1), sent one after the other so a note never arrives before its bookmark, and kept
 * on screen when the server fails, with "Tentar de novo". A deleted bookmark can come back
 * for 8 s ("Desfazer", FR-4): the deletion is sent only then, or as the media changes or
 * the page goes.
 */
@Injectable({ providedIn: 'root' })
export class BookmarksStore {
  private readonly api = inject(BookmarksApi);
  private readonly engine = inject(MediaEngine);
  private readonly announcer = inject(PlayerAnnouncer);
  private readonly newId = inject(BOOKMARK_ID);
  private readonly list = signal<readonly MediaBookmark[]>([]);
  private readonly unsavedIds = signal<ReadonlySet<string>>(new Set());
  private readonly failure = signal<BookmarkFailure | null>(null);
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
  readonly unsaved = this.unsavedIds.asReadonly();
  readonly failed = this.failure.asReadonly();
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
    this.setUnsaved(bookmark.id, true);
    this.editingId.set(bookmark.id);
    this.announcer.say(
      $localize`:@@bookmarks.marked:Marcador em ${formatClock(bookmark.positionMs)}:time:`,
    );
    this.writes.next({ kind: 'create', bookmark });
  }

  /** The note as typed (trimmed; blank clears it), shown at once and then sent. */
  saveNote(id: string, text: string): void {
    const found = this.list().find((b) => b.id === id);
    if (!found) return;
    const note = cleanNote(text);
    this.editingId.set(null);
    if (note === found.note) return;
    this.replace({ ...found, note });
    this.writes.next({ kind: 'note', mediaId: found.mediaId, id });
  }

  editNote(id: string | null): void {
    this.editingId.set(id);
  }

  /** "Tentar de novo": the bookmark and its note are sent again (idempotent). */
  retry(): void {
    const failure = this.failure();
    if (!failure) return;
    this.failure.set(null);
    const bookmark = this.list().find((b) => b.id === failure.id);
    if (!bookmark) return;
    if (failure.kind === 'delete') {
      // Deleted again, now: the person already chose it once.
      this.commitDelete(false);
      this.list.update((list) => list.filter((b) => b.id !== bookmark.id));
      this.deletedOne.set(bookmark);
      this.commitDelete(false);
      return;
    }
    this.writes.next({ kind: 'create', bookmark });
    if (bookmark.note !== null)
      this.writes.next({
        kind: 'note',
        mediaId: bookmark.mediaId,
        id: bookmark.id,
      });
  }

  dismissFailure(): void {
    this.failure.set(null);
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

  private load(mediaId: string): Observable<unknown> {
    return this.api.list(mediaId).pipe(
      tap((list) => {
        this.list.set(list);
        this.loadedFor.set(mediaId);
      }),
      catchError(() => {
        // Listed or not, marking still works: the new ones show and are sent.
        this.loadedFor.set(mediaId);
        return EMPTY;
      }),
    );
  }

  /** The media changes (or closes): a pending deletion goes now, the rest starts over. */
  private leave(): void {
    this.commitDelete(false);
    this.list.set([]);
    this.unsavedIds.set(new Set());
    this.failure.set(null);
    this.editingId.set(null);
    this.loadedFor.set(null);
  }

  private send(write: Write): Observable<unknown> {
    const request =
      write.kind === 'create'
        ? this.api.create(write.bookmark.mediaId, {
            id: write.bookmark.id,
            positionMs: write.bookmark.positionMs,
          })
        : this.noteRequest(write.mediaId, write.id);
    const id = write.kind === 'create' ? write.bookmark.id : write.id;
    return request.pipe(
      tap(() => {
        if (write.kind === 'create') this.setUnsaved(id, false);
      }),
      catchError(() => {
        this.failure.set({ id, kind: 'save' });
        // The note stays where the person typed it (NFR-1).
        if (this.list().some((b) => b.id === id)) this.editingId.set(id);
        return EMPTY;
      }),
    );
  }

  /** The note as it is now on screen (a later edit wins over an earlier one). */
  private noteRequest(mediaId: string, id: string): Observable<unknown> {
    const current = this.list().find((b) => b.id === id);
    return current
      ? this.api.updateNote(mediaId, id, current.note).pipe(map(() => null))
      : of(null);
  }

  private commitDelete(keepalive: boolean): void {
    const bookmark = this.deletedOne();
    if (!bookmark) return;
    this.clearUndo();
    this.deletedOne.set(null);
    this.setUnsaved(bookmark.id, false);
    this.api.remove(bookmark.mediaId, bookmark.id, { keepalive }).subscribe({
      error: (err: unknown) => {
        // Already gone on the server (never saved, or deleted elsewhere): done.
        if (err instanceof HttpErrorResponse && err.status === 404) return;
        if (keepalive || this.loadedFor() !== bookmark.mediaId) return;
        this.list.update((list) => [...list, bookmark]);
        this.failure.set({ id: bookmark.id, kind: 'delete' });
      },
    });
  }

  private clearUndo(): void {
    if (this.undoTimer) clearTimeout(this.undoTimer);
    this.undoTimer = null;
  }

  private replace(bookmark: MediaBookmark): void {
    this.list.update((list) =>
      list.map((b) => (b.id === bookmark.id ? bookmark : b)),
    );
  }

  private setUnsaved(id: string, unsaved: boolean): void {
    this.unsavedIds.update((ids) => {
      const next = new Set(ids);
      if (unsaved) next.add(id);
      else next.delete(id);
      return next;
    });
  }
}
