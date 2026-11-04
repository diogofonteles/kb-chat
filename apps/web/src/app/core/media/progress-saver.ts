import { DOCUMENT } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  DestroyRef,
  Injectable,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { MediaItem, MediaProgress } from '@kb-chat/contracts';
import { SessionStore } from '@core/auth/session-store.js';
import {
  EMPTY,
  Subject,
  catchError,
  concatMap,
  finalize,
  groupBy,
  mergeMap,
  tap,
  type Observable,
} from 'rxjs';
import { ListeningApi } from './listening-api.js';
import { MediaEngine, type PlayableSource } from './media-engine.js';

/** The browser keeps the position this often while playing (FR-3). */
const KEEP_EVERY_MS = 1_000;
/** The account receives it this often while playing (FR-3, NFR-2). */
const SEND_EVERY_MS = 10_000;

/**
 * A position kept in this browser: whether the server has it, and which of the server's
 * saves it continues (`basedOn`, the server's time). Another device saving later makes it
 * stale, with no clock of this device involved.
 */
interface KeptPosition {
  readonly positionMs: number;
  readonly delivered: boolean;
  readonly basedOn: string | null;
  /** The track's cut it was read on (KBC-073 BR-3). */
  readonly fileVersion?: number;
}

function isKept(value: unknown): value is KeptPosition {
  if (typeof value !== 'object' || value === null) return false;
  const kept = value as Record<string, unknown>;
  return (
    typeof kept['positionMs'] === 'number' &&
    Number.isFinite(kept['positionMs']) &&
    kept['positionMs'] >= 0 &&
    typeof kept['delivered'] === 'boolean' &&
    (kept['basedOn'] === null || typeof kept['basedOn'] === 'string')
  );
}

/**
 * Where the person is, kept as they listen (KBC-041 FR-3): in the browser every second,
 * on the account every 10 s while playing, at once on a pause, on a change of media, after
 * a skip, when the tab is hidden and as the page goes away (a request that outlives it).
 * Saves of one media go one after the other, so the last one wins; a position the server
 * has is never sent again; one that failed is sent at the next chance, unless another
 * device saved since. Each person has their own copy in the browser (BR-2).
 */
@Injectable({ providedIn: 'root' })
export class ProgressSaver {
  private readonly engine = inject(MediaEngine);
  private readonly api = inject(ListeningApi);
  private readonly session = inject(SessionStore);
  private readonly document = inject(DOCUMENT);
  /** The server's last save time per media, as this browser knows it. */
  private readonly bases = new Map<string, string | null>();
  /** The last position the server confirmed, per media: not kept again unchanged. */
  private readonly confirmed = new Map<string, number>();
  /** Media with a position kept here and not yet confirmed: flushed as the page goes. */
  private readonly pending = new Set<string>();
  /** The position on its way to the server, per media (a save from the queue). */
  private readonly inFlight = new Map<string, number>();
  private readonly sends = new Subject<string>();
  private readonly goneId = signal<string | null>(null);
  private ticker: ReturnType<typeof setInterval> | null = null;
  private lastSentAt = 0;
  private followed: PlayableSource | null = null;
  private wasPlaying = false;

  /** A media the server no longer has for this person (removed, or access taken away). */
  readonly gone = this.goneId.asReadonly();

  constructor() {
    this.sends
      .pipe(
        groupBy((id) => id),
        mergeMap((saves) => saves.pipe(concatMap((id) => this.deliver(id)))),
        takeUntilDestroyed(),
      )
      .subscribe();
    effect(() => {
      const source = this.engine.source();
      const playing = this.engine.playing();
      untracked(() => this.follow(source, playing));
    });
    effect(() => {
      // A skip landed: keep the new position, even paused (it is where the person is).
      if (this.engine.seeksLanded() > 0) untracked(() => this.keep());
    });
    this.listenToLeaving();
  }

  /**
   * Where a media opened now starts: this browser's unsent position when no device saved
   * one since (and it is sent again), else the server's (FR-3, FR-4).
   */
  startFrom(item: MediaItem): number {
    const kept = this.read(item.id);
    if (kept && !kept.delivered && kept.basedOn === item.positionUpdatedAt) {
      this.bases.set(item.id, kept.basedOn);
      this.pending.add(item.id);
      this.sends.next(item.id);
      return kept.positionMs;
    }
    this.forget(item.id);
    this.bases.set(item.id, item.positionUpdatedAt);
    return item.positionMs;
  }

  /** Keeps and sends the position now ("Fechar o player", before the media goes). */
  saveNow(): void {
    const source = this.followed;
    if (!source) return;
    this.keep();
    this.sends.next(source.id);
  }

  private listenToLeaving(): void {
    // Hidden, the page may stay: its saves go through the queue, in order, retried.
    const hidden = () => {
      if (this.document.visibilityState === 'hidden') this.saveBeforeHiding();
    };
    // Gone: nothing runs after this, so whatever is kept leaves now.
    const leaving = () => this.sendBeforeLeaving();
    const view = this.document.defaultView;
    this.document.addEventListener('visibilitychange', hidden);
    view?.addEventListener('pagehide', leaving);
    inject(DestroyRef).onDestroy(() => {
      this.stopTicker();
      this.document.removeEventListener('visibilitychange', hidden);
      view?.removeEventListener('pagehide', leaving);
    });
  }

  private follow(source: PlayableSource | null, playing: boolean): void {
    const previous = this.followed;
    if (previous && previous.id !== source?.id) {
      // Another media (or none): the one left keeps its last position.
      this.stopTicker();
      this.wasPlaying = false;
      this.sends.next(previous.id);
    }
    this.followed = source;
    if (playing && !this.ticker) {
      this.lastSentAt = Date.now();
      this.ticker = setInterval(() => this.tick(), KEEP_EVERY_MS);
    } else if (!playing && this.ticker) {
      this.stopTicker();
    }
    if (!playing && this.wasPlaying && source) {
      this.keep();
      this.sends.next(source.id);
    }
    this.wasPlaying = playing;
  }

  private tick(): void {
    const source = this.followed;
    if (!source) return;
    this.keep();
    if (Date.now() - this.lastSentAt < SEND_EVERY_MS) return;
    this.lastSentAt = Date.now();
    this.sends.next(source.id);
  }

  /** The current position, in this browser, never past the end the server knows. */
  private keep(): void {
    const source = this.followed;
    if (!source) return;
    const { currentMs } = this.engine.playback();
    const end = source.durationMs ?? Number.POSITIVE_INFINITY;
    const positionMs = Math.floor(Math.min(currentMs, end));
    const kept = this.read(source.id);
    if (kept?.positionMs === positionMs) return;
    if (!kept && this.confirmed.get(source.id) === positionMs) return;
    this.pending.add(source.id);
    this.write(source.id, {
      positionMs,
      delivered: false,
      basedOn: this.bases.get(source.id) ?? null,
      ...(source.fileVersion === undefined
        ? {}
        : { fileVersion: source.fileVersion }),
    });
  }

  /** One save of one media, after the previous one of the same media answered. */
  private deliver(id: string): Observable<MediaProgress> {
    const kept = this.read(id);
    if (!kept || kept.delivered) return EMPTY;
    this.inFlight.set(id, kept.positionMs);
    return this.save(id, kept, { keepalive: true }).pipe(
      finalize(() => this.inFlight.delete(id)),
    );
  }

  /**
   * Sends a kept position on top of the save it continues (keepalive: a navigation or a
   * closed tab does not cancel it). A 409 says another device saved since: this copy is
   * stale and goes; a 404 says the media is gone for this person.
   */
  private save(
    id: string,
    kept: KeptPosition,
    options: { readonly keepalive: boolean },
  ): Observable<MediaProgress> {
    return this.api
      .saveProgress(
        id,
        {
          positionMs: kept.positionMs,
          basedOn: kept.basedOn,
          ...(kept.fileVersion === undefined
            ? {}
            : { fileVersion: kept.fileVersion }),
        },
        options,
      )
      .pipe(
        tap((saved) => this.confirm(id, kept.positionMs, saved)),
        catchError((err: unknown) => {
          this.refused(id, err);
          return EMPTY;
        }),
      );
  }

  private refused(id: string, err: unknown): void {
    if (!(err instanceof HttpErrorResponse)) return;
    if (err.status === 404) {
      // Gone for this person: nothing to keep or send any more.
      this.goneId.set(id);
      this.forget(id);
      this.pending.delete(id);
    }
    if (err.status === 409) {
      // Another device's save is newer: it wins; this browser's copy is dropped.
      const details: unknown = err.error?.error?.details;
      const newer =
        typeof details === 'object' && details !== null
          ? (details as { positionUpdatedAt?: unknown }).positionUpdatedAt
          : undefined;
      if (typeof newer === 'string') this.bases.set(id, newer);
      // That position lost: it is never kept again as if it were new.
      const lost = this.read(id);
      if (lost) this.confirmed.set(id, lost.positionMs);
      this.forget(id);
      this.pending.delete(id);
    }
    // Otherwise kept in the browser: the next chance sends it again.
  }

  private confirm(id: string, sentMs: number, saved: MediaProgress): void {
    this.bases.set(id, saved.positionUpdatedAt);
    this.confirmed.set(id, sentMs);
    const kept = this.read(id);
    if (!kept) return;
    // Sent and unchanged: done. Moved on meanwhile: that newer one continues this save.
    if (kept.positionMs === sentMs) {
      this.forget(id);
      this.pending.delete(id);
    } else this.write(id, { ...kept, basedOn: saved.positionUpdatedAt });
  }

  /** The tab hides (a phone locks): what moved is kept and queued, like a pause. */
  private saveBeforeHiding(): void {
    if (this.engine.playing()) this.keep();
    for (const id of this.pending) this.sends.next(id);
  }

  /**
   * The page goes: every position kept here and not yet confirmed (the one playing, one
   * just closed) leaves in a save that outlives the page, counted as delivered since
   * nothing runs afterwards to retry it.
   */
  private sendBeforeLeaving(): void {
    // Only a playing position moved since it was last kept (a pause or a skip keeps it).
    if (this.engine.playing()) this.keep();
    for (const id of [...this.pending]) {
      const kept = this.read(id);
      // Already on its way with keepalive: it outlives the page by itself.
      if (!kept || kept.delivered || this.inFlight.get(id) === kept.positionMs)
        continue;
      this.write(id, { ...kept, delivered: true });
      this.save(id, kept, { keepalive: true }).subscribe();
    }
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  private key(id: string): string {
    const person = encodeURIComponent(this.session.me()?.email ?? '');
    return `kb-chat.media-position.${person}.${id}`;
  }

  private read(id: string): KeptPosition | null {
    try {
      const raw = localStorage.getItem(this.key(id));
      const value: unknown = raw === null ? null : JSON.parse(raw);
      return isKept(value) ? value : null;
    } catch {
      return null;
    }
  }

  private write(id: string, kept: KeptPosition): void {
    try {
      localStorage.setItem(this.key(id), JSON.stringify(kept));
    } catch {
      // Private mode or a full storage: the account still gets the position.
    }
  }

  private forget(id: string): void {
    try {
      localStorage.removeItem(this.key(id));
    } catch {
      // Nothing kept: nothing to forget.
    }
  }
}
