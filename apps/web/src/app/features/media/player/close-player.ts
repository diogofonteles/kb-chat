import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { MediaEngine } from '@core/media/media-engine.js';
import { ProgressSaver } from '@core/media/progress-saver.js';
import { RightPanel } from '@features/shell/right-panel.js';

/**
 * "Fechar o player" (KBC-041 AC-11), from the phone's mini player or from "Tocando agora" ⋯
 * (v2 has no close on the desktop bar): stops, saves where it stopped, unloads and takes
 * "Tocando agora" away. The focus, on a control that goes, moves to the main area (WCAG
 * 2.4.3).
 */
@Injectable({ providedIn: 'root' })
export class ClosePlayer {
  private readonly engine = inject(MediaEngine);
  private readonly saver = inject(ProgressSaver);
  private readonly rightPanel = inject(RightPanel);
  private readonly document = inject(DOCUMENT);

  /** `nowPlayingOpen`: "Tocando agora" is what the right panel shows (it goes too). */
  run(nowPlayingOpen: boolean): void {
    const source = this.engine.source();
    this.engine.pause();
    if (source && this.saver.gone() !== source.id) this.saver.saveNow();
    this.engine.unload();
    if (nowPlayingOpen) this.rightPanel.close();
    const main = this.document.querySelector('main');
    if (main) {
      main.tabIndex = -1;
      main.focus();
    }
  }
}
