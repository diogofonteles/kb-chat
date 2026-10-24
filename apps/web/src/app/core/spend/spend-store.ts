import { Injectable, LOCALE_ID, computed, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { AnswersApi } from '@core/api/answers-api.js';

export const formatSpend = (value: number, locale = 'pt-BR'): string =>
  new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);

/** Today's AI spend for the side panel (KBC-005 FR-5); refreshed after every answer. */
@Injectable({ providedIn: 'root' })
export class SpendStore {
  private readonly api = inject(AnswersApi);
  private readonly locale = inject(LOCALE_ID);

  readonly today = rxResource({ stream: () => this.api.spendToday() });
  private readonly value = computed(() =>
    this.today.hasValue() ? this.today.value() : null,
  );
  readonly configured = computed(() => this.value()?.configured ?? true);
  /** "US$ 0,03 de US$ 1,00", or '' while loading or on error. */
  readonly label = computed(() => {
    const spend = this.value();
    return spend
      ? $localize`:@@spend.amount:${formatSpend(spend.usd, this.locale)}:spent: de ${formatSpend(spend.capUsd, this.locale)}:cap:`
      : '';
  });

  /** Reloads now or after `delayMs` (the server records a stopped answer's cost a moment later). */
  refresh(delayMs = 0): void {
    if (delayMs === 0) this.today.reload();
    else setTimeout(() => this.today.reload(), delayMs);
  }
}
