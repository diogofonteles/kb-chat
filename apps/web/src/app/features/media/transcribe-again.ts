import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { MediaItem } from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { MediaApi } from '@core/media/media-api.js';
import { UiButton, UiDialog, UiIcon } from '@ui/index.js';

/**
 * "Transcrever de novo" (KBC-040 FR-3; masters): always a person's click, confirmed, because
 * it takes the Mac for as long as the recording. The text stays until the new version is
 * ready (BR-3), and an attempt that failed says so here.
 */
@Component({
  selector: 'app-transcribe-again',
  imports: [UiButton, UiDialog, UiIcon],
  templateUrl: './transcribe-again.html',
  styleUrl: './transcribe-again.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TranscribeAgain {
  private readonly api = inject(MediaApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly dialog = viewChild.required(UiDialog);
  private readonly cancelButton =
    viewChild<ElementRef<HTMLButtonElement>>('cancelButton');

  readonly media = input.required<MediaItem>();
  readonly queued = output<MediaItem>();
  /** The question closed, however: the page gives the focus back to ⋯ (WCAG 2.4.3). */
  readonly closed = output();

  protected readonly busy = signal(false);
  protected readonly error = signal('');

  /** The question opens on its safe answer. */
  ask(): void {
    this.error.set('');
    this.dialog().open();
    this.focusAfterRender(() => this.cancelButton()?.nativeElement);
  }

  protected confirm(): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.api
      .transcribeAgain(this.media().id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (item) => {
          this.busy.set(false);
          this.queued.emit(item);
          this.dialog().close();
        },
        error: (err: unknown) => {
          this.busy.set(false);
          this.error.set(errorMessage(toUiErrorCode(err)));
          this.focusAfterRender(() => this.cancelButton()?.nativeElement);
        },
      });
  }

  private focusAfterRender(target: () => HTMLElement | undefined): void {
    afterNextRender(() => target()?.focus(), { injector: this.injector });
  }
}
