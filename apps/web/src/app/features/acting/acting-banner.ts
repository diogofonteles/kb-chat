import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { formatClock } from '@kb-chat/player-core';
import { ActAsApi, RESTART_APP, VIEW_CHANNEL } from '@core/auth/act-as-api.js';
import { SessionStore } from '@core/auth/session-store.js';
import { interval } from 'rxjs';

/** The last minute is said once, so nobody is surprised by the end. */
const ONE_MINUTE_MS = 60_000;

/**
 * While a master acts as a person (KBC-060 FR-5, ADR 0027): a fixed band on every page with
 * whose view it is, the time left and "Voltar para a minha conta". It is said to screen
 * readers as it starts and a minute before the end; at the end the app goes back to the
 * master's own view.
 */
@Component({
  selector: 'app-acting-banner',
  template: `
    @if (acting(); as current) {
      <div class="band">
        <p class="what">
          <span i18n="@@acting.as"
            >Você está vendo como <strong>{{ personName() }}</strong></span
          >
          <span class="time" i18n="@@acting.endsIn"
            >termina em {{ left() }}</span
          >
        </p>
        <button
          type="button"
          [disabled]="busy()"
          (click)="back()"
          i18n="@@acting.back"
        >
          Voltar para a minha conta
        </button>
      </div>
    }
    <p class="visually-hidden" role="status">{{ said() }}</p>
  `,
  styleUrl: './acting-banner.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ActingBanner {
  private readonly session = inject(SessionStore);
  private readonly api = inject(ActAsApi);
  private readonly restart = inject(RESTART_APP);
  /** The monotonic clock: the browser's wall clock may be off from the server's. */
  private readonly clock = () => performance.now();
  private readonly now = signal(this.clock());
  /** When /me said how much was left, on the monotonic clock. */
  private readonly receivedAt = signal(this.clock());

  protected readonly acting = computed(
    () => this.session.me()?.actingAs ?? null,
  );
  protected readonly personName = computed(() => {
    const person = this.acting()?.person;
    return person ? person.name || person.email : '';
  });
  private readonly remainingMs = computed(() => {
    const acting = this.acting();
    if (!acting) return 0;
    return Math.max(0, acting.remainingMs - (this.now() - this.receivedAt()));
  });
  protected readonly left = computed(() =>
    formatClock(Math.ceil(this.remainingMs() / 1000) * 1000),
  );
  /** Empty until the band is on screen, so screen readers announce what comes in. */
  private readonly shown = signal(false);
  /** Said once as it starts, once a minute before the end (not every second). */
  protected readonly said = computed(() => {
    if (!this.acting() || !this.shown()) return '';
    return this.remainingMs() <= ONE_MINUTE_MS
      ? $localize`:@@acting.lastMinute:Falta 1 minuto para voltar à sua conta.`
      : $localize`:@@acting.started:Você está vendo como ${this.personName()}:name:.`;
  });
  protected readonly busy = signal(false);

  constructor() {
    effect(() => {
      // A new answer from /me restarts the countdown from what the server said.
      this.acting();
      this.receivedAt.set(this.clock());
      this.now.set(this.clock());
    });
    this.listenToOtherTabs();
    interval(1_000)
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        this.shown.set(true);
        this.now.set(this.clock());
        // The server ended it too: the next request is the master's own again.
        if (this.acting() && this.remainingMs() === 0) this.restart();
      });
  }

  /** Another tab started or ended acting: this one follows (no tab writes as the other). */
  private listenToOtherTabs(): void {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(VIEW_CHANNEL);
    const view = inject(DOCUMENT).defaultView;
    channel.onmessage = () => view?.location.assign('/');
    inject(DestroyRef).onDestroy(() => channel.close());
  }

  protected back(): void {
    this.busy.set(true);
    this.api.stop().subscribe({
      next: () => this.restart(),
      // Already over on the server (time, access): the master's view is back anyway.
      error: () => this.restart(),
    });
  }
}
