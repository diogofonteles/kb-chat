import { DOCUMENT } from '@angular/common';
import { HttpBackend, HttpClient } from '@angular/common/http';
import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
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

/** Which notice the banner shows (see AppVersion.notice). */
export type UpdateNotice = 'save-first' | 'plain';

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
  private readonly shownNotice = signal<UpdateNotice | null>(null);
  private started = false;
  private checking = false;
  private lastCheckAt = Number.NEGATIVE_INFINITY;
  /** The version whose notice the person closed: not offered again for it. */
  private dismissed: string | null = null;
  /** The newer version the notice offers. */
  private pending: string | null = null;
  /**
   * The page a failed lazy route asked for: the reload goes there, not to the old page.
   * Forgotten once the server has this same version, on a failed check and on any page the
   * router reaches after it.
   */
  private pendingUrl: string | null = null;
  /**
   * This page already asked for a reload by itself and is still here (the browser did not
   * leave it): the next answer only offers the notice. It lives in memory, so it does not
   * survive a reload; the guard across reloads is the sessionStorage mark, and with storage
   * blocked that one is off (AC-6). No check runs at boot and coming back to the tab waits
   * 60 s between checks, so even then the reloads are never back to back.
   */
  private autoReloaded = false;
  private updating = false;

  /** This app's version; null in development, where the check is off. */
  readonly current: string | null =
    inject(Meta).getTag(`name="${APP_VERSION_META}"`)?.content || null;
  /**
   * The notice of a newer version, or null: "save-first" when something here is in
   * progress (KBC-123 review R2-3: the reload would lose it), "plain" when the page only
   * held back to avoid a reload loop.
   */
  readonly notice = this.shownNotice.asReadonly();
  /** A newer version is deployed and this page did not reload into it: the banner shows. */
  readonly updateAvailable = computed(() => this.shownNotice() !== null);

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
      .subscribe(() => {
        this.work.forgetEdits();
        this.pendingUrl = null;
      });
    this.destroyRef.onDestroy(
      listenToInternalErrors(() => this.check('contract')),
    );
  }

  /** Asks the server which version it has, and acts on the answer. */
  check(reason: CheckReason, url?: string): void {
    const now = Date.now();
    if (!this.current) return;
    if (this.checking) {
      // The check in flight answers for this failed route too.
      if (url) this.pendingUrl = url;
      return;
    }
    if (now - this.lastCheckAt < MIN_GAP_MS[reason]) return;
    if (url) this.pendingUrl = url;
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
        // Offline, or a server without the file: nothing changes; the next trigger asks
        // again, and a failed route was the network's, not a deploy's.
        error: (err: unknown) => {
          this.pendingUrl = null;
          console.warn('version check failed', err);
        },
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
    this.shownNotice.set(null);
  }

  private decide(served: string): void {
    if (served === this.current) {
      // Nothing newer (or the deploy was rolled back): no notice, and a failed route was
      // not this app's being old.
      this.pending = null;
      this.pendingUrl = null;
      this.shownNotice.set(null);
      return;
    }
    const busy = this.inProgress();
    if (busy || this.autoReloaded || this.reloadedRecentlyFor(served)) {
      this.pending = served;
      this.shownNotice.set(
        served === this.dismissed ? null : busy ? 'save-first' : 'plain',
      );
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
      // Storage refused (private mode, full): only `autoReloaded` guards, for this page.
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
