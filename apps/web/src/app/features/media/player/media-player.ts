import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  formatClock,
  formatDuration,
  formatRemaining,
  type PlaybackErrorKind,
} from '@kb-chat/player-core';
import { MediaEngine } from '@core/media/media-engine.js';
import { SeekSlider } from './seek-slider.js';

export const SKIP_BACK_MS = 15_000;
export const SKIP_FORWARD_MS = 30_000;

const ERROR_MESSAGES: Record<PlaybackErrorKind, () => string> = {
  network: () =>
    $localize`:@@player.error.network:Não consegui carregar o áudio. Verifique a conexão.`,
  decode: () =>
    $localize`:@@player.error.decode:Este áudio não pôde ser tocado neste navegador.`,
  unsupported: () =>
    $localize`:@@player.error.unsupported:Este navegador não toca este áudio. Tente outro navegador.`,
  aborted: () =>
    $localize`:@@player.error.aborted:O carregamento do áudio foi interrompido.`,
};

/**
 * The player's controls (screens.md T15, KBC-034 FR-6a) over the app's media engine:
 * play/pause, back 15 s, forward 30 s, the time slider, elapsed and remaining time, and
 * the loading, waiting, error and ended states. It shows the engine's state; it holds none.
 */
@Component({
  selector: 'app-media-player',
  imports: [SeekSlider],
  templateUrl: './media-player.html',
  styleUrl: './media-player.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MediaPlayer {
  protected readonly engine = inject(MediaEngine);
  protected readonly playback = this.engine.playback;
  /** Remaining time (-39:05) or the total (1:02:15) on the right; a tap switches. */
  protected readonly showRemaining = signal(true);

  protected readonly operable = this.engine.operable;
  protected readonly loading = computed(
    () => this.playback().phase === 'loading',
  );
  protected readonly ended = computed(() => this.playback().phase === 'ended');
  protected readonly buffering = computed(
    () => this.playback().bufferingVisible,
  );
  protected readonly playing = this.engine.playing;
  protected readonly elapsed = computed(() =>
    formatClock(this.playback().currentMs),
  );
  protected readonly rightTime = computed(() => {
    const { currentMs, durationMs } = this.playback();
    if (durationMs === null) return '--:--';
    return this.showRemaining()
      ? formatRemaining(currentMs, durationMs)
      : formatDuration(durationMs);
  });
  protected readonly rightTimeLabel = computed(() =>
    this.showRemaining()
      ? $localize`:@@player.showTotal:Tempo restante. Mostrar a duração total`
      : $localize`:@@player.showRemaining:Duração total. Mostrar o tempo restante`,
  );
  protected readonly playLabel = computed(() => {
    if (this.loading()) return $localize`:@@player.loading:Carregando o áudio`;
    if (this.buffering())
      return $localize`:@@player.buffering:Carregando. Pausar`;
    return this.playing()
      ? $localize`:@@player.pause:Pausar`
      : $localize`:@@player.play:Tocar`;
  });
  protected readonly errorMessage = computed(() => {
    const kind = this.playback().error;
    return this.playback().phase === 'error' && kind
      ? ERROR_MESSAGES[kind]()
      : '';
  });

  protected toggle(): void {
    this.engine.toggle();
  }

  protected back(): void {
    this.engine.skip(-SKIP_BACK_MS);
  }

  protected forward(): void {
    this.engine.skip(SKIP_FORWARD_MS);
  }

  protected seekTo(ms: number): void {
    this.engine.seek(ms);
  }

  protected stepBy(deltaMs: number): void {
    this.engine.skip(deltaMs);
  }

  protected playAgain(): void {
    this.engine.seek(0);
    this.engine.play();
  }

  protected retry(): void {
    this.engine.retry();
  }

  protected toggleTimeDisplay(): void {
    this.showRemaining.update((remaining) => !remaining);
  }
}
