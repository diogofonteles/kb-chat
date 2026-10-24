import { Injectable, computed, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { AnswersApi } from '@core/api/answers-api.js';

const usd = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const formatSpend = (value: number): string => usd.format(value);

/** Today's AI spend for the side panel (KBC-005 FR-5); refreshed after every answer. */
@Injectable({ providedIn: 'root' })
export class SpendStore {
  private readonly api = inject(AnswersApi);

  readonly today = rxResource({ stream: () => this.api.spendToday() });
  private readonly value = computed(() =>
    this.today.hasValue() ? this.today.value() : null,
  );
  readonly configured = computed(() => this.value()?.configured ?? true);
  /** "US$ 0,03 de US$ 1,00", or '' while loading or on error. */
  readonly label = computed(() => {
    const spend = this.value();
    return spend
      ? $localize`:@@spend.amount:${formatSpend(spend.usd)}:spent: de ${formatSpend(spend.capUsd)}:cap:`
      : '';
  });

  refresh(): void {
    this.today.reload();
  }
}
