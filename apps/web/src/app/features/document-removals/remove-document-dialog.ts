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
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { DocumentRemovalsApi } from '@core/documents/document-removals-api.js';
import { UiButton, UiDialog } from '@ui/index.js';
import { finalize, type Observable } from 'rxjs';

/**
 * "Remover do acervo" (KBC-187 BR-4): names the document and the collection, says what happens
 * and that it can come back, and once it is done offers to bring it back right there.
 */
@Component({
  selector: 'app-remove-document-dialog',
  imports: [UiButton, UiDialog],
  template: `
    <ui-dialog
      #dialog
      titleId="remove-document-title"
      [title]="heading"
      [width]="480"
      (closed)="left()"
    >
      @if (removalId()) {
        <p #done class="text" tabindex="-1" role="status">
          <span i18n="@@removal.done"
            >“{{ title() }}” saiu do acervo {{ collection() }}. Você o traz de
            volta em Configurações, em “Removidos do acervo”.</span
          >
        </p>
      } @else {
        <p class="text">
          <span i18n="@@removal.what"
            >“{{ title() }}” sai do acervo {{ collection() }} agora: some da
            busca, da leitura e da Pesquisa com IA, para todos.</span
          >
        </p>
        <p class="text">
          <span i18n="@@removal.kept"
            >Nada é apagado: ele vai para a quarentena do acervo, e você pode
            trazê-lo de volta.</span
          >
        </p>
      }
      @if (failure(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }
      <div uiDialogFooter class="actions">
        @if (removalId(); as id) {
          <button
            uiButton="ghost"
            type="button"
            [disabled]="busy()"
            (click)="bringBack(id)"
          >
            <span i18n="@@removal.restore">Trazer de volta</span>
          </button>
          <button uiButton="white" type="button" (click)="close()">
            <span i18n="@@removal.close">Concluir</span>
          </button>
        } @else {
          <button uiButton="ghost" type="button" (click)="close()">
            <span i18n="@@removal.cancel">Cancelar</span>
          </button>
          <button
            uiButton="danger"
            type="button"
            [disabled]="busy()"
            (click)="remove()"
          >
            <span i18n="@@removal.confirm">Remover do acervo</span>
          </button>
        }
      </div>
    </ui-dialog>
  `,
  styles: `
    .text {
      margin: 0;
      color: var(--color-text-muted);
      font-size: var(--text-sm);
      line-height: 1.5;
      overflow-wrap: anywhere;
    }

    .error {
      margin: 0;
      color: var(--color-danger);
      font-size: var(--text-sm);
    }

    .actions {
      display: contents;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RemoveDocumentDialog {
  private readonly api = inject(DocumentRemovalsApi);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialog = viewChild.required<UiDialog>('dialog');
  private readonly done = viewChild<ElementRef<HTMLElement>>('done');

  readonly topic = input.required<string>();
  readonly documentId = input.required<string>();
  readonly title = input.required<string>();
  /** The collection's name, as the person knows it. */
  readonly collection = input.required<string>();
  /** Closed with the document out of the collection. */
  readonly removed = output();

  protected readonly heading = $localize`:@@removal.title:Remover do acervo`;
  protected readonly busy = signal(false);
  protected readonly failure = signal('');
  /** Out of the collection: what brings it back. */
  protected readonly removalId = signal<string | null>(null);

  open(): void {
    this.failure.set('');
    this.removalId.set(null);
    this.dialog().open();
  }

  protected close(): void {
    this.dialog().close();
  }

  protected left(): void {
    if (this.removalId() !== null) this.removed.emit();
  }

  protected remove(): void {
    this.act(this.api.remove(this.topic(), this.documentId()), ({ id }) => {
      this.removalId.set(id);
      afterNextRender(() => this.done()?.nativeElement.focus(), {
        injector: this.injector,
      });
    });
  }

  protected bringBack(id: string): void {
    this.act(this.api.restore(id), () => {
      this.removalId.set(null);
      this.close();
    });
  }

  private act<T>(work: Observable<T>, then: (answer: T) => void): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.failure.set('');
    work
      .pipe(
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: then,
        error: (err: unknown) =>
          this.failure.set(errorMessage(toUiErrorCode(err))),
      });
  }
}
