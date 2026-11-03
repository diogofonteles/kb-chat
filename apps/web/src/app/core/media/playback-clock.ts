import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  inject,
  signal,
} from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { interpolate, type ClockAnchor } from '@kb-chat/player-core';
import {
  EMPTY,
  animationFrames,
  map,
  of,
  scan,
  switchMap,
  type Observable,
} from 'rxjs';
import { MediaEngine } from './media-engine.js';

/**
 * The display's frames, as `performance.now()` times. Tests give their own; a page
 * without `requestAnimationFrame` (no layout) gets none and keeps the reported time.
 */
export const ANIMATION_FRAMES = new InjectionToken<Observable<number>>(
  'ANIMATION_FRAMES',
  {
    providedIn: 'root',
    factory: () =>
      typeof requestAnimationFrame === 'function'
        ? animationFrames().pipe(map(({ timestamp }) => timestamp))
        : EMPTY,
  },
);

interface Estimate {
  readonly anchor: ClockAnchor | null;
  readonly positionMs: number;
}

/**
 * Where playback is now, smoother than `timeupdate` (every ~250 ms): while playing, the
 * last reported time moved on at the rate on every frame (ADR 0025 §4, KBC-038 NFR-1).
 * Frames are asked for only while playing (not waiting for data) and a view on screen
 * shows the time that finely: the transcript, or the full player's subtitles with cues.
 * Otherwise (the mini-player, no transcript) it is the media element's time.
 */
@Injectable({ providedIn: 'root' })
export class PlaybackClock {
  private readonly engine = inject(MediaEngine);
  private readonly frames = inject(ANIMATION_FRAMES);
  /** What each view on screen says: does it need the time frame by frame now? */
  private readonly followers = signal<readonly (() => boolean)[]>([]);
  private readonly animating = computed(
    () =>
      this.engine.playing() &&
      !this.engine.busy() &&
      this.followers().some((needs) => needs()),
  );
  private readonly estimate = toSignal(
    toObservable(this.animating).pipe(
      switchMap((animating) => (animating ? this.framesEstimates() : of(null))),
    ),
    { initialValue: null },
  );

  readonly positionMs = computed(() => {
    const estimate = this.estimate();
    return this.animating() && estimate !== null
      ? estimate
      : this.engine.playback().currentMs;
  });

  /**
   * A view asks for frames while `needs()` (a signal read) is true, until it is destroyed:
   * the transcript always, the player only with subtitles on and cues loaded.
   */
  follow(needs: () => boolean, destroyRef: DestroyRef): void {
    this.followers.update((all) => [...all, needs]);
    destroyRef.onDestroy(() =>
      this.followers.update((all) => all.filter((one) => one !== needs)),
    );
  }

  private framesEstimates(): Observable<number> {
    const start: Estimate = { anchor: null, positionMs: 0 };
    return this.frames.pipe(
      scan(
        (last: Estimate, nowMs: number) =>
          interpolate(last.anchor, {
            reportedMs: this.engine.playback().currentMs,
            nowMs,
            rate: this.engine.speed(),
          }),
        start,
      ),
      map((estimate) => estimate.positionMs),
    );
  }
}
