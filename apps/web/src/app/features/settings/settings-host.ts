import { DOCUMENT, Location } from '@angular/common';
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
    this.readOpenRouterReturn();
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

  /** OpenRouter sent the person back here: open where they were, then clean the address. */
  private readOpenRouterReturn(): void {
    const search = inject(DOCUMENT).defaultView?.location.search ?? '';
    if (!this.store.returnFromOpenRouter(search)) return;
    const location = inject(Location);
    location.replaceState(location.path().split('?')[0] ?? '/');
  }

  protected close(): void {
    this.store.close();
  }

  /**
   * Esc or a close(): the panel state follows the dialog. The event comes in a task of its
   * own, so it may land after the dialog opened again (Pular, then ⚙ at once): then it is old.
   */
  protected closed(): void {
    if (this.panel() !== null && !this.dialog().nativeElement.open)
      this.store.close();
  }
}
