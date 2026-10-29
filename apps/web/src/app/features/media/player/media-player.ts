import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  SPEEDS,
  formatClock,
  formatDuration,
  formatRemaining,
  isSpeed,
  positionToSecond,
  type PlaybackErrorKind,
} from '@kb-chat/player-core';
import { ListeningPreferences } from '@core/media/listening-preferences.js';
import { MediaEngine } from '@core/media/media-engine.js';
import { VOLUME_SUPPORT } from '@core/media/volume-support.js';
import { from } from 'rxjs';
import { MenuButton, type MenuOption } from '../menu-button.js';
import {
  PlayerShortcuts,
  SKIP_BACK_MS,
  SKIP_FORWARD_MS,
} from './player-shortcuts.js';
import { PlayerVolume } from './player-volume.js';
import { SeekSlider } from './seek-slider.js';
import { ShortcutsDialog } from './shortcuts-dialog.js';

export { SKIP_BACK_MS, SKIP_FORWARD_MS };

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

const DECIMAL = new Intl.NumberFormat('pt-BR');
const speedText = (speed: number): string => `${DECIMAL.format(speed)}×`;

/**
 * The player's controls (screens.md T15, KBC-034 FR-6a, KBC-041) over the app's media
 * engine: play/pause, back 15 s, forward 30 s, the time slider, elapsed and remaining
 * time, the speed (kept on the account), the volume where the browser allows it, and
 * "Mais opções" with the keyboard shortcuts. It shows the engine's state; it holds none.
 */
@Component({
  selector: 'app-media-player',
  imports: [SeekSlider, MenuButton, ShortcutsDialog],
  templateUrl: './media-player.html',
  styleUrl: './media-player.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MediaPlayer {
  protected readonly engine = inject(MediaEngine);
  private readonly preferences = inject(ListeningPreferences);
  private readonly shortcuts = inject(PlayerShortcuts);
  private readonly volumeMemory = inject(PlayerVolume);
  private readonly shortcutsDialog = viewChild.required(ShortcutsDialog);
  protected readonly playback = this.engine.playback;
  /** The volume control exists only where the page may set the volume (FR-9). */
  protected readonly volumeSupported = toSignal(from(inject(VOLUME_SUPPORT)), {
    initialValue: false,
  });

  protected readonly operable = this.engine.operable;
  protected readonly canPlay = this.engine.canPlay;
  protected readonly ended = computed(() => this.playback().phase === 'ended');
  protected readonly busy = this.engine.busy;
  protected readonly playing = this.engine.playing;
  protected readonly showRemaining = computed(
    () => this.preferences.value().showRemaining,
  );
  protected readonly elapsed = computed(() =>
    formatClock(
      positionToSecond(this.playback().currentMs, this.playback().durationMs),
    ),
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
    if (this.busy()) return $localize`:@@player.buffering:Carregando. Pausar`;
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

  protected readonly speed = this.engine.speed;
  protected readonly speedShown = computed(() => speedText(this.speed()));
  protected readonly speedLabel = computed(
    () =>
      $localize`:@@player.speedLabel:Velocidade: ${DECIMAL.format(this.speed())}:speed: vezes`,
  );
  protected readonly speedOptions = computed<MenuOption[]>(() =>
    SPEEDS.map((speed) => ({
      id: String(speed),
      label: speedText(speed),
      checked: speed === this.speed(),
    })),
  );
  protected readonly moreOptions: readonly MenuOption[] = [
    {
      id: 'shortcuts',
      label: $localize`:@@player.shortcuts.open:Atalhos de teclado`,
    },
  ];

  protected readonly muted = this.engine.muted;
  protected readonly volumePercent = computed(() =>
    Math.round((this.muted() ? 0 : this.engine.volume()) * 100),
  );
  protected readonly volumeText = computed(() => `${this.volumePercent()}%`);

  constructor() {
    this.preferences.load();
    this.volumeMemory.restore();
    // "?" anywhere the shortcuts act opens the list; only new requests count.
    const asked = this.shortcuts.helpAsked();
    effect(() => {
      if (this.shortcuts.helpAsked() > asked)
        untracked(() => this.shortcutsDialog().open());
    });
  }

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
    this.preferences.toggleShowRemaining();
  }

  protected chooseSpeed(id: string): void {
    const speed = Number(id);
    if (isSpeed(speed)) this.preferences.setSpeed(speed);
  }

  protected chooseMore(id: string): void {
    if (id === 'shortcuts') this.shortcutsDialog().open();
  }

  protected toggleMute(): void {
    this.engine.toggleMute();
  }

  protected setVolume(event: Event): void {
    if (event.target instanceof HTMLInputElement)
      this.volumeMemory.set(Number(event.target.value) / 100);
  }
}
