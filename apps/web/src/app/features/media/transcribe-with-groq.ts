import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  LOCALE_ID,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  GROQ_MIN_BILLED_MS,
  GROQ_USD_PER_HOUR,
  type MediaItem,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { GroqApi } from '@core/media/groq-api.js';

const HOUR_MS = 3_600_000;

/**
 * "Transcrever com Groq" (KBC-037; masters, with Groq on): sends one item's waiting
 * transcription to Groq now. It costs money, so it asks first, with the estimate; the
 * monthly cap may still refuse it, and then it says so.
 */
@Component({
  selector: 'app-transcribe-with-groq',
  templateUrl: './transcribe-with-groq.html',
  styleUrl: './transcribe-again.css',
  // Where the focus lands when the buttons go away (WCAG 2.4.3).
  host: { tabindex: '-1' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TranscribeWithGroq {
  private readonly api = inject(GroqApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly locale = inject(LOCALE_ID);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly openButton =
    viewChild<ElementRef<HTMLButtonElement>>('openButton');
  private readonly cancelButton =
    viewChild<ElementRef<HTMLButtonElement>>('cancelButton');

  readonly media = input.required<MediaItem>();
  readonly sent = output<MediaItem>();

  protected readonly confirming = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  /** About US$ 0.04 an hour (BR-2): what the month's media spend grows by. */
  protected readonly estimate = computed(() => {
    const ms = Math.max(this.media().durationMs ?? 0, GROQ_MIN_BILLED_MS);
    return new Intl.NumberFormat(this.locale, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Math.max(0.01, (ms / HOUR_MS) * GROQ_USD_PER_HOUR));
  });

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
      .transcribe(this.media().id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (item) => {
          this.busy.set(false);
          this.confirming.set(false);
          this.sent.emit(item);
          // The button goes with the job sent: the focus stays on this place.
          this.focusAfterRender(() => this.host.nativeElement);
        },
        error: (err: unknown) => this.failed(err),
      });
  }

  private failed(err: unknown): void {
    this.busy.set(false);
    const code = toUiErrorCode(err);
    this.error.set(
      code === 'MEDIA_SPEND_CAP'
        ? $localize`:@@groqItem.cap:Teto mensal de mídia atingido. O áudio continua aguardando o transcritor.`
        : errorMessage(code),
    );
    this.focusAfterRender(() => this.cancelButton()?.nativeElement);
  }

  private focusAfterRender(target: () => HTMLElement | undefined): void {
    afterNextRender(() => target()?.focus(), { injector: this.injector });
  }
}
