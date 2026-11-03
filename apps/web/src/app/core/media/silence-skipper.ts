import {
  DestroyRef,
  Injectable,
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
  skipsOf,
  type SilenceSkip,
} from '@kb-chat/player-core';
import { catchError, distinctUntilChanged, map, of, switchMap } from 'rxjs';
import { ListeningPreferences } from './listening-preferences.js';
import { MediaEngine } from './media-engine.js';
import { PlayerAnnouncer } from './player-announcer.js';
import { SilencesApi } from './silences-api.js';

/** The timer wakes this much before a pause's skip point (timers are a little late). */
const LEAD_MS = 15;
/** A check this close before the skip point counts as reaching it. */
const EARLY_MS = 30;

/** The map of the loaded media as read: absent (none loaded), failed, or the answer. */
type LoadedMap =
  | { readonly mediaId: string; readonly silences: MediaSilences }
  | { readonly mediaId: string; readonly silences: 'failed' }
  | null;

/** Where the map of the loaded media is, for "Encurtar silêncios" (KBC-044). */
export type SilenceMapState =
  'loading' | 'pending' | 'none' | 'ready' | 'unavailable';

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
    return loaded && loaded.silences !== 'failed'
      ? skipsOf(loaded.silences.intervals)
      : [];
  });
  readonly mapState = computed<SilenceMapState>(() => {
    const loaded = this.current();
    if (!loaded) return 'loading';
    if (loaded.silences === 'failed') return 'unavailable';
    if (loaded.silences.status === 'pending') return 'pending';
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

  private read(mediaId: string) {
    return this.api.silences(mediaId).pipe(
      map((silences): LoadedMap => ({ mediaId, silences })),
      catchError(() => of<LoadedMap>({ mediaId, silences: 'failed' })),
    );
  }

  /** Skips the armed pause if playing reached it, otherwise arms the next one ahead. */
  private check(): void {
    this.clearTimer();
    const mediaId = this.mediaId();
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

  private arm(mediaId: string, now: number): void {
    const skips = this.skips();
    const index = nextSkipIndex(skips, now);
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
