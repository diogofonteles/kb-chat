import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  applySliderMove,
  formatClock,
  fractionOf,
  positionAtFraction,
  positionToSecond,
  roundToSecond,
  sliderMoveOf,
} from '@kb-chat/player-core';
import { speak } from '@core/i18n/spoken-time.js';
import { PlayerAnnouncer } from '@core/media/player-announcer.js';

/** Seeks while dragging at most this often (a request per pixel would flood the network). */
const DRAG_SEEK_MS = 100;

/**
 * The time slider (screens.md T15, APG "Media Seek Slider"): focus on the thumb, arrows
 * 5 s (Shift 10 s), PageUp/PageDown 60 s, Home/End; a click on the track seeks without
 * dragging (WCAG 2.5.7); the time is spoken in words, the total only on focus.
 */
@Component({
  selector: 'app-seek-slider',
  templateUrl: './seek-slider.html',
  styleUrl: './seek-slider.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SeekSlider {
  readonly currentMs = input.required<number>();
  readonly durationMs = input.required<number | null>();
  readonly bufferedEndMs = input(0);
  readonly disabled = input(false);
  /** A position to go to (a click, a drag, Home/End). */
  readonly seekRequested = output<number>();
  /**
   * A step from wherever the media is now (arrows, PageUp/PageDown): the engine adds it to
   * its live position, so held-down or fast keys never start from a stale value.
   */
  readonly stepRequested = output<number>();

  private readonly track = viewChild.required<ElementRef<HTMLElement>>('track');
  private readonly thumb = viewChild.required<ElementRef<HTMLElement>>('thumb');
  /** The position under the pointer while dragging; null otherwise. */
  private readonly dragMs = signal<number | null>(null);
  private readonly hoverMs = signal<number | null>(null);
  protected readonly focused = signal(false);
  private readonly announcer = inject(PlayerAnnouncer);
  private lastDragSeek = 0;

  private readonly shownMs = computed(() => this.dragMs() ?? this.currentMs());
  protected readonly loaded = computed(() => (this.durationMs() ?? 0) > 0);
  protected readonly playedPercent = computed(
    () => fractionOf(this.shownMs(), this.durationMs()) * 100,
  );
  protected readonly bufferedPercent = computed(
    () => fractionOf(this.bufferedEndMs(), this.durationMs()) * 100,
  );
  /** The position the slider speaks: the end reads as the whole length. */
  private readonly shownSecondMs = computed(() =>
    positionToSecond(this.shownMs(), this.durationMs()),
  );
  protected readonly valueNow = computed(() => this.shownSecondMs() / 1000);
  protected readonly valueMax = computed(
    () => roundToSecond(this.durationMs() ?? 0) / 1000,
  );
  protected readonly valueText = computed(() => {
    if (!this.loaded())
      return $localize`:@@player.notLoaded:áudio ainda não carregado`;
    const now = speak(this.shownSecondMs());
    return this.focused()
      ? $localize`:@@player.positionOf:${now}:now: de ${speak(roundToSecond(this.durationMs() ?? 0))}:total:`
      : now;
  });
  /** The time label next to the thumb (drag) or under the pointer (hover). */
  protected readonly tip = computed(() => {
    const ms = this.dragMs() ?? this.hoverMs();
    if (ms === null || !this.loaded()) return null;
    return {
      text: formatClock(ms),
      percent: fractionOf(ms, this.durationMs()) * 100,
    };
  });

  protected onKeydown(event: KeyboardEvent): void {
    const move = sliderMoveOf(event.key, event.shiftKey);
    const duration = this.durationMs();
    if (!move || !duration || this.disabled()) return;
    // The slider consumes its keys: no page scroll, no global shortcut on top (KBC-041).
    event.preventDefault();
    event.stopPropagation();
    if (move.kind === 'by') this.stepRequested.emit(move.deltaMs);
    else
      this.seekRequested.emit(
        applySliderMove(move, { currentMs: 0, durationMs: duration }),
      );
  }

  protected onPointerDown(event: PointerEvent): void {
    if (!this.loaded() || this.disabled() || event.button !== 0) return;
    this.track().nativeElement.setPointerCapture?.(event.pointerId);
    this.thumb().nativeElement.focus({ preventScroll: true });
    this.dragTo(event, true);
  }

  protected onPointerMove(event: PointerEvent): void {
    if (this.dragMs() !== null) this.dragTo(event, false);
    else if (event.pointerType === 'mouse' && this.loaded())
      this.hoverMs.set(this.msAt(event));
  }

  protected onPointerUp(event: PointerEvent): void {
    if (this.dragMs() === null) return;
    const ms = this.msAt(event);
    this.dragMs.set(null);
    this.seekRequested.emit(ms);
  }

  protected onPointerCancel(): void {
    this.dragMs.set(null);
  }

  protected onPointerLeave(): void {
    this.hoverMs.set(null);
  }

  private dragTo(event: PointerEvent, first: boolean): void {
    const ms = this.msAt(event);
    this.dragMs.set(ms);
    const now = performance.now();
    if (first || now - this.lastDragSeek >= DRAG_SEEK_MS) {
      this.lastDragSeek = now;
      this.seekRequested.emit(ms);
    }
  }

  private msAt(event: PointerEvent): number {
    const rect = this.track().nativeElement.getBoundingClientRect();
    const fraction =
      rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
    return positionAtFraction(fraction, this.durationMs() ?? 0);
  }

  /** Focused, the slider speaks the time: the status region keeps quiet (FR-10). */
  protected setFocused(focused: boolean): void {
    this.focused.set(focused);
    this.announcer.sliderFocused.set(focused);
  }
}
