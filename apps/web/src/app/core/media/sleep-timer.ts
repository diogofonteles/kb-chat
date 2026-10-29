import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import {
  TIMER_OFF,
  advanceTimer,
  extendTimer,
  fadeFactor,
  startTimer,
  type SleepMinutes,
  type SleepTimer,
} from '@kb-chat/player-core';
import { distinctUntilChanged, filter, map, pairwise } from 'rxjs';
import { speak } from '@core/i18n/spoken-time.js';
import { MediaEngine } from './media-engine.js';
import { PlayerAnnouncer } from './player-announcer.js';
import { ProgressSaver } from './progress-saver.js';
import { VOLUME_WRITABLE } from './volume-support.js';

/**
 * The real clock the timer counts (ms): monotonic, so a change of the system's clock does
 * not move it; tests give a controlled one.
 */
export const SLEEP_TIMER_CLOCK = new InjectionToken<() => number>(
  'SLEEP_TIMER_CLOCK',
  { providedIn: 'root', factory: () => () => performance.now() },
);

const minutesText = (minutes: number): string =>
  $localize`:@@sleep.announce.minutes:Timer para dormir: ${minutes}:minutes: minutos`;

/**
 * The sleep timer (KBC-046): counts real time while the media plays (BR-1), turns the
 * sound down over the last 10 s where the page may set the volume (FR-2), then pauses,
 * gives the sound back, saves the position and says "Pausado pelo timer". It moves on the
 * engine's own events and a timeout of its own, so a hidden tab or a locked phone (where
 * intervals slow down) still stops on time (FR-4). It lives for this session only and
 * goes with the player (BR-2).
 */
@Injectable({ providedIn: 'root' })
export class SleepTimerService {
  private readonly engine = inject(MediaEngine);
  private readonly announcer = inject(PlayerAnnouncer);
  private readonly saver = inject(ProgressSaver);
  private readonly clock = inject(SLEEP_TIMER_CLOCK);
  private readonly state = signal<SleepTimer>(TIMER_OFF);
  private readonly chosen = signal<SleepMinutes | 'end-of-media' | null>(null);
  private volumeWritable = false;
  /** The volume before the fade started, given back when it ends either way. */
  private volumeBefore: number | null = null;
  private countedAt = 0;
  private wasPlaying = false;
  private fallback: ReturnType<typeof setTimeout> | null = null;

  readonly timer = this.state.asReadonly();
  /** What the person chose for the running timer (null while off). */
  readonly choice = this.chosen.asReadonly();
  readonly remainingMs = computed(() => {
    const timer = this.state();
    return timer.kind === 'minutes' ? timer.remainingMs : null;
  });

  constructor() {
    void inject(VOLUME_WRITABLE).then(
      (writable) => (this.volumeWritable = writable),
    );
    toObservable(this.engine.playback)
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.count());
    // The player closed, or another media loaded: the timer goes (BR-2).
    toObservable(this.engine.source)
      .pipe(
        map((source) => source?.id ?? null),
        distinctUntilChanged(),
        pairwise(),
        filter(([before]) => before !== null),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.stop());
    // "No fim desta mídia": the end pauses the media; the timer has done its job.
    toObservable(computed(() => this.engine.playback().phase))
      .pipe(
        filter((phase) => phase === 'ended'),
        takeUntilDestroyed(),
      )
      .subscribe(() => {
        if (this.state().kind === 'end-of-media') this.finish(false);
      });
    inject(DestroyRef).onDestroy(() => this.clearFallback());
  }

  start(choice: SleepMinutes | 'end-of-media'): void {
    this.giveVolumeBack();
    this.state.set(startTimer(choice));
    this.chosen.set(choice);
    this.countedAt = this.clock();
    this.wasPlaying = this.engine.playing();
    this.announcer.say(
      choice === 'end-of-media'
        ? $localize`:@@sleep.announce.end:Timer para dormir: no fim desta mídia`
        : minutesText(choice),
    );
    this.scheduleFallback();
  }

  /** "Mais 5 minutos" (FR-3): the fade, if it started, is undone. */
  extend(): void {
    this.count();
    this.state.update(extendTimer);
    this.giveVolumeBack();
    this.scheduleFallback();
    const remaining = this.remainingMs();
    if (remaining !== null)
      this.announcer.say(
        $localize`:@@sleep.announce.extended:Timer para dormir: para em ${speak(Math.ceil(remaining / 1000) * 1000)}:time:`,
      );
  }

  /** "Desligar timer": the sound comes back if it was going down, and it is said. */
  off(): void {
    const wasOn = this.state().kind !== 'off';
    this.stop();
    if (wasOn)
      this.announcer.say($localize`:@@sleep.announce.off:Timer desligado`);
  }

  /** Off, with nothing said (the player closed, or the timer did its job). */
  private stop(): void {
    this.clearFallback();
    this.giveVolumeBack();
    this.state.set(TIMER_OFF);
    this.chosen.set(null);
  }

  /** Real time since the last count, counted only if the media played meanwhile. */
  private count(): void {
    const timer = this.state();
    if (timer.kind !== 'minutes') return;
    const now = this.clock();
    const next = advanceTimer(timer, now - this.countedAt, this.wasPlaying);
    this.countedAt = now;
    this.wasPlaying = this.engine.playing();
    this.state.set(next);
    if (next.kind !== 'minutes') return;
    if (next.remainingMs <= 0) {
      this.finish(true);
      return;
    }
    if (!this.wasPlaying) {
      // Paused: nothing counts, so nothing to wait for; the sound is whole again until
      // it plays (the fade picks up from where the count is).
      this.clearFallback();
      this.giveVolumeBack();
      return;
    }
    this.fade(next);
    this.scheduleFallback();
  }

  private fade(timer: SleepTimer): void {
    const factor = fadeFactor(timer);
    // Muted, there is nothing to turn down.
    if (!this.volumeWritable || factor >= 1 || this.engine.muted()) return;
    this.volumeBefore ??= this.engine.volume();
    this.engine.fadeVolume(this.volumeBefore * factor);
  }

  /** Pause, give the sound back, keep the position, and say it (FR-2). */
  private finish(pause: boolean): void {
    this.clearFallback();
    const done = $localize`:@@sleep.announce.done:Pausado pelo timer`;
    // Pausing makes the region say "Pausado": it says why instead.
    if (pause && this.engine.playing()) {
      this.announcer.sayOnNextPause(done);
      this.engine.pause();
    } else this.announcer.say(done);
    this.stop();
    this.saver.saveNow();
  }

  private giveVolumeBack(): void {
    if (this.volumeBefore === null) return;
    this.engine.fadeVolume(this.volumeBefore);
    this.volumeBefore = null;
  }

  /**
   * A count when the timer should end (or the fade start), even with no event from the
   * engine: a hidden tab slows intervals down, a single timeout still runs (NFR-1).
   */
  private scheduleFallback(): void {
    this.clearFallback();
    const remaining = this.remainingMs();
    if (remaining === null) return;
    const untilFade = remaining - 10_000;
    const wait = untilFade > 0 ? untilFade : Math.min(remaining, 1_000);
    this.fallback = setTimeout(() => this.count(), wait);
  }

  private clearFallback(): void {
    if (this.fallback) clearTimeout(this.fallback);
    this.fallback = null;
  }
}
