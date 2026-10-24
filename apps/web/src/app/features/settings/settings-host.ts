import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  inject,
  viewChild,
} from '@angular/core';
import { Onboarding } from './onboarding.js';
import { SettingsPanel } from './settings-panel.js';
import { SettingsStore } from './settings-store.js';

/**
 * The settings dialog over every screen (KBC-007 FR-6): Configurações or the first-run
 * wizard, as a modal <dialog> so the conversation underneath stays as it was.
 */
@Component({
  selector: 'app-settings-host',
  imports: [SettingsPanel, Onboarding],
  template: `
    <dialog
      #dialog
      class="dialog"
      [attr.aria-labelledby]="
        panel() === 'onboarding' ? 'wizard-title' : 'settings-title'
      "
      (close)="closed()"
    >
      @if (panel() === 'settings') {
        <app-settings-panel (closed)="close()" />
      } @else if (panel() === 'onboarding') {
        <app-onboarding (finished)="close()" />
      }
    </dialog>
  `,
  styleUrl: './settings-host.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsHost {
  private readonly store = inject(SettingsStore);
  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly panel = this.store.panel;

  constructor() {
    // The shell loads settings once: the wizard decides from `exists` (BR-5).
    this.store.start();
    afterRenderEffect(() => {
      const dialog = this.dialog().nativeElement;
      const open = this.panel() !== null;
      if (open && !dialog.open) {
        dialog.showModal();
        // Start at the title, so a screen reader announces where the reader is.
        dialog.querySelector<HTMLElement>('h2')?.focus();
      }
      if (!open && dialog.open) dialog.close();
    });
  }

  protected close(): void {
    this.store.close();
  }

  /** Esc or a close(): the panel state follows the dialog. */
  protected closed(): void {
    if (this.panel() !== null) this.store.close();
  }
}
