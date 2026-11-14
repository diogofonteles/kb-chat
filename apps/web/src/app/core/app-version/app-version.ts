import { DOCUMENT } from '@angular/common';
import { HttpBackend, HttpClient } from '@angular/common/http';
import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Meta } from '@angular/platform-browser';
import { NavigationEnd, NavigationError, Router } from '@angular/router';
import { listenToInternalErrors } from '@core/api/api-error.js';
import { RELOAD_PAGE, SessionStore } from '@core/auth/session-store.js';
import { GO_TO_URL } from '@core/routing/go-to-url.js';
import { isPublicUrl } from '@core/routing/public-pages.js';
import { filter, finalize, fromEvent, interval, map } from 'rxjs';
import { z } from 'zod';
import { BusyWork } from './busy-work.js';

/** The meta deploy/web/version.mjs stamps into the built index.html. */
export const APP_VERSION_META = 'kb-app-version';
/** The version the server has now, written by the same script; never cached (Caddyfile). */
export const VERSION_URL = '/version.json';
/** The last automatic reload (target version and time), against a reload loop (AC-6). */
export const RELOAD_MARK_KEY = 'kb-chat.app-version-reload';

const LOOP_WINDOW_MS = 5 * 60_000;
const POLL_MS = 30 * 60_000;

/** What makes the app ask the server for its version. */
export type CheckReason = 'visible' | 'interval' | 'contract' | 'chunk';

/** The least time since the last check for each reason (a phone wakes a tab often). */
const MIN_GAP_MS: Readonly<Record<CheckReason, number>> = {
  visible: 60_000,
  contract: 10_000,
  interval: 0,
  chunk: 0,
};

const versionFileSchema = z.object({ version: z.string().min(1) });
const reloadMarkSchema = z.object({ version: z.string(), at: z.number() });
type ReloadMark = z.infer<typeof reloadMarkSchema>;

/** A lazy route's chunk that is gone (a deploy removed it), as each browser words it. */
const CHUNK_FAILURE =
  /dynamically imported module|importing a module script failed|chunkloaderror|loading chunk/i;

export const isChunkLoadError = (error: unknown): boolean =>
  error instanceof Error &&
  CHUNK_FAILURE.test(`${error.name} ${error.message}`);

/** sessionStorage access itself can throw (blocked site data). */
function sessionStorageOf(view: Window | null): Storage | null {
  try {
    return view?.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Keeps an open tab on the deployed app (KBC-123). The build stamps its version in a meta;
 * the app compares it with /version.json when the tab comes back, every 30 minutes, after a
 * reply outside the contract and after a lazy route failed to load. Another version reloads
 * the page at once when nothing is in progress; with something in progress (text typed,
 * an upload, audio playing, an answer arriving: BusyWork) it only offers "Atualizar". The
 * login and the public pages are never in progress. Without the meta (ng serve) it does
 * nothing.
 */
@Injectable({ providedIn: 'root' })
export class AppVersion {
  /** Straight to the server: no session, no auth interceptor, no app error handling. */
  private readonly http = new HttpClient(inject(HttpBackend));
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);
  private readonly reloadPage = inject(RELOAD_PAGE);
  private readonly goToUrl = inject(GO_TO_URL);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  private readonly storage = sessionStorageOf(this.document.defaultView);
  private readonly work = inject(BusyWork);
  private readonly available = signal(false);
  private started = false;
  private checking = false;
  private lastCheckAt = Number.NEGATIVE_INFINITY;
  /** The version whose notice the person closed: not offered again for it. */
  private dismissed: string | null = null;
  /** The newer version the notice offers. */
  private pending: string | null = null;
  /** The page a failed lazy route asked for: the reload goes there, not to the old page. */
  private pendingUrl: string | null = null;
  /**
   * This page already reloaded by itself once: if it is still here with another version,
   * the next answer only offers the notice. The loop guard in memory, for this page's life,
   * also when storage is blocked (AC-6).
   */
  private autoReloaded = false;
  private updating = false;

  /** This app's version; null in development, where the check is off. */
  readonly current: string | null =
    inject(Meta).getTag(`name="${APP_VERSION_META}"`)?.content || null;
  /** A newer version is deployed and something here is in progress: the banner shows. */
  readonly updateAvailable = this.available.asReadonly();

  /** Starts listening to the triggers (once; nothing in development). */
  start(): void {
    if (this.started || !this.current) return;
    this.started = true;
    fromEvent(this.document, 'visibilitychange')
      .pipe(
        filter(() => this.document.visibilityState === 'visible'),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.check('visible'));
    interval(POLL_MS)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.check('interval'));
    this.listenToChunkFailures();
    this.work.watchEdits(this.destroyRef);
    // Edits belong to the page they were made on (KBC-123 review: busy = any edited field).
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.work.forgetEdits());
    this.destroyRef.onDestroy(
      listenToInternalErrors(() => this.check('contract')),
    );
  }

  /** Asks the server which version it has, and acts on the answer. */
  check(reason: CheckReason, url?: string): void {
    const now = Date.now();
    if (!this.current) return;
    // Kept even when a check is already in flight: that one's answer goes there too.
    if (url) this.pendingUrl = url;
    if (this.checking) return;
    if (now - this.lastCheckAt < MIN_GAP_MS[reason]) return;
    this.checking = true;
    this.lastCheckAt = now;
    this.http
      .get(VERSION_URL, { cache: 'no-store' })
      .pipe(
        map((body) => versionFileSchema.parse(body).version),
        finalize(() => (this.checking = false)),
      )
      .subscribe({
        next: (served) => this.decide(served),
        // Offline, or a server without the file: nothing changes; the next trigger asks again.
        error: (err: unknown) => console.warn('version check failed', err),
      });
  }

  /** "Atualizar": the person chose to reload now (a second press does nothing more). */
  update(): void {
    if (this.updating) return;
    this.updating = true;
    this.reload();
  }

  /** "Agora não": the notice goes until another version is deployed (or the tab is free). */
  dismiss(): void {
    this.dismissed = this.pending;
    this.available.set(false);
  }

  private decide(served: string): void {
    if (served === this.current) {
      // The deploy was rolled back: nothing newer to offer any more.
      this.pending = null;
      this.available.set(false);
      return;
    }
    if (
      this.inProgress() ||
      this.autoReloaded ||
      this.reloadedRecentlyFor(served)
    ) {
      this.pending = served;
      this.available.set(served !== this.dismissed);
      return;
    }
    this.markReload(served);
    this.autoReloaded = true;
    this.reload();
  }

  /** Saves the drafts that can be kept, then loads the new app on the page asked for. */
  private reload(): void {
    this.work.saveDrafts();
    if (this.pendingUrl) this.goToUrl(this.pendingUrl);
    else this.reloadPage();
  }

  /** The login and the public pages have nothing to lose (AC-3). */
  private inProgress(): boolean {
    const inApp =
      this.session.state().kind === 'signed-in' &&
      !isPublicUrl(this.router.url);
    return inApp && this.work.inProgress();
  }

  /** This tab already reloaded for `served` a moment ago and still runs another version. */
  private reloadedRecentlyFor(served: string): boolean {
    const mark = this.storedMark();
    return (
      mark !== null &&
      mark.version === served &&
      Date.now() - mark.at < LOOP_WINDOW_MS
    );
  }

  private storedMark(): ReloadMark | null {
    try {
      const mark = reloadMarkSchema.safeParse(
        JSON.parse(this.storage?.getItem(RELOAD_MARK_KEY) ?? 'null'),
      );
      return mark.success ? mark.data : null;
    } catch {
      return null;
    }
  }

  private markReload(served: string): void {
    try {
      this.storage?.setItem(
        RELOAD_MARK_KEY,
        JSON.stringify({ version: served, at: Date.now() }),
      );
    } catch {
      // Storage refused (private mode, full): without the mark the loop guard is off.
    }
  }

  /** A lazy route whose chunk a deploy removed: load the asked page from the new app (AC-5). */
  private listenToChunkFailures(): void {
    this.router.events
      .pipe(
        filter(
          (event): event is NavigationError =>
            event instanceof NavigationError && isChunkLoadError(event.error),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((event) => this.check('chunk', event.url));
  }
}
