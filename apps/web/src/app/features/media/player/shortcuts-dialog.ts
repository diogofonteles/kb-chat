import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  output,
  viewChild,
} from '@angular/core';
import { PlayerShortcuts } from './player-shortcuts.js';

interface ShortcutRow {
  readonly keys: readonly string[];
  readonly does: string;
}

/**
 * "Atalhos de teclado" (screens.md T15): every shortcut, each one also a button (UP-09),
 * and "Usar atalhos de uma tecla" to turn them off (WCAG 2.1.4). Esc and "Fechar" close
 * it; the focus goes back to where the person was.
 */
@Component({
  selector: 'app-shortcuts-dialog',
  template: `
    <dialog
      #dialog
      class="dialog"
      aria-labelledby="shortcuts-title"
      (close)="closed.emit()"
    >
      <h2 id="shortcuts-title" i18n="@@player.shortcuts.title">
        Atalhos de teclado
      </h2>
      <label class="switch">
        <input
          type="checkbox"
          [checked]="shortcuts.enabled()"
          (change)="toggle($event)"
        />
        <span i18n="@@player.shortcuts.enable">Usar atalhos de uma tecla</span>
      </label>
      <p class="hint" i18n="@@player.shortcuts.hint">
        Valem na página do player e no mini-player, nunca enquanto você digita.
      </p>
      <dl class="list">
        @for (row of rows; track row.does) {
          <div class="row">
            <dt>
              @for (key of row.keys; track key; let last = $last) {
                <kbd>{{ key }}</kbd>
                @if (!last) {
                  <span class="or" i18n="@@player.shortcuts.or">ou</span>
                }
              }
            </dt>
            <dd>{{ row.does }}</dd>
          </div>
        }
      </dl>
      <button
        type="button"
        class="close"
        (click)="close()"
        i18n="@@player.shortcuts.close"
      >
        Fechar
      </button>
    </dialog>
  `,
  styleUrl: './shortcuts-dialog.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShortcutsDialog {
  protected readonly shortcuts = inject(PlayerShortcuts);
  private readonly document = inject(DOCUMENT);
  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private opener: HTMLElement | null = null;

  readonly closed = output();

  protected readonly rows: readonly ShortcutRow[] = [
    {
      keys: [$localize`:@@player.key.space:Espaço`, 'K'],
      does: $localize`:@@player.shortcut.toggle:Tocar ou pausar`,
    },
    {
      keys: ['J'],
      does: $localize`:@@player.shortcut.back:Voltar 15 segundos`,
    },
    {
      keys: ['L'],
      does: $localize`:@@player.shortcut.forward:Avançar 30 segundos`,
    },
    {
      keys: ['←', '→'],
      does: $localize`:@@player.shortcut.arrows:Voltar ou avançar 5 segundos`,
    },
    {
      keys: ['Shift + ,', 'Shift + .'],
      does: $localize`:@@player.shortcut.speed:Diminuir ou aumentar a velocidade`,
    },
    { keys: ['M'], does: $localize`:@@player.shortcut.mute:Silenciar` },
    {
      keys: ['C'],
      does: $localize`:@@player.shortcut.captions:Ligar ou desligar as legendas`,
    },
    {
      keys: ['B'],
      does: $localize`:@@player.shortcut.bookmark:Marcar este trecho`,
    },
    {
      keys: [$localize`:@@player.key.digits:0 a 9`],
      does: $localize`:@@player.shortcut.tenths:Ir para 0% a 90% da mídia`,
    },
    {
      keys: ['?'],
      does: $localize`:@@player.shortcut.help:Mostrar esta lista`,
    },
  ];

  /** Every way out (Fechar, Esc) gives the focus back to where it was. */
  constructor() {
    this.closed.subscribe(() => this.opener?.focus());
  }

  open(): void {
    const active = this.document.activeElement;
    this.opener = active instanceof HTMLElement ? active : null;
    this.dialog().nativeElement.showModal();
  }

  protected close(): void {
    this.dialog().nativeElement.close();
  }

  protected toggle(event: Event): void {
    if (event.target instanceof HTMLInputElement)
      this.shortcuts.setEnabled(event.target.checked);
  }
}
