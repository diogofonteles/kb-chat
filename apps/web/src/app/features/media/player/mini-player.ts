import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import {
  takeUntilDestroyed,
  toObservable,
  toSignal,
} from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { UiButton, UiIconButton } from '@ui/button.js';
import { UiCover, coverGradient } from '@ui/cover.js';
import { UiIcon } from '@ui/icon.js';
import {
  SPEEDS,
  formatClock,
  isSpeed,
  positionToSecond,
} from '@kb-chat/player-core';
import { speak } from '@core/i18n/spoken-time.js';
import { MediaEngine } from '@core/media/media-engine.js';
import { RestrictedSkipper } from '@core/media/restricted-skipper.js';
import { TracksStore } from '@core/media/tracks-store.js';
import { PlayerAnnouncer } from '@core/media/player-announcer.js';
import { ProgressSaver } from '@core/media/progress-saver.js';
import { SleepTimerService } from '@core/media/sleep-timer.js';
import { filter, from, map } from 'rxjs';
import { BookmarksStore } from '@core/media/bookmarks-store.js';
import { VOLUME_SUPPORT } from '@core/media/volume-support.js';
import { MenuButton, type MenuOption } from '../menu-button.js';
import { PlayerVolume } from './player-volume.js';
import { SleepTimerDialog } from './sleep-timer-dialog.js';
import { ClosePlayer } from './close-player.js';
import { ListeningPreferences } from '@core/media/listening-preferences.js';
import { RightPanel } from '@features/shell/right-panel.js';
import { NowPlayingPanel } from './now-playing-panel.js';
import { PlayerShortcuts } from './player-shortcuts.js';

const DECIMAL = new Intl.NumberFormat('pt-BR');
const speedText = (speed: number): string => `${DECIMAL.format(speed)}×`;

/**
 * The persistent mini-player (screens.md T15, KBC-041 FR-8): while a media plays and the
 * person is anywhere but its page, a bar at the foot of the main area keeps it going, with
 * its title (back to the player), back 15 s, play/pause, a thin progress bar and "Fechar o
 * player". It also holds the player's status region (FR-10), present on every page.
 */
@Component({
  selector: 'app-mini-player',
  imports: [
    RouterLink,
    MenuButton,
    SleepTimerDialog,
    UiButton,
    UiCover,
    UiIcon,
    UiIconButton,
  ],
  templateUrl: './mini-player.html',
  styleUrl: './mini-player.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.open]': 'visible()',
    // Keys pressed inside the mini-player work as on the player page (FR-6).
    '(keydown)': "shortcuts.handle($event, 'mini-player')",
  },
})
export class MiniPlayer {
  private readonly engine = inject(MediaEngine);
  /** Skips the parts above the person's level wherever it plays (KBC-106). */
  private readonly restricted = inject(RestrictedSkipper);
  private readonly saver = inject(ProgressSaver);
  private readonly preferences = inject(ListeningPreferences);
  private readonly sleepTimer = inject(SleepTimerService);
  /**
   * "☾ 14:59" (or "☾ No fim") while a sleep timer is on (KBC-046 FR-1): short, so the
   * title keeps its room on a phone; "Timer para dormir:" is there for screen readers.
   */
  protected readonly sleepShown = computed(() => {
    const timer = this.sleepTimer.timer();
    if (timer.kind === 'end-of-media')
      return $localize`:@@player.sleep.atEnd:No fim`;
    return timer.kind === 'minutes'
      ? formatClock(Math.ceil(timer.remainingMs / 1000) * 1000)
      : '';
  });
  protected readonly announcer = inject(PlayerAnnouncer);
  protected readonly shortcuts = inject(PlayerShortcuts);
  private readonly router = inject(Router);
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );

  /** On phones, above the question box (screens.md T15); else at the foot. */
  readonly aboveComposer = input(false);
  /**
   * Nothing loaded but the collection in use has audio (the v2 audio rule, KBC-125 BR-2):
   * the bar stays, saying so.
   */
  readonly idle = input(false);
  /** Where "Escolha um áudio" leads (the library), when the person has it. */
  readonly idleLink = input<string | null>(null);
  /** The idle link names the page it opens: "Biblioteca", or "Mídia" without the library. */
  protected readonly idleInMedia = computed(() => this.idleLink() === '/midia');
  /** A media the full player shows elsewhere on screen (the reading panel, KBC-039). */
  readonly shownElsewhere = input<string | null>(null);

  private readonly rightPanel = inject(RightPanel);
  /** "Tocando agora" is in the shell's right panel (KBC-129 FR-2). */
  protected readonly nowPlayingOpen = computed(
    () => this.rightPanel.content()?.component === NowPlayingPanel,
  );

  protected readonly skipBack = computed(
    () => this.preferences.value().skipBackSec,
  );
  protected readonly backLabel = computed(
    () =>
      $localize`:@@player.backBy:Voltar ${this.skipBack()}:seconds: segundos`,
  );

  protected readonly skipForward = computed(
    () => this.preferences.value().skipForwardSec,
  );
  protected readonly forwardLabel = computed(
    () =>
      $localize`:@@player.forwardBy:Avançar ${this.skipForward()}:seconds: segundos`,
  );
  protected readonly total = computed(() => {
    const { durationMs } = this.engine.playback();
    return durationMs ? formatClock(durationMs) : '';
  });

  protected readonly source = this.engine.source;
  /** The track playing, under the recording's title (KBC-066 FR-9). */
  protected readonly currentTrack = inject(TracksStore).current;
  /** The server no longer has what plays for this person (removed, access taken away). */
  protected readonly gone = computed(() => {
    const source = this.source();
    return source !== null && this.saver.gone() === source.id;
  });
  /** The audio stopped on an error (the network): say so, with "Tentar de novo". */
  protected readonly failed = computed(
    () => this.engine.playback().phase === 'error',
  );
  protected readonly playing = this.engine.playing;
  protected readonly busy = this.engine.busy;
  /** On its own page the full player shows it: no mini-player there. */
  protected readonly visible = computed(() => {
    const source = this.source();
    if (!source || source.id === this.shownElsewhere()) return false;
    const path = this.url().split(/[?#]/)[0];
    return path !== `/midia/${encodeURIComponent(source.id)}`;
  });
  protected readonly percent = computed(() => {
    const { currentMs, durationMs } = this.engine.playback();
    return durationMs ? Math.min(100, (currentMs / durationMs) * 100) : 0;
  });
  protected readonly roundedPercent = computed(() =>
    Math.round(this.percent()),
  );
  protected readonly elapsed = computed(() => {
    const { currentMs, durationMs } = this.engine.playback();
    return formatClock(positionToSecond(currentMs, durationMs));
  });
  protected readonly positionText = computed(() => {
    const { currentMs, durationMs } = this.engine.playback();
    return durationMs
      ? $localize`:@@mini.position:${speak(positionToSecond(currentMs, durationMs))}:now: de ${speak(durationMs)}:total:`
      : '';
  });
  protected readonly playLabel = computed(() => {
    if (this.busy()) return $localize`:@@player.buffering:Carregando. Pausar`;
    return this.playing()
      ? $localize`:@@player.pause:Pausar`
      : $localize`:@@player.play:Tocar`;
  });

  constructor() {
    // Gone from the server: stop at once (the page says why).
    toObservable(this.gone)
      .pipe(filter(Boolean), takeUntilDestroyed())
      .subscribe(() => this.engine.pause());
  }

  private readonly bookmarks = inject(BookmarksStore);
  private readonly closer = inject(ClosePlayer);
  private readonly volumeMemory = inject(PlayerVolume);
  /** Marking needs the loaded media's bookmarks (KBC-042 FR-2). */
  protected readonly canMark = computed(
    () => !this.gone() && this.bookmarks.mediaId() === this.source()?.id,
  );
  /** The mark in green when this media has bookmarks (v2 player bar). */
  protected readonly marked = computed(
    () => this.canMark() && this.bookmarks.bookmarks().length > 0,
  );
  /** The cover's own colour behind the phone's mini player (v2 · celular). */
  protected readonly tint = computed(() => {
    const source = this.source();
    return source ? coverGradient(source.title)[0] : null;
  });
  protected readonly speedShown = computed(() =>
    speedText(this.engine.speed()),
  );
  /** Another speed than 1× shows in green (v2 player bar). */
  protected readonly speedChanged = computed(() => this.engine.speed() !== 1);
  protected readonly speedLabel = computed(
    () =>
      $localize`:@@player.speedLabel:Velocidade: ${DECIMAL.format(this.engine.speed())}:speed: vezes`,
  );
  protected readonly speedOptions = computed<MenuOption[]>(() =>
    SPEEDS.map((speed) => ({
      id: String(speed),
      label: speedText(speed),
      checked: speed === this.engine.speed(),
    })),
  );
  protected readonly sleepButtonLabel = computed(() => {
    const shown = this.sleepShown();
    return shown
      ? $localize`:@@mini.sleep.on:Timer para dormir: ${shown}:time:`
      : $localize`:@@player.sleep.open:Timer para dormir`;
  });
  private readonly volumeAnswer = toSignal(from(inject(VOLUME_SUPPORT)));
  /** Some browsers (iOS) fix the volume: no slider there (KBC-041 FR-9). */
  protected readonly volumeSupported = computed(
    () => this.volumeAnswer() === true,
  );
  protected readonly muted = this.engine.muted;
  protected readonly volumePercent = computed(() =>
    Math.round((this.muted() ? 0 : this.engine.volume()) * 100),
  );

  protected toggle(): void {
    this.engine.toggle();
  }

  /** A bookmark 2 s before now, without its note (the player page edits notes). */
  protected mark(): void {
    this.bookmarks.mark();
    this.bookmarks.editNote(null);
  }

  protected chooseSpeed(id: string): void {
    const speed = Number(id);
    if (isSpeed(speed)) this.preferences.setSpeed(speed);
  }

  protected toggleMute(): void {
    this.engine.toggleMute();
  }

  protected setVolume(event: Event): void {
    if (event.target instanceof HTMLInputElement)
      this.volumeMemory.set(Number(event.target.value) / 100);
  }

  protected back(): void {
    this.engine.skip(-this.preferences.skipBackMs());
  }

  protected forward(): void {
    this.engine.skip(this.preferences.skipForwardMs());
  }

  protected retry(): void {
    this.engine.retry();
  }

  /** The transcript button: opens "Tocando agora" beside any screen, or closes it. */
  protected toggleNowPlaying(): void {
    if (this.nowPlayingOpen()) {
      this.rightPanel.close();
      return;
    }
    this.rightPanel.open({
      component: NowPlayingPanel,
      width: 'narrow',
      label: $localize`:@@mini.nowPlaying:Tocando agora`,
    });
  }

  /** "Fechar o player" (AC-11): on the phone's card; on desktop in "Tocando agora" ⋯. */
  protected close(): void {
    this.closer.run(this.nowPlayingOpen());
  }
}
