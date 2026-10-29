import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
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
import { formatClock, positionToSecond } from '@kb-chat/player-core';
import { speak } from '@core/i18n/spoken-time.js';
import { MediaEngine } from '@core/media/media-engine.js';
import { PlayerAnnouncer } from '@core/media/player-announcer.js';
import { ProgressSaver } from '@core/media/progress-saver.js';
import { filter, map } from 'rxjs';
import { PlayerShortcuts, SKIP_BACK_MS } from './player-shortcuts.js';

/**
 * The persistent mini-player (screens.md T15, KBC-041 FR-8): while a media plays and the
 * person is anywhere but its page, a bar at the foot of the main area keeps it going, with
 * its title (back to the player), back 15 s, play/pause, a thin progress bar and "Fechar o
 * player". It also holds the player's status region (FR-10), present on every page.
 */
@Component({
  selector: 'app-mini-player',
  imports: [RouterLink],
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
  private readonly saver = inject(ProgressSaver);
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

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly source = this.engine.source;
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
    if (!source) return false;
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

  protected toggle(): void {
    this.engine.toggle();
  }

  protected back(): void {
    this.engine.skip(-SKIP_BACK_MS);
  }

  protected retry(): void {
    this.engine.retry();
  }

  /**
   * "Fechar o player": stops, saves where it stopped and goes away (AC-11). The focus,
   * which was on the button that goes, moves to the main area (WCAG 2.4.3).
   */
  protected close(): void {
    this.engine.pause();
    if (!this.gone()) this.saver.saveNow();
    this.engine.unload();
    const main = this.host.nativeElement.closest('main');
    if (main) {
      main.tabIndex = -1;
      main.focus();
    }
  }
}
