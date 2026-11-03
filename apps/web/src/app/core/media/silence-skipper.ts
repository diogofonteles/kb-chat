import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  takeUntilDestroyed,
  toObservable,
  toSignal,
} from '@angular/core/rxjs-interop';
import type { MediaSilences } from '@kb-chat/contracts';
import {
  delayUntil,
  nextSkipIndex,
  reachedSkip,
  skipAfterLanding,
  skipsOf,
  type SilenceSkip,
} from '@kb-chat/player-core';
import {
  EMPTY,
  catchError,
  distinctUntilChanged,
  expand,
  map,
  of,
  switchMap,
  timer,
  type Observable,
} from 'rxjs';
import { ListeningPreferences } from './listening-preferences.js';
import { MediaEngine } from './media-engine.js';
import { PlayerAnnouncer } from './player-announcer.js';
import { SilencesApi } from './silences-api.js';

/** The timer wakes this much before a pause's skip point (timers are a little late). */
const LEAD_MS = 15;
/** A check this close before the skip point counts as reaching it. */
const EARLY_MS = 30;

/** The map of the loaded media as read: absent (none loaded), unreadable, or the answer. */
type LoadedMap =
  | { readonly mediaId: string; readonly silences: MediaSilences }
  | { readonly mediaId: string; readonly silences: 'unreadable' }
  | null;

/**
 * Where the map of the loaded media is, for "Encurtar silêncios" (KBC-044): read, being
 * measured, given up by the worker, without long pauses, ready, or not readable now.
 */
export type SilenceMapState =
  'loading' | 'pending' | 'failed' | 'none' | 'ready' | 'unavailable';

/** A map still being measured is read again this often while its media is loaded. */
export const SILENCES_REREAD_MS = new InjectionToken<number>(
  'SILENCES_REREAD_MS',
  { providedIn: 'root', factory: () => 60_000 },
);

/** The skip the player waits for: which one, of which media, since which person's seek. */
interface Armed {
  readonly index: number;
  readonly mediaId: string;
  readonly seeks: number;
}

/**
 * "Encurtar silêncios" (KBC-044, ADR 0025 §3): with the option on, while the media plays,
 * the player jumps from 0.15 s into each pause of 1 s or more to 0.15 s before its end
 * (BR-1), once per pause, and adds what it jumped to the time saved in this media. It arms
 * only pauses still ahead, so a jump of the person that lands in a pause is respected and
 * the next pause is shortened again (BR-3). Off, it does nothing (BR-2). The bar, the
 * times, the saved position and the bookmarks stay on the original timeline (FR-5): a skip
 * is only a seek of the engine.
 */
@Injectable({ providedIn: 'root' })
export class SilenceSkipper {
  private readonly engine = inject(MediaEngine);
  private readonly preferences = inject(ListeningPreferences);
  private readonly announcer = inject(PlayerAnnouncer);
  private readonly api = inject(SilencesApi);
  private readonly rereadMs = inject(SILENCES_REREAD_MS);
  private readonly mediaId = computed(() => this.engine.source()?.id ?? null);
  private readonly loaded = toSignal(
    toObservable(this.mediaId).pipe(
      distinctUntilChanged(),
      switchMap((id) => (id === null ? of(null) : this.read(id))),
    ),
    { initialValue: null },
  );
  private readonly saved = signal<{ mediaId: string | null; ms: number }>({
    mediaId: null,
    ms: 0,
  });
  private armed: Armed | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  readonly enabled = computed(() => this.preferences.value().skipSilences);
  /** The skips of the loaded media's map, in order. */
  readonly skips = computed<readonly SilenceSkip[]>(() => {
    const loaded = this.current();
    return loaded && loaded.silences !== 'unreadable'
      ? skipsOf(loaded.silences.intervals)
      : [];
  });
  readonly mapState = computed<SilenceMapState>(() => {
    const loaded = this.current();
    if (!loaded) return 'loading';
    if (loaded.silences === 'unreadable') return 'unavailable';
    if (loaded.silences.status !== 'ready') return loaded.silences.status;
    return this.skips().length === 0 ? 'none' : 'ready';
  });
  /** Time jumped over in the loaded media during this session (FR-4). */
  readonly savedMs = computed(() => {
    const saved = this.saved();
    return saved.mediaId === this.mediaId() ? saved.ms : 0;
  });

  constructor() {
    const watched = computed(() => ({
      playback: this.engine.playback(),
      enabled: this.enabled(),
      skips: this.skips(),
      speed: this.engine.speed(),
    }));
    toObservable(watched)
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.check());
    inject(DestroyRef).onDestroy(() => this.clearTimer());
  }

  /** Turns the option on or off, kept on the account, and says so. */
  setEnabled(on: boolean): void {
    this.preferences.setSkipSilences(on);
    this.announcer.say(
      on
        ? $localize`:@@silences.announce.on:Encurtar silêncios ligado`
        : $localize`:@@silences.announce.off:Encurtar silêncios desligado`,
    );
  }

  /** The map read for the media loaded now (a late answer for another one is ignored). */
  private current(): LoadedMap {
    const loaded = this.loaded();
    return loaded && loaded.mediaId === this.mediaId() ? loaded : null;
  }

  /** Reads the map, and again every while it is still being measured. */
  private read(mediaId: string): Observable<LoadedMap> {
    const once = () =>
      this.api.silences(mediaId).pipe(
        map((silences): LoadedMap => ({ mediaId, silences })),
        catchError(() => of<LoadedMap>({ mediaId, silences: 'unreadable' })),
      );
    return once().pipe(
      expand((loaded) =>
        loaded?.silences !== 'unreadable' &&
        loaded?.silences.status === 'pending'
          ? timer(this.rereadMs).pipe(switchMap(once))
          : EMPTY,
      ),
    );
  }

  /** Skips the armed pause if playing reached it, otherwise arms the next one ahead. */
  private check(): void {
    this.clearTimer();
    const mediaId = this.mediaId();
    // Stalled: the clock stands still, so no timer is armed until data comes back (the
    // armed pause stays armed: playing on reaches it).
    if (this.engine.playback().waiting) return;
    // A seek in flight (the person's or a skip) lands first; then the next one is armed.
    if (!this.canSkip() || mediaId === null) {
      this.armed = null;
      return;
    }
    const now = this.engine.positionNowMs();
    const skip = this.armedSkip(mediaId);
    if (skip && reachedSkip(skip, now, EARLY_MS)) {
      this.jump(mediaId, skip, now);
      return;
    }
    this.arm(mediaId, now);
  }

  private canSkip(): boolean {
    const { phase, userSeeking } = this.engine.playback();
    return this.enabled() && phase === 'playing' && !userSeeking;
  }

  /** The armed skip, unless the person jumped since it was armed (BR-3). */
  private armedSkip(mediaId: string): SilenceSkip | null {
    const armed = this.armed;
    if (
      !armed ||
      armed.mediaId !== mediaId ||
      armed.seeks !== this.engine.seeksLanded()
    )
      return null;
    return this.skips()[armed.index] ?? null;
  }

  /**
   * Arms the next pause ahead. Playing on keeps the one armed; after a landing (the
   * person's jump, opening, starting to play) a pause the position is already in, even in
   * its first 0.15 s, is heard in full (BR-3).
   */
  private arm(mediaId: string, now: number): void {
    const skips = this.skips();
    const armed = this.armedSkip(mediaId);
    const index =
      armed && this.armed && armed.toMs > now
        ? this.armed.index
        : armed
          ? nextSkipIndex(skips, now)
          : skipAfterLanding(skips, now);
    const skip = skips[index];
    if (index < 0 || !skip) {
      this.armed = null;
      return;
    }
    this.armed = { index, mediaId, seeks: this.engine.seeksLanded() };
    const wait = delayUntil(skip, now, this.engine.speed()) - LEAD_MS;
    this.timer = setTimeout(() => this.check(), Math.max(0, wait));
  }

  private jump(mediaId: string, skip: SilenceSkip, now: number): void {
    this.armed = null;
    const jumped = Math.max(0, skip.toMs - now);
    this.saved.update((saved) => ({
      mediaId,
      ms: (saved.mediaId === mediaId ? saved.ms : 0) + jumped,
    }));
    this.engine.skipSilence(skip.toMs);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
