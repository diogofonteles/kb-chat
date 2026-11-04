import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { mediaPagePath } from '@core/media/media-api.js';
import type { UploadEntry } from './upload-entries.js';
import { overQuota, sentOf } from './upload-rules.js';

/** A reader hears a file's progress only at these steps, not at every percent (AC-8). */
const SPOKEN_STEP = 25;

/** One file of the upload panel (screens.md T14, KBC-035): its title and where it stands. */
@Component({
  selector: 'app-upload-file-row',
  imports: [RouterLink],
  templateUrl: './upload-file-row.html',
  styleUrl: './upload-file-row.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UploadFileRow {
  readonly entry = input.required<UploadEntry>();
  /** While the panel sends, nothing on the line changes. */
  readonly locked = input(false);
  readonly submitted = input(false);
  readonly renamed = output<string>();
  readonly removed = output();

  protected readonly mediaPagePath = mediaPagePath;
  protected readonly overQuota = overQuota;
  protected readonly offlineNotice = $localize`:@@media.upload.offline:Sem conexão. O envio continua sozinho quando a rede voltar.`;
  protected readonly name = computed(() => this.entry().file.name);
  protected readonly removeLabel = computed(
    () =>
      $localize`:@@media.upload.removeLabel:Tirar ${this.name()}:name: da lista`,
  );
  protected readonly progressLabel = computed(
    () =>
      $localize`:@@media.upload.progressLabel:Progresso de ${this.name()}:name:`,
  );
  /** A file that will not go has no title to give. */
  protected readonly hasTitle = computed(
    () =>
      !['refused', 'duplicate', 'over-quota'].includes(this.entry().state.kind),
  );
  protected readonly titleLocked = computed(() => {
    const { kind } = this.entry().state;
    return this.locked() || kind === 'resume' || kind === 'done';
  });
  protected readonly titleMissing = computed(
    () =>
      this.submitted() && this.hasTitle() && !this.entry().title.trim().length,
  );
  protected readonly canRemove = computed(
    () => !this.locked() && this.entry().state.kind !== 'done',
  );
  protected readonly percent = computed(() => {
    const { state } = this.entry();
    if (state.kind !== 'sending' || state.total === 0) return 0;
    return Math.floor((state.loaded / state.total) * 100);
  });
  protected readonly sentText = computed(() => {
    const { state } = this.entry();
    return state.kind === 'sending' ? sentOf(state.loaded, state.total) : '';
  });
  protected readonly resumedText = computed(() => {
    const { state } = this.entry();
    return state.kind === 'resume'
      ? sentOf(state.offset, this.entry().file.size)
      : '';
  });
  /** The line a screen reader hears; it changes only at each step, per file. */
  protected readonly spoken = computed(() => {
    const { state } = this.entry();
    const name = this.name();
    if (state.kind === 'done')
      return $localize`:@@media.upload.spokenDone:${name}:name: enviado.`;
    if (state.kind !== 'sending') return '';
    if (state.offline) return this.offlineNotice;
    const step = Math.floor(this.percent() / SPOKEN_STEP) * SPOKEN_STEP;
    return $localize`:@@media.upload.spokenProgress:${name}:name:: ${step}:percent:% enviado.`;
  });

  protected rename(event: Event): void {
    const { target } = event;
    if (target instanceof HTMLInputElement) this.renamed.emit(target.value);
  }
}
