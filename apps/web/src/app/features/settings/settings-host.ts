import { DOCUMENT, Location } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  inject,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { Onboarding } from './onboarding.js';
import { SettingsStore } from './settings-store.js';

/**
 * The first-run wizard over every screen (KBC-007 FR-1, KBC-131 FR-4): a full-screen modal
 * <dialog>, so the app underneath stays as it was. Configurações itself is a page now.
 */
@Component({
  selector: 'app-settings-host',
  imports: [Onboarding],
  template: `
    <dialog
      #dialog
      class="dialog"
      aria-labelledby="wizard-title"
      (close)="closed()"
    >
      @if (panel() === 'onboarding') {
        <app-onboarding (finished)="finish()" />
      }
    </dialog>
  `,
  styleUrl: './settings-host.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsHost {
  private readonly store = inject(SettingsStore);
  private readonly router = inject(Router);
  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly panel = this.store.panel;
  /** The host closed the dialog and its "close" event has not come yet. */
  private closing = false;

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
        dialog.querySelector<HTMLElement>('h1, h2')?.focus();
      }
      if (!open && dialog.open) {
        // Its "close" event is this host's echo, not the person's: `closed()` lets it go.
        this.closing = true;
        dialog.close();
      }
    });
  }

  /** OpenRouter sent the person back here: open where they were, then clean the address. */
  private readOpenRouterReturn(): void {
    const search = inject(DOCUMENT).defaultView?.location.search ?? '';
    if (!this.store.returnFromOpenRouter(search)) return;
    const location = inject(Location);
    location.replaceState(location.path().split('?')[0] ?? '/');
  }

  /** Pular or Concluir (KBC-131 AC-6): reopened from Configurações, the app opens at home. */
  protected finish(): void {
    this.store.close();
    if (this.router.url.startsWith('/configuracoes'))
      void this.router.navigateByUrl('/');
  }

  /**
   * Esc or a close(): the panel state follows the dialog. The event comes in a task of its
   * own, so the one the host caused may land after a new opening was asked for (Pular, then ⚙
   * at once), even before a render opened the dialog: that one is never the person's.
   */
  protected closed(): void {
    if (this.closing) {
      this.closing = false;
      return;
    }
    if (this.panel() !== null && !this.dialog().nativeElement.open)
      this.store.close();
  }
}
