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

/**
 * "Transcrever de novo" (KBC-040 FR-3; masters): always a person's click, confirmed, because
 * it takes the Mac for as long as the recording. The text stays until the new version is
 * ready (BR-3), and an attempt that failed says so here.
 */
@Component({
  selector: 'app-transcribe-again',
  templateUrl: './transcribe-again.html',
  styleUrl: './transcribe-again.css',
  // Where the focus lands when the buttons go away (WCAG 2.4.3).
  host: { tabindex: '-1' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TranscribeAgain {
  private readonly api = inject(MediaApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly openButton =
    viewChild<ElementRef<HTMLButtonElement>>('openButton');
  private readonly cancelButton =
    viewChild<ElementRef<HTMLButtonElement>>('cancelButton');

  readonly media = input.required<MediaItem>();
  readonly queued = output<MediaItem>();

  protected readonly confirming = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  /** The question opens on its safe answer. */
  protected ask(): void {
    this.confirming.set(true);
    this.error.set('');
    this.focusAfterRender(() => this.cancelButton()?.nativeElement);
  }

  protected cancel(): void {
    this.confirming.set(false);
    this.focusAfterRender(() => this.openButton()?.nativeElement);
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
          this.confirming.set(false);
          this.queued.emit(item);
          this.focusAfterRender(
            () => this.openButton()?.nativeElement ?? this.host.nativeElement,
          );
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
