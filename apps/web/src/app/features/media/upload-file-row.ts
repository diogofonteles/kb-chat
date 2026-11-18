import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { UiIcon } from '@ui/icon.js';
import type { Topic } from '@kb-chat/contracts';
import { mediaPagePath } from '@core/media/media-api.js';
import type { UploadEntry } from './upload-entries.js';
import { hasAcceptedAudioExtension } from '@kb-chat/contracts';
import { overQuota, sentOf, sizeOf } from './upload-rules.js';

/** A reader hears a file's progress only at these steps, not at every percent (AC-8). */
const SPOKEN_STEP = 25;

/** One file of the upload panel (screens.md T14, KBC-035): its title and where it stands. */
@Component({
  selector: 'app-upload-file-row',
  imports: [RouterLink, UiIcon],
  templateUrl: './upload-file-row.html',
  styleUrl: './upload-file-row.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UploadFileRow {
  readonly entry = input.required<UploadEntry>();
  /** While the panel sends, nothing on the line changes. */
  readonly locked = input(false);
  readonly submitted = input(false);
  /** The collections' names, for a file that is also in another one. */
  readonly topics = input<readonly Topic[]>([]);
  /** The only file being sent: its card offers "Cancelar envio" (media-upload-sending). */
  readonly cancellable = input(false);
  readonly renamed = output<string>();
  readonly removed = output();
  readonly cancelled = output();

  protected readonly mediaPagePath = mediaPagePath;
  protected topicTitle(slug: string): string {
    return this.topics().find((topic) => topic.slug === slug)?.title ?? slug;
  }
  protected readonly overQuota = overQuota;
  protected readonly offlineNotice = $localize`:@@media.upload.offline:Sem conexão. O envio continua sozinho quando a rede voltar.`;
  protected readonly name = computed(() => this.entry().file.name);
  protected readonly removeLabel = computed(
    () =>
      $localize`:@@media.upload.removeLabel:Tirar ${this.name()}:name: da lista`,
  );
  protected readonly cancelLabel = computed(
    () =>
      $localize`:@@media.upload.cancelLabel:Cancelar o envio de ${this.name()}:name:`,
  );
  /** An audio file shows a note on green; anything else a page on grey. */
  protected readonly audio = computed(() =>
    hasAcceptedAudioExtension(this.name()),
  );
  /** The card's edge: amber when it is already there, red when it cannot go. */
  protected readonly tone = computed((): 'warn' | 'err' | null => {
    const { kind } = this.entry().state;
    if (kind === 'duplicate' || kind === 'duplicate-hidden') return 'warn';
    if (['refused', 'over-quota', 'expired', 'stopped'].includes(kind))
      return 'err';
    return null;
  });
  /** Under the name: the size, "· áudio aceito" once checked, the progress while it goes. */
  protected readonly meta = computed(() => {
    const { file, state } = this.entry();
    if (state.kind === 'sending' && !state.offline)
      return $localize`:@@media.upload.sendingOf:Enviando… ${this.sentText()}:sent:`;
    if (!this.audio()) {
      const dot = file.name.lastIndexOf('.');
      return dot > 0
        ? file.name.slice(dot + 1).toUpperCase()
        : sizeOf(file.size);
    }
    return state.kind === 'ready'
      ? $localize`:@@media.upload.accepted:${sizeOf(file.size)}:size: · áudio aceito`
      : sizeOf(file.size);
  });
  protected readonly progressLabel = computed(
    () =>
      $localize`:@@media.upload.progressLabel:Progresso de ${this.name()}:name:`,
  );
  /** A file that will not go has no title to give. */
  protected readonly hasTitle = computed(
    () =>
      !['refused', 'duplicate', 'duplicate-hidden', 'over-quota'].includes(
        this.entry().state.kind,
      ),
  );
  protected readonly titleLocked = computed(() => {
    const { resumes, state } = this.entry();
    // A new title would replace the item, and the plan it was created with goes with it.
    return this.locked() || resumes || state.kind === 'done';
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
