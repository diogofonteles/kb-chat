import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  SPEEDS,
  cueAt,
  formatClock,
  minuteLink,
  formatDuration,
  formatRemaining,
  isSpeed,
  positionToSecond,
  type Cue,
  type PlaybackErrorKind,
} from '@kb-chat/player-core';
import { speak } from '@core/i18n/spoken-time.js';
import { ListeningPreferences } from '@core/media/listening-preferences.js';
import { SleepTimerService } from '@core/media/sleep-timer.js';
import { BookmarksStore } from '@core/media/bookmarks-store.js';
import { MediaEngine } from '@core/media/media-engine.js';
import { TracksStore } from '@core/media/tracks-store.js';
import { mediaPagePath } from '@core/media/media-api.js';
import { PlaybackClock } from '@core/media/playback-clock.js';
import { PlayerAnnouncer } from '@core/media/player-announcer.js';
import { TranscriptPreferences } from '@core/media/transcript-preferences.js';
import { VOLUME_SUPPORT } from '@core/media/volume-support.js';
import { from } from 'rxjs';
import { MenuButton, type MenuOption } from '../menu-button.js';
import { PlayerShortcuts } from './player-shortcuts.js';
import { PlayerVolume } from './player-volume.js';
import { SeekSlider } from './seek-slider.js';
import { ShortcutsDialog } from './shortcuts-dialog.js';
import { SkipsDialog } from './skips-dialog.js';
import { SleepTimerDialog } from './sleep-timer-dialog.js';
import { SilencesDialog } from './silences-dialog.js';
import { SilenceSkipper } from '@core/media/silence-skipper.js';
import { BookmarkNote } from './bookmark-note.js';

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

const LINK_NOT_COPIED = () =>
  $localize`:@@player.minuteLinkFailed:Não consegui copiar o link.`;

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
  imports: [
    SeekSlider,
    MenuButton,
    ShortcutsDialog,
    SkipsDialog,
    SleepTimerDialog,
    SilencesDialog,
    BookmarkNote,
  ],
  templateUrl: './media-player.html',
  styleUrl: './media-player.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MediaPlayer {
  /** The subtitles of the current transcript (KBC-038); empty while none is loaded. */
  readonly cues = input<readonly Cue[]>([]);
  /** The media has a transcript: CC can be used. */
  readonly captionsAvailable = input(false);
  /** The person may see who speaks: "Mostrar quem fala" in ⋯ (KBC-065 FR-4). */
  readonly speakersAvailable = input(false);
  /**
   * The transcript is of low confidence and its own notice may be out of sight (stacked
   * layout): a short notice goes with the subtitles (KBC-036 BR-5).
   */
  readonly lowConfidence = input(false);

  protected readonly engine = inject(MediaEngine);
  private readonly transcriptPreferences = inject(TranscriptPreferences);
  private readonly clock = inject(PlaybackClock);
  private readonly announcer = inject(PlayerAnnouncer);
  private readonly document = inject(DOCUMENT);
  private readonly preferences = inject(ListeningPreferences);
  private readonly shortcuts = inject(PlayerShortcuts);
  private readonly volumeMemory = inject(PlayerVolume);
  private readonly shortcutsDialog = viewChild.required(ShortcutsDialog);
  private readonly skipsDialog = viewChild.required(SkipsDialog);
  private readonly sleepDialog = viewChild.required(SleepTimerDialog);
  private readonly silencesDialog = viewChild.required(SilencesDialog);
  /** Skips long pauses while the option is on (KBC-044); lives with the engine. */
  private readonly silences = inject(SilenceSkipper);
  private readonly more = viewChild.required<MenuButton>('more');
  private readonly injector = inject(Injector);
  private readonly sleepTimer = inject(SleepTimerService);
  protected readonly bookmarks = inject(BookmarksStore);
  private readonly markButton =
    viewChild.required<ElementRef<HTMLButtonElement>>('markButton');
  /** Marking needs the loaded media's bookmarks (KBC-042 FR-2). */
  protected readonly canMark = computed(
    () => this.operable() && this.bookmarks.mediaId() !== null,
  );
  protected readonly playback = this.engine.playback;
  /** The approved tracks (KBC-066 FR-9): none without `media-tracks`. */
  protected readonly tracks = inject(TracksStore);
  protected readonly trackStarts = computed(() =>
    this.tracks.tracks().map((track) => track.startMs),
  );
  /** The volume control exists only where the page may set the volume (FR-9). */
  private readonly volumeAnswer = toSignal(from(inject(VOLUME_SUPPORT)));
  protected readonly volumeSupported = computed(
    () => this.volumeAnswer() === true,
  );
  /** Whether the volume question was answered yet (`data-volume`, for tests and tools). */
  protected readonly volumeState = computed(() => {
    const answer = this.volumeAnswer();
    return answer === undefined ? 'pending' : answer ? 'on' : 'off';
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
  /** CC (FR-6): on for every media until turned off; shown only with a transcript. */
  protected readonly captionsOn = computed(
    () => this.captionsAvailable() && this.transcriptPreferences.captionsOn(),
  );
  protected readonly captionsPressed = this.transcriptPreferences.captionsOn;
  /** The cue on screen now (two lines at most), following the smoothed clock. */
  protected readonly caption = computed(() =>
    this.captionsOn()
      ? (cueAt(this.cues(), this.clock.positionMs())?.text ?? '')
      : '',
  );
  protected readonly moreOptions = computed<readonly MenuOption[]>(() => [
    {
      id: 'link',
      label: $localize`:@@player.copyMinuteLink:Copiar link deste minuto`,
    },
    { id: 'skips', label: $localize`:@@player.skips.open:Pulos` },
    {
      id: 'silences',
      label: this.silences.enabled()
        ? $localize`:@@player.silences.openOn:Encurtar silêncios: ligado`
        : $localize`:@@player.silences.open:Encurtar silêncios`,
    },
    ...this.wordHighlightOption(),
    {
      id: 'sleep',
      label: $localize`:@@player.sleep.open:Timer para dormir`,
    },
    ...this.speakersOption(),
    {
      id: 'shortcuts',
      label: $localize`:@@player.shortcuts.open:Atalhos de teclado`,
    },
  ]);
  /** The ☾ button, only while a sleep timer runs (KBC-046). */
  protected readonly sleepOn = computed(
    () => this.sleepTimer.timer().kind !== 'off',
  );
  protected readonly sleepShown = computed(() => {
    const remaining = this.sleepTimer.remainingMs();
    return remaining === null
      ? $localize`:@@player.sleep.atEnd:No fim`
      : $localize`:@@player.sleep.stopsAt:Para em ${formatClock(Math.ceil(remaining / 1000) * 1000)}:time:`;
  });
  protected readonly sleepLabel = computed(() => {
    const remaining = this.sleepTimer.remainingMs();
    return remaining === null
      ? $localize`:@@player.sleep.labelEnd:Timer para dormir: no fim desta mídia`
      : $localize`:@@player.sleep.label:Timer para dormir: para em ${speak(Math.ceil(remaining / 1000) * 1000)}:time:`;
  });
  protected readonly sleepOptions = computed<MenuOption[]>(() => [
    ...(this.sleepTimer.remainingMs() === null
      ? []
      : [
          {
            id: 'extend',
            label: $localize`:@@player.sleep.extend:Mais 5 minutos`,
          },
        ]),
    { id: 'off', label: $localize`:@@player.sleep.off:Desligar timer` },
  ]);

  /** The person's skips (KBC-043): the number on each button and in its name. */
  protected readonly skipBack = computed(
    () => this.preferences.value().skipBackSec,
  );
  protected readonly skipForward = computed(
    () => this.preferences.value().skipForwardSec,
  );
  protected readonly backLabel = computed(
    () =>
      $localize`:@@player.backBy:Voltar ${this.skipBack()}:seconds: segundos`,
  );
  protected readonly forwardLabel = computed(
    () =>
      $localize`:@@player.forwardBy:Avançar ${this.skipForward()}:seconds: segundos`,
  );

  protected readonly muted = this.engine.muted;
  protected readonly volumePercent = computed(() =>
    Math.round((this.muted() ? 0 : this.engine.volume()) * 100),
  );
  protected readonly volumeText = computed(() => `${this.volumePercent()}%`);

  constructor() {
    // Frames only while subtitles show cues here (never for the mini-player).
    this.clock.follow(
      () => this.captionsOn() && this.cues().length > 0,
      inject(DestroyRef),
    );
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
    this.engine.skip(-this.preferences.skipBackMs());
  }

  protected forward(): void {
    this.engine.skip(this.preferences.skipForwardMs());
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

  protected toggleCaptions(): void {
    this.transcriptPreferences.toggleCaptions();
  }

  /** The choice says its state in words, as "Encurtar silêncios: ligado". */
  private speakersOption(): readonly MenuOption[] {
    if (!this.speakersAvailable()) return [];
    const label = this.transcriptPreferences.speakersOn()
      ? $localize`:@@player.speakers.on:Mostrar quem fala: ligado`
      : $localize`:@@player.speakers.off:Mostrar quem fala: desligado`;
    return [{ id: 'speakers', label }];
  }

  /** "Destacar palavra a palavra" (KBC-045), with a transcript to highlight. */
  private wordHighlightOption(): readonly MenuOption[] {
    if (!this.captionsAvailable()) return [];
    const label = this.preferences.value().wordHighlight
      ? $localize`:@@player.wordHighlight.on:Destacar palavra a palavra: ligado`
      : $localize`:@@player.wordHighlight.off:Destacar palavra a palavra: desligado`;
    return [{ id: 'word-highlight', label }];
  }

  private toggleWordHighlight(): void {
    const on = !this.preferences.value().wordHighlight;
    this.preferences.setWordHighlight(on);
    this.announcer.say(
      on
        ? $localize`:@@player.announce.wordHighlightOn:Destaque palavra a palavra ligado`
        : $localize`:@@player.announce.wordHighlightOff:Destaque palavra a palavra desligado`,
    );
  }

  protected chooseMore(id: string): void {
    if (id === 'link') this.copyMinuteLink();
    if (id === 'word-highlight') this.toggleWordHighlight();
    if (id === 'speakers') this.transcriptPreferences.toggleSpeakers();
    if (id === 'shortcuts') this.shortcutsDialog().open();
    if (id === 'skips') this.skipsDialog().open();
    if (id === 'sleep') this.sleepDialog().open();
    if (id === 'silences') this.silencesDialog().open();
  }

  protected chooseSleep(id: string): void {
    if (id === 'extend') this.sleepTimer.extend();
    if (id !== 'off') return;
    this.sleepTimer.off();
    // The ☾ button had the focus and goes away: "Mais opções" takes it (WCAG 2.4.3).
    afterNextRender(() => this.more().focus(), { injector: this.injector });
  }

  /** "Copiar link deste minuto" (FR-5): the page with `?t=` of the second heard now. */
  private copyMinuteLink(): void {
    const source = this.engine.source();
    const clipboard = this.document.defaultView?.navigator.clipboard;
    if (!source || !clipboard) {
      this.announcer.say(LINK_NOT_COPIED());
      return;
    }
    const page = this.document.location.origin + mediaPagePath(source.id);
    const link = minuteLink(page, this.playback().currentMs);
    // The browser's clipboard is a Promise API; both outcomes are said (TS-14).
    void clipboard.writeText(link).then(
      () =>
        this.announcer.say(
          $localize`:@@player.minuteLinkCopied:Link deste minuto copiado.`,
        ),
      () => this.announcer.say(LINK_NOT_COPIED()),
    );
  }

  protected mark(): void {
    this.bookmarks.mark();
  }

  /** The note closed: the focus goes back to "Marcar este trecho" (NG-30). */
  protected noteClosed(): void {
    this.markButton().nativeElement.focus();
  }

  protected toggleMute(): void {
    this.engine.toggleMute();
  }

  protected setVolume(event: Event): void {
    if (event.target instanceof HTMLInputElement)
      this.volumeMemory.set(Number(event.target.value) / 100);
  }
}
