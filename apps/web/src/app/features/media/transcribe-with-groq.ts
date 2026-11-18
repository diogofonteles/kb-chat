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
import { UiButton, UiDialog } from '@ui/index.js';
import { GroqApi } from '@core/media/groq-api.js';

const HOUR_MS = 3_600_000;
let nextId = 0;

/** What the offer reads: the media page's item, or the queue's line (KBC-128 AC-2). */
export type GroqCandidate = Pick<MediaItem, 'id' | 'durationMs' | 'canUseGroq'>;

/**
 * "Transcrever com Groq" (KBC-037; masters, with Groq on): sends one item's waiting
 * transcription to Groq now. It costs money, so it asks first, with the estimate; the
 * monthly cap may still refuse it, and then it says so.
 */
@Component({
  selector: 'app-transcribe-with-groq',
  templateUrl: './transcribe-with-groq.html',
  imports: [UiButton, UiDialog],
  styleUrl: './transcribe-with-groq.css',
  // Where the focus lands when the buttons go away (WCAG 2.4.3).
  host: {
    tabindex: '-1',
    '[class.compact]': 'compact()',
    '[class.in-menu]': 'inMenu()',
  },
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

  readonly media = input.required<GroqCandidate>();
  /** The audio's title, when the offer stands among others (the library's cards). */
  readonly subject = input('');
  /** A card's action (the library's "Precisa da sua atenção"): a pill, small type. */
  readonly compact = input(false);
  /**
   * Asked from the player's ⋯ (v2, KBC-129): no button of its own; the question is a modal
   * (a sheet on a phone), and `closed` hands the focus back to ⋯.
   */
  readonly inMenu = input(false);
  readonly closed = output();
  private readonly dialog = viewChild(UiDialog);
  readonly sent = output<MediaItem>();
  /** The cap refused it: the item is now held, and the page reads it again. */
  readonly capped = output();

  /** The library may show several offers at once: each question has its own id. */
  protected readonly questionId = `groq-item-question-${++nextId}`;
  protected readonly openLabel = computed(() => {
    const subject = this.subject();
    return subject
      ? $localize`:@@groqItem.openFor:Transcrever com Groq: ${subject}:title:`
      : null;
  });
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

  ask(): void {
    this.confirming.set(true);
    this.error.set('');
    if (this.inMenu()) this.dialog()?.open();
    this.focusAfterRender(() => this.cancelButton()?.nativeElement);
  }

  /** The modal closed, however (✕, Cancelar, Escape). */
  protected dialogClosed(): void {
    this.confirming.set(false);
    this.closed.emit();
  }

  protected cancel(): void {
    this.confirming.set(false);
    this.dialog()?.close();
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
          this.dialog()?.close();
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
    if (code !== 'MEDIA_SPEND_CAP') {
      this.error.set(errorMessage(code));
      return this.focusAfterRender(() => this.cancelButton()?.nativeElement);
    }
    this.error.set(
      $localize`:@@groqItem.cap:Teto mensal de mídia atingido. O áudio continua aguardando o transcritor.`,
    );
    // Asking again would meet the same cap: the question closes, the focus stays here.
    this.confirming.set(false);
    this.dialog()?.close();
    this.capped.emit();
    this.focusAfterRender(() => this.host.nativeElement);
  }

  private focusAfterRender(target: () => HTMLElement | undefined): void {
    afterNextRender(() => target()?.focus(), { injector: this.injector });
  }
}
