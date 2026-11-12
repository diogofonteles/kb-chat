import { DestroyRef, Injectable, computed, inject } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import type { HiddenSpan } from '@kb-chat/contracts';
import { MediaEngine } from './media-engine.js';
import { PlayerAnnouncer } from './player-announcer.js';

/** The timer wakes this much before a restricted part (timers are a little late). */
const LEAD_MS = 40;
/** A position this close before a restricted part counts as in it. */
const EARLY_MS = 60;

/** The restricted part `positionMs` is in (or about to enter), if any. */
export function restrictedAt(
  spans: readonly HiddenSpan[],
  positionMs: number,
): HiddenSpan | null {
  return (
    spans.find(
      (span) =>
        positionMs >= span.startMs - EARLY_MS && positionMs < span.endMs,
    ) ?? null
  );
}

/** The next restricted part that starts after `positionMs`. */
export function nextRestricted(
  spans: readonly HiddenSpan[],
  positionMs: number,
): HiddenSpan | null {
  return spans.find((span) => span.startMs > positionMs) ?? null;
}

/**
 * "Trecho restrito" (KBC-106 FR-5): a recording's parts this person may not hear (its tracks
 * above their level) are skipped, always: playing into one, or a seek landing in one, goes
 * to its end at once (NFR-1: within 250 ms). The server sends them as silence anyway; this
 * keeps the person from sitting through it. The bar and the times keep the recording's clock.
 */
@Injectable({ providedIn: 'root' })
export class RestrictedSkipper {
  private readonly engine = inject(MediaEngine);
  private readonly announcer = inject(PlayerAnnouncer);
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** The restricted parts of what is loaded now. */
  readonly spans = computed<readonly HiddenSpan[]>(
    () => this.engine.source()?.hidden ?? [],
  );

  constructor() {
    const watched = computed(() => ({
      playback: this.engine.playback(),
      spans: this.spans(),
      speed: this.engine.speed(),
    }));
    toObservable(watched)
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.check());
    inject(DestroyRef).onDestroy(() => this.clearTimer());
  }

  private check(): void {
    this.clearTimer();
    const spans = this.spans();
    const { phase, userSeeking, waiting } = this.engine.playback();
    if (spans.length === 0 || userSeeking) return;
    const now = this.engine.positionNowMs();
    const inside = restrictedAt(spans, now);
    // Paused or playing (loaded): a landing in a restricted part moves on to its end.
    if (inside && (phase === 'playing' || phase === 'paused')) {
      this.engine.skipSilence(inside.endMs);
      this.announcer.say(
        $localize`:@@player.restricted.skipped:Trecho restrito pulado.`,
      );
      return;
    }
    if (phase !== 'playing' || waiting) return;
    const next = nextRestricted(spans, now);
    if (!next) return;
    const wait = (next.startMs - now) / this.engine.speed() - LEAD_MS;
    this.timer = setTimeout(() => this.check(), Math.max(0, wait));
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
