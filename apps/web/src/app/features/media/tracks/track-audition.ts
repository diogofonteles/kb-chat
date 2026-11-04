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
  private readonly key = signal<string | null>(null);
  private readonly failure = signal(false);

  /** Where the cursor is while something plays; null otherwise. */
  readonly positionMs = this.position.asReadonly();
  readonly playing = computed(() => this.position() !== null);
  /** Which control's range plays, as named to `play`, so only that one offers to stop. */
  readonly playingKey = this.key.asReadonly();
  /** It could not play (a network error, a browser refusal): the page says so. */
  readonly failed = this.failure.asReadonly();

  /** The element in the page's template. */
  attach(element: HTMLMediaElement): void {
    this.element = element;
    element.addEventListener('timeupdate', this.check);
    element.addEventListener('ended', this.stop);
    element.addEventListener('pause', this.finished);
  }

  play(range: AuditionRange, key: string | null = null): void {
    const { element } = this;
    if (!element) return;
    this.failure.set(false);
    this.range = range;
    this.key.set(key);
    this.seekTo(element, range);
    this.position.set(range.fromMs);
    element.play().then(this.follow, () => {
      this.failure.set(true);
      this.finished();
    });
  }

  /** Before the metadata there is nothing to seek in, as in the player's own engine. */
  private seekTo(element: HTMLMediaElement, range: AuditionRange): void {
    const seek = () => {
      if (this.range === range) element.currentTime = range.fromMs / 1000;
    };
    if (element.readyState >= HTMLMediaElement.HAVE_METADATA) seek();
    else element.addEventListener('loadedmetadata', seek, { once: true });
  }

  readonly stop = (): void => {
    this.element?.pause();
    this.finished();
  };

  private readonly finished = (): void => {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.range = null;
    this.key.set(null);
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
