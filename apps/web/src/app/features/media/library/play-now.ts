import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import type { MediaItem } from '@kb-chat/contracts';
import { resumeFrom } from '@kb-chat/player-core';
import { AUTHORSHIP_LABELS } from '@core/i18n/facet-labels.js';
import { mediaStreamUrl } from '@core/media/media-api.js';
import { MediaEngine } from '@core/media/media-engine.js';
import { RestrictedSkipper } from '@core/media/restricted-skipper.js';
import { ProgressSaver } from '@core/media/progress-saver.js';

/**
 * The library's ▶ (KBC-051 FR-8): plays a media at once from where the person stopped,
 * without asking, and the mini-player takes over (KBC-041). The one already playing is
 * paused or resumed instead of loaded again.
 */
@Injectable({ providedIn: 'root' })
export class PlayNow {
  private readonly engine = inject(MediaEngine);
  /** Skips the parts above the person's level wherever it plays (KBC-106). */
  private readonly restricted = inject(RestrictedSkipper);
  private readonly saver = inject(ProgressSaver);
  /** "Tocar em seguida" (v2 media-library-row-menu): what plays when the current one ends. */
  private readonly next = signal<readonly MediaItem[]>([]);
  readonly upNext = this.next.asReadonly();

  constructor() {
    // The one playing ended: the first one asked for next starts from where it stopped.
    effect(() => {
      if (this.engine.playback().phase !== 'ended') return;
      untracked(() => {
        const [first, ...rest] = this.next();
        if (!first) return;
        this.next.set(rest);
        this.play(first);
      });
    });
  }

  /** True while this media is the one loaded and playing. */
  isPlaying(id: string): boolean {
    return this.engine.source()?.id === id && this.engine.playing();
  }

  play(item: MediaItem): void {
    if (this.engine.source()?.id === item.id) {
      this.engine.toggle();
      return;
    }
    // This browser's unsent position when no device saved since (KBC-041 FR-3).
    this.start(
      item,
      resumeFrom(this.saver.startFrom(item), item.durationMs) ?? 0,
    );
  }

  /**
   * "Tocar em seguida": after the one playing (and after those already asked for); with
   * nothing playing it plays now. True when it waits its turn.
   */
  playNext(item: MediaItem): boolean {
    const current = this.engine.source();
    const ended = this.engine.playback().phase === 'ended';
    if (!current || ended || current.id === item.id) {
      if (current?.id !== item.id || !this.engine.playing()) this.play(item);
      return false;
    }
    this.next.update((queued) => [
      ...queued.filter((one) => one.id !== item.id),
      item,
    ]);
    return true;
  }

  /**
   * A search result's ▶ (KBC-096): from that point, whatever was saved. Playing, it pauses;
   * paused, it goes back to the point, since that is what the row offers.
   */
  playFrom(item: MediaItem, atMs: number): void {
    if (this.engine.source()?.id !== item.id) {
      this.saver.startFrom(item);
      this.start(item, atMs);
    } else if (this.engine.playing()) {
      this.engine.toggle();
    } else {
      this.engine.seek(atMs);
      this.engine.play();
    }
  }

  private start(item: MediaItem, atMs: number): void {
    this.engine.load(
      {
        id: item.id,
        title: item.title,
        src: mediaStreamUrl(item.id, item.parent?.fileVersion),
        durationMs: item.durationMs,
        artist: item.author?.name ?? AUTHORSHIP_LABELS['outros-autores'],
        ...(item.parent ? { fileVersion: item.parent.fileVersion } : {}),
        ...(item.hidden ? { hidden: item.hidden } : {}),
      },
      atMs,
    );
    this.engine.play();
  }
}
