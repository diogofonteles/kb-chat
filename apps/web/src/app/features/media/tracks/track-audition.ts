import { Injectable, computed, signal } from '@angular/core';

/** What was asked to play. */
export interface AuditionRange {
  readonly fromMs: number;
  readonly toMs: number;
}

/** "Ouvir o início": 2 s before to 3 s after; "Ouvir o fim": 3 s before to 2 s after (FR-5). */
export const startRange = (startMs: number): AuditionRange => ({
  fromMs: Math.max(0, startMs - 2_000),
  toMs: startMs + 3_000,
});
export const endRange = (endMs: number): AuditionRange => ({
  fromMs: Math.max(0, endMs - 3_000),
  toMs: endMs + 2_000,
});

/**
 * Listening to a track or a boundary while validating (KBC-066 FR-5), on the screen's own
 * audio element: the person's position and the mini-player are not this. It stops at the end
 * of the range, checked on every frame, since `timeupdate` comes only every 250 ms.
 */
@Injectable()
export class TrackAudition {
  private element: HTMLMediaElement | null = null;
  private range: AuditionRange | null = null;
  private frame: number | null = null;
  private readonly position = signal<number | null>(null);
  private readonly stopAt = signal(false);

  /** Where the cursor is while something plays; null otherwise. */
  readonly positionMs = this.position.asReadonly();
  readonly playing = computed(() => this.position() !== null);
  /** It could not play (a network error, a browser refusal): the page says so. */
  readonly failed = this.stopAt.asReadonly();

  /** The element in the page's template. */
  attach(element: HTMLMediaElement): void {
    this.element = element;
    element.addEventListener('timeupdate', this.check);
    element.addEventListener('ended', this.stop);
    element.addEventListener('pause', this.finished);
  }

  play(range: AuditionRange): void {
    const { element } = this;
    if (!element) return;
    this.stopAt.set(false);
    this.range = range;
    element.currentTime = range.fromMs / 1000;
    this.position.set(range.fromMs);
    element.play().then(this.follow, () => {
      this.stopAt.set(true);
      this.finished();
    });
  }

  readonly stop = (): void => {
    this.element?.pause();
    this.finished();
  };

  private readonly finished = (): void => {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.range = null;
    this.position.set(null);
  };

  private readonly follow = (): void => {
    if (!this.range) return;
    this.check();
    this.frame = this.range ? requestAnimationFrame(this.follow) : null;
  };

  private readonly check = (): void => {
    const { element, range } = this;
    if (!element || !range) return;
    const ms = element.currentTime * 1000;
    if (ms >= range.toMs) this.stop();
    else this.position.set(ms);
  };
}
