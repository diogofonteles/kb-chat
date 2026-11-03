import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  output,
  viewChild,
} from '@angular/core';
import { formatClock } from '@kb-chat/player-core';
import {
  SilenceSkipper,
  type SilenceMapState,
} from '@core/media/silence-skipper.js';

const measuring = () =>
  $localize`:@@silences.pending:Os silêncios desta mídia ainda estão sendo medidos.`;

const MAP_NOTES: Record<Exclude<SilenceMapState, 'ready'>, () => string> = {
  loading: measuring,
  pending: measuring,
  none: () => $localize`:@@silences.none:Esta mídia não tem pausas longas.`,
  unavailable: () =>
    $localize`:@@silences.unavailable:Não consegui ler os silêncios desta mídia agora.`,
};

/**
 * "Encurtar silêncios" (screens.md T15, KBC-044): a checkbox, applied at once and kept on
 * the account for every media and device, and the time saved in this media. Esc and
 * "Fechar" close it; the focus goes back to where it was.
 */
@Component({
  selector: 'app-silences-dialog',
  template: `
    <dialog
      #dialog
      class="dialog"
      aria-labelledby="silences-title"
      (close)="closed.emit()"
    >
      <h2 id="silences-title" i18n="@@silences.title">Encurtar silêncios</h2>
      <label class="choice">
        <input
          #toggle
          type="checkbox"
          aria-describedby="silences-hint"
          [checked]="skipper.enabled()"
          (change)="choose($event)"
        />
        <span i18n="@@silences.option">Encurtar silêncios</span>
      </label>
      <p id="silences-hint" class="hint" i18n="@@silences.hint">
        Pausas de 1 segundo ou mais passam a durar 0,3 segundo. A barra e os
        tempos continuam no tempo original da mídia.
      </p>
      <p class="saved" role="status">{{ note() }}</p>
      <button
        type="button"
        class="close"
        (click)="close()"
        i18n="@@silences.close"
      >
        Fechar
      </button>
    </dialog>
  `,
  styleUrls: ['./player-dialog.css', './silences-dialog.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SilencesDialog {
  protected readonly skipper = inject(SilenceSkipper);
  private readonly document = inject(DOCUMENT);
  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly toggle =
    viewChild.required<ElementRef<HTMLInputElement>>('toggle');
  private opener: HTMLElement | null = null;

  readonly closed = output();

  /** The time saved in this media, or why there is none to save. */
  protected readonly note = computed(() => {
    const state = this.skipper.mapState();
    if (state !== 'ready') return MAP_NOTES[state]();
    const saved = formatClock(this.skipper.savedMs());
    return $localize`:@@silences.saved:Tempo economizado nesta mídia: ${saved}:saved:`;
  });

  /** Every way out (Fechar, Esc) gives the focus back to where it was. */
  constructor() {
    this.closed.subscribe(() => this.opener?.focus());
  }

  open(): void {
    const active = this.document.activeElement;
    this.opener = active instanceof HTMLElement ? active : null;
    this.dialog().nativeElement.showModal();
    this.toggle().nativeElement.focus();
  }

  protected close(): void {
    this.dialog().nativeElement.close();
  }

  protected choose(event: Event): void {
    if (event.target instanceof HTMLInputElement)
      this.skipper.setEnabled(event.target.checked);
  }
}
