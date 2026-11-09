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
  /** Where a word click left the paused audio (KBC-093 BR-17); the next "Ouvir" starts there. */
  private readonly cue = signal<number | null>(null);

  /** Where the cursor is while something plays; null otherwise. */
  readonly positionMs = this.position.asReadonly();
  readonly playing = computed(() => this.position() !== null);
  /** Which control's range plays, as named to `play`, so only that one offers to stop. */
  readonly playingKey = this.key.asReadonly();
  /** It could not play (a network error, a browser refusal): the page says so. */
  readonly failed = this.failure.asReadonly();
  readonly cuedMs = this.cue.asReadonly();

  /** The element in the page's template. */
  attach(element: HTMLMediaElement): void {
    this.element = element;
    element.addEventListener('timeupdate', this.check);
    element.addEventListener('ended', this.stop);
    element.addEventListener('pause', this.finished);
  }

  /**
   * `fromCue`: a whole track starts where a word click left the audio, when that is inside
   * it (KBC-093 AC-41).
   */
  play(
    asked: AuditionRange,
    key: string | null = null,
    options: { readonly fromCue?: boolean } = {},
  ): void {
    const { element } = this;
    if (!element) return;
    const cue = this.cue();
    this.cue.set(null);
    const range =
      options.fromCue && cue !== null && cue >= asked.fromMs && cue < asked.toMs
        ? { ...asked, fromMs: cue }
        : asked;
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

  /**
   * A word chosen in the text (KBC-093 BR-17, FR-14): the audio goes to its start and keeps
   * its state. Playing, it goes on from there (up to `untilMs` at least); a word at or after
   * that end (the whole transcript, AC-25) plays on to the recording's end. Paused, it waits
   * there for the next play.
   */
  seek(ms: number, untilMs: number): void {
    const { element, range } = this;
    if (!element) return;
    if (range && this.playing()) {
      const end = Math.max(range.toMs, untilMs);
      this.range = {
        fromMs: ms,
        toMs: ms < end ? end : Number.POSITIVE_INFINITY,
      };
      element.currentTime = ms / 1000;
      this.position.set(ms);
      return;
    }
    this.cue.set(ms);
    const move = () => {
      if (this.cue() === ms && !this.range) element.currentTime = ms / 1000;
    };
    if (element.readyState >= HTMLMediaElement.HAVE_METADATA) move();
    else element.addEventListener('loadedmetadata', move, { once: true });
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
