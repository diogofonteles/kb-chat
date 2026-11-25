import { formatDate } from '@angular/common';
import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  LOCALE_ID,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  documentRemovalListSchema,
  type DocumentRemoval,
  type DocumentRemovalState,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import {
  DocumentRemovalsApi,
  documentRemovalsUrl,
} from '@core/documents/document-removals-api.js';
import { UiButton, UiPill, type Tone } from '@ui/index.js';
import { finalize, type Observable } from 'rxjs';

/** While the Mac moves something, the list is read again at this pace. */
const REFRESH_MS = 5_000;

const STATES: Record<
  DocumentRemovalState,
  { readonly text: () => string; readonly tone: Tone }
> = {
  removing: {
    text: () => $localize`:@@removed.removing:Fora; o Mac ainda move o arquivo`,
    tone: 'info',
  },
  removed: {
    text: () => $localize`:@@removed.removed:Removido`,
    tone: 'muted',
  },
  restoring: {
    text: () => $localize`:@@removed.restoring:Voltando; espera o Mac`,
    tone: 'info',
  },
  failed: {
    text: () => $localize`:@@removed.failed:Falhou no Mac`,
    tone: 'err',
  },
};

/**
 * "Removidos do acervo" (KBC-187): what masters took out of the collections, by whom and when,
 * and "Trazer de volta". What the Mac has not moved yet says so.
 */
@Component({
  selector: 'app-removed-documents',
  imports: [UiButton, UiPill],
  template: `
    @if (problem(); as message) {
      <p class="error" role="alert">{{ message }}</p>
    }
    @if (removals.error()) {
      <p class="error" role="alert" i18n="@@removed.unread">
        Não consegui ler os removidos. Atualize a página.
      </p>
    } @else if (!removals.hasValue()) {
      <p class="muted" i18n="@@removed.loading">Carregando…</p>
    } @else {
      <p #lead class="muted" tabindex="-1">
        @if (items().length === 0) {
          <span i18n="@@removed.none"
            >Nada removido. Um documento sai do acervo pelo menu ⋯ dele.</span
          >
        } @else {
          <span i18n="@@removed.lead"
            >Fora da busca, da leitura e da Pesquisa com IA. Nada foi
            apagado.</span
          >
        }
      </p>
      <ul class="list">
        @for (one of items(); track one.id) {
          <li class="row">
            <div class="text">
              <p class="title">{{ one.document.title }}</p>
              <p class="meta">
                <span i18n="@@removed.meta"
                  >{{ one.topic }} · {{ one.by }} · {{ when(one) }}</span
                >
              </p>
              @if (one.detail) {
                <p class="detail">{{ one.detail }}</p>
              }
            </div>
            <ui-pill [tone]="stateOf(one).tone">{{
              stateOf(one).text()
            }}</ui-pill>
            <div class="actions">
              @if (one.state === 'failed') {
                <button
                  uiButton="outline"
                  size="sm"
                  type="button"
                  [disabled]="busy()"
                  [attr.aria-label]="retryLabel(one)"
                  (click)="act(api.retry(one.id))"
                >
                  <span i18n="@@removed.retry">Tentar de novo</span>
                </button>
              }
              @if (one.state === 'removed' || one.state === 'removing') {
                <button
                  uiButton="outline"
                  size="sm"
                  type="button"
                  [disabled]="busy()"
                  [attr.aria-label]="restoreLabel(one)"
                  (click)="act(api.restore(one.id))"
                >
                  <span i18n="@@removal.restore">Trazer de volta</span>
                </button>
              }
            </div>
          </li>
        }
      </ul>
    }
  `,
  styleUrl: './removed-documents.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RemovedDocuments {
  private readonly locale = inject(LOCALE_ID);
  private readonly destroyRef = inject(DestroyRef);
  private readonly lead = viewChild<ElementRef<HTMLElement>>('lead');
  protected readonly api = inject(DocumentRemovalsApi);

  protected readonly removals = httpResource(documentRemovalsUrl, {
    parse: (body) => documentRemovalListSchema.parse(body),
  });
  protected readonly items = computed(() =>
    this.removals.hasValue() ? this.removals.value().items : [],
  );
  protected readonly busy = signal(false);
  protected readonly problem = signal('');

  constructor() {
    // The Mac moves it in its own time: what waits for it is read again until it is done.
    effect((onCleanup) => {
      const waits = this.items().some(
        ({ state }) => state === 'removing' || state === 'restoring',
      );
      if (!waits) return;
      const timer = setTimeout(() => this.removals.reload(), REFRESH_MS);
      onCleanup(() => clearTimeout(timer));
    });
  }

  protected stateOf(one: DocumentRemoval) {
    return STATES[one.state];
  }

  protected when(one: DocumentRemoval): string {
    return formatDate(one.removedAt, 'dd/MM/yyyy HH:mm', this.locale);
  }

  protected restoreLabel({ document }: DocumentRemoval): string {
    return $localize`:@@removed.restoreOf:Trazer de volta ${document.title}:title:`;
  }

  protected retryLabel({ document }: DocumentRemoval): string {
    return $localize`:@@removed.retryOf:Tentar de novo ${document.title}:title:`;
  }

  protected act(work: Observable<unknown>): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.problem.set('');
    work
      .pipe(
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => this.settled(),
        error: (err: unknown) => {
          this.problem.set(errorMessage(toUiErrorCode(err)));
          this.removals.reload();
        },
      });
  }

  /** The button pressed is gone: the focus stays in the list. */
  private settled(): void {
    this.lead()?.nativeElement.focus();
    this.removals.reload();
  }
}
