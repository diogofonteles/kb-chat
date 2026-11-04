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
