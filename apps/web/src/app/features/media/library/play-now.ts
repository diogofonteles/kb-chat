import { Injectable, inject } from '@angular/core';
import type { MediaItem } from '@kb-chat/contracts';
import { resumeFrom } from '@kb-chat/player-core';
import { AUTHORSHIP_LABELS } from '@core/i18n/facet-labels.js';
import { mediaStreamUrl } from '@core/media/media-api.js';
import { MediaEngine } from '@core/media/media-engine.js';
import { ProgressSaver } from '@core/media/progress-saver.js';

/**
 * The library's ▶ (KBC-051 FR-8): plays a media at once from where the person stopped,
 * without asking, and the mini-player takes over (KBC-041). The one already playing is
 * paused or resumed instead of loaded again.
 */
@Injectable({ providedIn: 'root' })
export class PlayNow {
  private readonly engine = inject(MediaEngine);
  private readonly saver = inject(ProgressSaver);

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
    const at = resumeFrom(this.saver.startFrom(item), item.durationMs) ?? 0;
    this.engine.load(
      {
        id: item.id,
        title: item.title,
        src: mediaStreamUrl(item.id, item.parent?.fileVersion),
        durationMs: item.durationMs,
        artist: item.author?.name ?? AUTHORSHIP_LABELS['outros-autores'],
        ...(item.parent ? { fileVersion: item.parent.fileVersion } : {}),
      },
      at,
    );
    this.engine.play();
  }
}
