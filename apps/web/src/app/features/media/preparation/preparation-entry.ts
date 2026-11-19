import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { UiPill } from '@ui/pill.js';
import type { PreparationStep } from '@kb-chat/contracts';
import { editPagePath } from '@core/media/media-edit-api.js';
import { preparationPagePath } from '@core/media/preparation-api.js';

/** "Preparação parada no passo 3 · Continuar": the way back to the same step (FR-6). */
@Component({
  selector: 'app-preparation-entry',
  imports: [RouterLink, UiPill],
  template: `
    @if (look() === 'pill') {
      <!-- The album's table (v2 · media-list): the step in a pill, "Continuar" beside it. -->
      <ui-pill tone="info" i18n="@@tracks.entry.pausedPill"
        >Parada no passo {{ step() }}</ui-pill
      >
      <a class="pill-link" [routerLink]="link()" i18n="@@tracks.entry.continue"
        >Continuar</a
      >
    } @else if (look() === 'step') {
      <!-- A phone's line (v2 · media-list@mobile): the step alone, itself the way on. -->
      <a class="step-link" [routerLink]="link()"
        ><ui-pill tone="info" i18n="@@library.pausedStep"
          >Passo {{ step() }}</ui-pill
        ><span class="visually-hidden" i18n="@@tracks.entry.continue"
          >Continuar</span
        ></a
      >
    } @else {
      <span i18n="@@tracks.entry.paused"
        >Preparação parada no passo {{ step() }}</span
      >
      ·
      <a [routerLink]="link()" i18n="@@tracks.entry.continue">Continuar</a>
    }
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

    :host:has(ui-pill) {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
    }

    a.step-link {
      display: inline-flex;
      padding: 0;
      text-decoration: none;
    }

    a.pill-link {
      color: var(--color-text);
      font-size: var(--text-meta);
      font-weight: 700;
      text-decoration: underline;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PreparationEntry {
  readonly mediaId = input.required<string>();
  readonly step = input.required<PreparationStep>();
  /** As a line ("Preparação parada no passo 2 · Continuar"), a pill and its link, or the step alone. */
  readonly look = input<'line' | 'pill' | 'step'>('line');
  protected readonly link = computed(() =>
    this.step() >= 3
      ? editPagePath(this.mediaId())
      : preparationPagePath(this.mediaId()),
  );
}
