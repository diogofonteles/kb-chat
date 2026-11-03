import { Injectable, InjectionToken, computed, inject } from '@angular/core';
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
 * Frames are asked for only while playing; paused, it is the media element's time.
 */
@Injectable({ providedIn: 'root' })
export class PlaybackClock {
  private readonly engine = inject(MediaEngine);
  private readonly frames = inject(ANIMATION_FRAMES);
  private readonly estimate = toSignal(
    toObservable(this.engine.playing).pipe(
      switchMap((playing) => (playing ? this.framesEstimates() : of(null))),
    ),
    { initialValue: null },
  );

  readonly positionMs = computed(() => {
    const estimate = this.estimate();
    return this.engine.playing() && estimate !== null
      ? estimate
      : this.engine.playback().currentMs;
  });

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
