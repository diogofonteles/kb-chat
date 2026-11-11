import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { PreparationStep } from '@kb-chat/contracts';
import { editPagePath } from '@core/media/media-edit-api.js';
import { preparationPagePath } from '@core/media/preparation-api.js';

/** "Preparação parada no passo 3 · Continuar": the way back to the same step (FR-6). */
@Component({
  selector: 'app-preparation-entry',
  imports: [RouterLink],
  template: `
    <span i18n="@@tracks.entry.paused"
      >Preparação parada no passo {{ step() }}</span
    >
    ·
    <a [routerLink]="link()" i18n="@@tracks.entry.continue">Continuar</a>
  `,
  // In a list, the row's title link covers the whole row: this one stays above it.
  styles: `
    :host {
      position: relative;
      z-index: 1;
      color: var(--color-text-muted);
    }

    a {
      display: inline-block;
      padding-block: var(--space-1);
      color: var(--color-accent-strong);
      font-weight: 600;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PreparationEntry {
  readonly mediaId = input.required<string>();
  readonly step = input.required<PreparationStep>();
  protected readonly link = computed(() =>
    this.step() >= 3
      ? editPagePath(this.mediaId())
      : preparationPagePath(this.mediaId()),
  );
}
