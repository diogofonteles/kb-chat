import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { SettingsStore } from './settings-store.js';

/** The fixed ⚙ "Configurações" entry (KBC-007 FR-6), in the side panel and the phone menu. */
@Component({
  selector: 'app-settings-button',
  template: `
    <button
      type="button"
      class="settings-button"
      aria-haspopup="dialog"
      (click)="open()"
    >
      <span class="icon" aria-hidden="true">⚙</span>
      <span i18n="@@settings.open">Configurações</span>
    </button>
  `,
  styles: `
    .settings-button {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      width: 100%;
      min-height: var(--target);
      padding: 0 var(--space-3);
      border: 0;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--color-text);
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .settings-button:hover {
      background: var(--sidebar-active, var(--color-surface-muted));
    }
    .icon {
      font-size: 1.125rem;
      color: var(--color-text-muted);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsButton {
  private readonly store = inject(SettingsStore);

  protected open(): void {
    this.store.openSettings();
  }
}
