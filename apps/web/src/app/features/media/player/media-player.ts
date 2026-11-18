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
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
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
import { ProgressSaver } from '@core/media/progress-saver.js';
import { PlayerAnnouncer } from '@core/media/player-announcer.js';
import { TranscriptPreferences } from '@core/media/transcript-preferences.js';
import { RouterLink } from '@angular/router';
import { UiIcon } from '@ui/icon.js';
import { MenuButton, type MenuOption } from '../menu-button.js';
import { PlayerShortcuts } from './player-shortcuts.js';
import { PlayerVolume } from './player-volume.js';
import { VOLUME_SUPPORT } from '@core/media/volume-support.js';
import { toSignal } from '@angular/core/rxjs-interop';
import { from } from 'rxjs';
import { SeekSlider } from './seek-slider.js';
import { ShortcutsDialog } from './shortcuts-dialog.js';
import { SkipsDialog } from './skips-dialog.js';
import { SleepTimerDialog } from './sleep-timer-dialog.js';
import { SilencesDialog } from './silences-dialog.js';
import { RestrictedSkipper } from '@core/media/restricted-skipper.js';
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
    RouterLink,
    UiIcon,
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
  host: { '[attr.data-volume]': 'volumeState()' },
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
  /**
   * The page's own actions at the top of ⋯ (v2, KBC-129: "Editar informações", "Preparar
   * áudio", "Esconder transcrição"); a choice of one goes back to the page.
   */
  readonly pageOptions = input<readonly MenuOption[]>([]);
  readonly pageChosen = output<string>();
  /** The person has bookmarks in this media: the mark is filled, in green (v2). */
  readonly marked = input(false);
  /**
   * The synced transcript is in view (the page's body): it is the text of what plays, so
   * the subtitles only show when it is hidden or not there (v2 · Mídia — Player).
   */
  readonly transcriptInView = input(false);
  /** The phone's "Sobre este áudio" button: the page brings that part into view. */
  readonly aboutAsked = output();

  protected readonly engine = inject(MediaEngine);
  private readonly transcriptPreferences = inject(TranscriptPreferences);
  private readonly clock = inject(PlaybackClock);
  private readonly announcer = inject(PlayerAnnouncer);
  private readonly document = inject(DOCUMENT);
  private readonly preferences = inject(ListeningPreferences);
  private readonly shortcuts = inject(PlayerShortcuts);
  private readonly volumeMemory = inject(PlayerVolume);
  /**
   * The volume lives in the app's player bar (v2 · Mídia — Player), never here: once the
   * browser answered whether the page may set it, this player says it has no control of its
   * own (`data-volume`, for tests and tools, as the bar does).
   */
  private readonly saver = inject(ProgressSaver);
  /**
   * A phone (below 1024 px): no player bar under the full-screen player, so "Fechar o
   * player", the bar's ✕ on a desktop, is at the foot of ⋯ (v2 · Mídia — Player, celular).
   */
  private readonly phone = signal(false);
  private readonly volumeAnswer = toSignal(from(inject(VOLUME_SUPPORT)));
  protected readonly volumeState = computed(() =>
    this.volumeAnswer() === undefined ? 'pending' : 'off',
  );
  private readonly shortcutsDialog = viewChild.required(ShortcutsDialog);
  private readonly skipsDialog = viewChild.required(SkipsDialog);
  private readonly sleepDialog = viewChild.required(SleepTimerDialog);
  private readonly silencesDialog = viewChild.required(SilencesDialog);
  /** Skips long pauses while the option is on (KBC-044); lives with the engine. */
  private readonly silences = inject(SilenceSkipper);
  /** Skips the parts above the person's level, always (KBC-106); lives with the engine. */
  protected readonly restricted = inject(RestrictedSkipper);
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
  /** Shown under the bar only while the transcript is not in view. */
  protected readonly captionsShown = computed(
    () => this.captionsOn() && !this.transcriptInView(),
  );
  /** The cue on screen now (two lines at most), following the smoothed clock. */
  protected readonly caption = computed(() =>
    this.captionsShown()
      ? (cueAt(this.cues(), this.clock.positionMs())?.text ?? '')
      : '',
  );
  /** ⋯ as in the v2 frame: the page's actions, a line, the listening ones, a line, keys. */
  protected readonly moreOptions = computed<readonly MenuOption[]>(() => {
    const page = this.pageOptions();
    // The bar's ✕ where there is no bar (a phone), first of the player's own options.
    const close = this.phone() && this.engine.source() !== null;
    const on = $localize`:@@player.state.on:ligado`;
    const off = $localize`:@@player.state.off:desligado`;
    return [
      ...page,
      ...(close
        ? [
            {
              id: 'close',
              icon: 'close' as const,
              divider: page.length > 0,
              label: $localize`:@@mini.close:Fechar o player`,
            },
          ]
        : []),
      {
        id: 'link',
        icon: 'link',
        divider: page.length > 0 && !close,
        label: $localize`:@@player.copyMinuteLink:Copiar link deste minuto`,
      },
      {
        id: 'skips',
        icon: 'forward',
        label: $localize`:@@player.skips.open:Pulos`,
      },
      {
        id: 'silences',
        icon: 'wave',
        label: $localize`:@@player.silences.open:Encurtar silêncios`,
        ...(this.silences.enabled() ? { trail: on } : {}),
      },
      ...(this.captionsAvailable()
        ? [
            {
              id: 'word-highlight',
              icon: 'type' as const,
              label: $localize`:@@player.wordHighlight.label:Destacar palavra a palavra`,
              trail: this.preferences.value().wordHighlight ? on : off,
            },
          ]
        : []),
      {
        id: 'sleep',
        icon: 'moon',
        label: $localize`:@@player.sleep.open:Timer para dormir`,
      },
      ...(this.speakersAvailable()
        ? [
            {
              id: 'speakers',
              icon: 'people' as const,
              label: $localize`:@@player.speakers.label:Mostrar quem fala`,
              trail: this.transcriptPreferences.speakersOn() ? on : off,
            },
          ]
        : []),
      ...(this.captionsAvailable()
        ? [
            {
              id: 'captions',
              icon: 'cc' as const,
              label: $localize`:@@player.captions.label:Legendas`,
              trail: this.transcriptPreferences.captionsOn() ? on : off,
            },
          ]
        : []),
      {
        id: 'shortcuts',
        icon: 'keyboard',
        divider: true,
        label: $localize`:@@player.shortcuts.open:Atalhos de teclado`,
        trail: '?',
      },
    ];
  });
  /** The ☾ button, only while a sleep timer runs (KBC-046). */
  protected readonly sleepOn = computed(
    () => this.sleepTimer.timer().kind !== 'off',
  );
  protected readonly sleepShown = computed(() => {
    const remaining = this.sleepTimer.remainingMs();
    return remaining === null
      ? $localize`:@@player.sleep.atEndChip:Para no fim`
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

  constructor() {
    // Frames only while subtitles show cues here (never for the mini-player).
    this.clock.follow(
      () => this.captionsShown() && this.cues().length > 0,
      inject(DestroyRef),
    );
    this.preferences.load();
    this.volumeMemory.restore();
    this.followPhone(inject(DestroyRef));
    // "?" anywhere the shortcuts act opens the list; only new requests count.
    const asked = this.shortcuts.helpAsked();
    effect(() => {
      if (this.shortcuts.helpAsked() > asked)
        untracked(() => this.shortcutsDialog().open());
    });
    const sleepAsked = this.shortcuts.sleepAsked();
    effect(() => {
      if (this.shortcuts.sleepAsked() > sleepAsked)
        untracked(() => this.sleepDialog().open());
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

  private toggleWordHighlight(): void {
    const on = !this.preferences.value().wordHighlight;
    this.preferences.setWordHighlight(on);
    this.announcer.say(
      on
        ? $localize`:@@player.announce.wordHighlightOn:Destaque palavra a palavra ligado`
        : $localize`:@@player.announce.wordHighlightOff:Destaque palavra a palavra desligado`,
    );
  }

  private followPhone(destroyRef: DestroyRef): void {
    const query = this.document.defaultView?.matchMedia?.(
      '(max-width: 1023px)',
    );
    if (!query) return;
    this.phone.set(query.matches);
    const changed = (event: MediaQueryListEvent) =>
      this.phone.set(event.matches);
    query.addEventListener('change', changed);
    destroyRef.onDestroy(() => query.removeEventListener('change', changed));
  }

  /** After a page action's dialog closes, the focus goes back to ⋯ (WCAG 2.4.3). */
  focusMore(): void {
    this.more().focus();
  }

  protected chooseMore(id: string): void {
    if (this.pageOptions().some((option) => option.id === id)) {
      this.pageChosen.emit(id);
      return;
    }
    if (id === 'link') this.copyMinuteLink();
    if (id === 'word-highlight') this.toggleWordHighlight();
    if (id === 'speakers') this.transcriptPreferences.toggleSpeakers();
    if (id === 'captions') this.toggleCaptions();
    if (id === 'shortcuts') this.shortcutsDialog().open();
    if (id === 'skips') this.skipsDialog().open();
    if (id === 'sleep') this.sleepDialog().open();
    if (id === 'silences') this.silencesDialog().open();
    if (id === 'close') this.closePlayer();
  }

  /** As the bar's ✕: stops, keeps the position and lets the media go (KBC-041 AC-11). */
  private closePlayer(): void {
    const source = this.engine.source();
    this.engine.pause();
    if (source && this.saver.gone() !== source.id) this.saver.saveNow();
    this.engine.unload();
    this.focusMore();
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

  /** The share button (v2): the link of this minute, as "Copiar link deste minuto". */
  protected share(): void {
    this.copyMinuteLink();
  }

  protected openSleep(): void {
    this.sleepDialog().open();
  }

  protected mark(): void {
    this.bookmarks.mark();
  }

  /** The note closed: the focus goes back to "Marcar este trecho" (NG-30). */
  protected noteClosed(): void {
    this.markButton().nativeElement.focus();
  }
}
