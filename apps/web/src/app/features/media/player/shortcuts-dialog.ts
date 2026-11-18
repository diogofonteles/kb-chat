import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  output,
  viewChild,
} from '@angular/core';
import { UiButton, UiDialog } from '@ui/index.js';
import { PlayerShortcuts } from './player-shortcuts.js';

interface ShortcutRow {
  readonly keys: readonly string[];
  readonly does: string;
}

/**
 * "Atalhos de teclado" (screens.md T15): every shortcut, each one also a button (UP-09),
 * and the "Usar atalhos de uma tecla" switch to turn them off (WCAG 2.1.4). Esc, ✕ and
 * "Fechar" close it; the focus goes back to where the person was.
 */
@Component({
  selector: 'app-shortcuts-dialog',
  imports: [UiButton, UiDialog],
  template: `
    <!-- v2 modal (player.js over 'keys'): ✕, the switch with its hint, a line, the keys
         beside what they do and "Fechar" on the right; a sheet on a phone. -->
    <ui-dialog
      #dialog
      title="Atalhos de teclado"
      i18n-title="@@player.shortcuts.title"
      titleId="shortcuts-title"
      [width]="600"
      [short]="true"
      (closed)="closed.emit()"
    >
      <div class="setting">
        <div class="setting-words">
          <p id="shortcuts-enable" class="setting-name">
            <span i18n="@@player.shortcuts.enable"
              >Usar atalhos de uma tecla</span
            ><span class="phone-only" i18n="@@player.shortcuts.connected">
              (teclado conectado)</span
            >
          </p>
          <p id="shortcuts-hint" class="hint" i18n="@@player.shortcuts.hint">
            Valem na página do player e no mini-player, nunca enquanto você
            digita.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          class="switch"
          aria-labelledby="shortcuts-enable"
          aria-describedby="shortcuts-hint"
          [attr.aria-checked]="shortcuts.enabled()"
          (click)="shortcuts.setEnabled(!shortcuts.enabled())"
        >
          <span class="knob" aria-hidden="true"></span>
        </button>
      </div>
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
      <div uiDialogFooter class="footer">
        <button
          uiButton="ghost"
          type="button"
          class="close"
          (click)="close()"
          i18n="@@player.shortcuts.close"
        >
          Fechar
        </button>
      </div>
    </ui-dialog>
  `,
  styleUrl: './shortcuts-dialog.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShortcutsDialog {
  protected readonly shortcuts = inject(PlayerShortcuts);
  private readonly document = inject(DOCUMENT);
  private readonly dialog = viewChild.required(UiDialog);
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
    this.dialog().open();
  }

  protected close(): void {
    this.dialog().close();
  }
}
