import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  viewChild,
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
import { BookmarksStore } from '@core/media/bookmarks-store.js';
import { VOLUME_SUPPORT } from '@core/media/volume-support.js';
import { from } from 'rxjs';
import { PlayerVolume } from './player-volume.js';
import { SeekSlider } from './seek-slider.js';
import { SleepTimerDialog } from './sleep-timer-dialog.js';
import { speak } from '@core/i18n/spoken-time.js';
import { MediaEngine } from '@core/media/media-engine.js';
import { RestrictedSkipper } from '@core/media/restricted-skipper.js';
import { TracksStore } from '@core/media/tracks-store.js';
import { PlayerAnnouncer } from '@core/media/player-announcer.js';
import { ProgressSaver } from '@core/media/progress-saver.js';
import { SleepTimerService } from '@core/media/sleep-timer.js';
import { filter, map } from 'rxjs';
import { ListeningPreferences } from '@core/media/listening-preferences.js';
import { RightPanel } from '@features/shell/right-panel.js';
import { NowPlayingPanel } from './now-playing-panel.js';
import { PlayerShortcuts } from './player-shortcuts.js';

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
    SeekSlider,
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
  protected readonly engine = inject(MediaEngine);
  /** Skips the parts above the person's level wherever it plays (KBC-106). */
  protected readonly restricted = inject(RestrictedSkipper);
  protected readonly bookmarks = inject(BookmarksStore);
  private readonly volumeMemory = inject(PlayerVolume);
  private readonly sleepDialog = viewChild(SleepTimerDialog);
  /**
   * The desktop player bar (v2, KBC-129): the seek line, and the bar stays on the page of
   * what plays (lib.js playerBar), where the page's own controls are echoed.
   */
  readonly desktop = input(false);
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

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
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
  /** The page of what plays is open. */
  private readonly onItsPage = computed(() => {
    const source = this.source();
    const path = this.url().split(/[?#]/)[0];
    return !!source && path === `/midia/${encodeURIComponent(source.id)}`;
  });
  /** On its own page a phone shows the full-screen player: no mini player there. */
  protected readonly visible = computed(() => {
    const source = this.source();
    if (!source || source.id === this.shownElsewhere()) return false;
    return this.desktop() || !this.onItsPage();
  });
  /** The bar beside the page's own player: its transport is an echo (one control each). */
  protected readonly echo = computed(() => this.desktop() && this.onItsPage());
  protected readonly seekable = this.desktop;
  protected readonly marked = computed(
    () =>
      this.bookmarks.mediaId() === this.source()?.id &&
      this.bookmarks.bookmarks().length > 0,
  );
  protected readonly canMark = computed(
    () => this.engine.operable() && this.bookmarks.mediaId() !== null,
  );
  protected readonly trackStarts = computed(() =>
    this.currentTrackList().map((track) => track.startMs),
  );
  private readonly currentTrackList = inject(TracksStore).tracks;
  private readonly speedText = new Intl.NumberFormat('pt-BR');
  protected readonly speedShown = computed(
    () => `${this.speedText.format(this.engine.speed())}×`,
  );
  protected readonly speedLabel = computed(
    () =>
      $localize`:@@mini.speedLabel:Velocidade: ${this.speedText.format(this.engine.speed())}:speed: vezes. Trocar`,
  );
  protected readonly sleepLabel = computed(() =>
    this.sleepShown()
      ? $localize`:@@mini.sleepOn:Timer para dormir: ${this.sleepShown()}:time:`
      : $localize`:@@player.sleep.open:Timer para dormir`,
  );
  /** The volume control exists only where the page may set the volume (FR-9). */
  private readonly volumeAnswer = toSignal(from(inject(VOLUME_SUPPORT)));
  protected readonly volumeSupported = computed(
    () => this.volumeAnswer() === true && this.desktop(),
  );
  /** Whether the volume question was answered yet (`data-volume`, for tests and tools). */
  protected readonly volumeState = computed(() => {
    const answer = this.volumeAnswer();
    if (answer === undefined) return 'pending';
    return answer && this.desktop() ? 'on' : 'off';
  });
  protected readonly muted = this.engine.muted;
  protected readonly volumePercent = computed(() =>
    Math.round((this.muted() ? 0 : this.engine.volume()) * 100),
  );
  protected readonly volumeText = computed(() => `${this.volumePercent()}%`);
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

  protected toggle(): void {
    this.engine.toggle();
  }

  /** The phone card takes the cover's colour (lib.js miniPlayer). */
  protected tintOf(title: string): string {
    return coverGradient(title)[0];
  }

  protected mark(): void {
    this.bookmarks.mark();
  }

  /** "1×" in the bar steps to the next speed (the page's pill has the whole menu). */
  protected nextSpeed(): void {
    const at = SPEEDS.indexOf(this.engine.speed() as (typeof SPEEDS)[number]);
    const next = SPEEDS[(at + 1) % SPEEDS.length] ?? 1;
    if (isSpeed(next)) this.preferences.setSpeed(next);
  }

  /** ☾: the timer's dialog; on the player's page, the page's own one (one dialog). */
  protected openSleep(): void {
    if (this.echo()) this.shortcuts.askSleep();
    else this.sleepDialog()?.open();
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

  /**
   * "Fechar o player": stops, saves where it stopped and goes away (AC-11). The focus,
   * which was on the button that goes, moves to the main area (WCAG 2.4.3).
   */
  protected close(): void {
    this.engine.pause();
    if (!this.gone()) this.saver.saveNow();
    this.engine.unload();
    if (this.nowPlayingOpen()) this.rightPanel.close();
    const main = this.host.nativeElement.ownerDocument.querySelector('main');
    if (main) {
      main.tabIndex = -1;
      main.focus();
    }
  }
}
