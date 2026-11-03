import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { formatClock } from '@kb-chat/player-core';
import { ActAsApi, RESTART_APP } from '@core/auth/act-as-api.js';
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
  private readonly now = signal(Date.now());

  protected readonly acting = computed(
    () => this.session.me()?.actingAs ?? null,
  );
  protected readonly personName = computed(() => {
    const person = this.acting()?.person;
    return person ? person.name || person.email : '';
  });
  private readonly remainingMs = computed(() => {
    const acting = this.acting();
    return acting ? Math.max(0, Date.parse(acting.endsAt) - this.now()) : 0;
  });
  protected readonly left = computed(() =>
    formatClock(Math.ceil(this.remainingMs() / 1000) * 1000),
  );
  /** Said once as it starts, once a minute before the end (not every second). */
  protected readonly said = computed(() => {
    if (!this.acting()) return '';
    return this.remainingMs() <= ONE_MINUTE_MS
      ? $localize`:@@acting.lastMinute:Falta 1 minuto para voltar à sua conta.`
      : $localize`:@@acting.started:Você está vendo como ${this.personName()}:name:.`;
  });
  protected readonly busy = signal(false);

  constructor() {
    interval(1_000)
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        this.now.set(Date.now());
        // The server ended it too: the next request is the master's own again.
        if (this.acting() && this.remainingMs() === 0) this.restart();
      });
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
