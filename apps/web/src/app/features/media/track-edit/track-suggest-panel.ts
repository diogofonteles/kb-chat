import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  LOCALE_ID,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type {
  ProposalEstimate,
  SuggestedSubject,
  TrackSuggestion,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { TrackRevisionsApi } from '@core/media/track-revisions-api.js';

/** One line of a suggestion, for who decides what stays. */
export type SuggestionUse =
  | { readonly field: 'title' | 'summary'; readonly value: string }
  | { readonly field: 'subject'; readonly subject: SuggestedSubject };

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'estimating' }
  | { readonly kind: 'estimated'; readonly estimate: ProposalEstimate }
  | { readonly kind: 'running' }
  | { readonly kind: 'done'; readonly suggestion: TrackSuggestion }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * "Sugerir de novo com IA" (KBC-073 FR-7): the cost before anything is spent, and each line waits
 * for a person; nothing changes until "Usar" and "Salvar" (BR-9).
 */
@Component({
  selector: 'app-track-suggest-panel',
  template: `
    <section class="suggest" aria-labelledby="track-suggest-title">
      <h3 id="track-suggest-title" i18n="@@trackEdit.suggest">
        Sugerir de novo com IA
      </h3>
      @switch (phase().kind) {
        @case ('idle') {
          <button
            type="button"
            class="secondary"
            (click)="estimate()"
            i18n="@@trackEdit.suggest.see"
          >
            Ver quanto custa
          </button>
        }
        @case ('estimating') {
          <p class="note" role="status" i18n="@@trackEdit.loading">
            Carregando…
          </p>
        }
        @case ('estimated') {
          <p i18n="@@trackEdit.suggest.cost">Custa cerca de {{ cost() }}.</p>
          @if (refused()) {
            <p class="error" i18n="@@trackEdit.suggest.cap">
              O teto mensal da mídia foi atingido.
            </p>
          } @else {
            <button
              type="button"
              class="primary"
              (click)="run()"
              i18n="@@trackEdit.suggest.confirm"
            >
              Confirmar e sugerir
            </button>
          }
        }
        @case ('running') {
          <p class="note" role="status" i18n="@@trackEdit.suggest.running">
            Sugerindo…
          </p>
        }
        @case ('failed') {
          <p class="error" role="alert">{{ failure() }}</p>
          <button
            type="button"
            class="secondary"
            (click)="estimate()"
            i18n="@@trackEdit.retry"
          >
            Tentar de novo
          </button>
        }
        @case ('done') {
          @if (suggestion(); as found) {
            <p class="note" role="status" i18n="@@trackEdit.suggest.done">
              Nada mudou ainda: escolha o que usar.
            </p>
            <ul>
              @if (found.title; as title) {
                <li>
                  <span>{{ title }}</span>
                  <button
                    type="button"
                    class="secondary"
                    [attr.aria-label]="useLabel(title)"
                    (click)="use.emit({ field: 'title', value: title })"
                    i18n="@@trackEdit.suggest.use"
                  >
                    Usar
                  </button>
                </li>
              }
              @if (found.summary; as summary) {
                <li>
                  <span>{{ summary }}</span>
                  <button
                    type="button"
                    class="secondary"
                    [attr.aria-label]="useLabel(summary)"
                    (click)="use.emit({ field: 'summary', value: summary })"
                    i18n="@@trackEdit.suggest.use"
                  >
                    Usar
                  </button>
                </li>
              }
              @if (classifies()) {
                @for (subject of found.subjects; track subject.name) {
                  <li>
                    <span>{{ subject.name }}</span>
                    <button
                      type="button"
                      class="secondary"
                      [attr.aria-label]="useLabel(subject.name)"
                      (click)="use.emit({ field: 'subject', subject })"
                      i18n="@@trackEdit.suggest.use"
                    >
                      Usar
                    </button>
                  </li>
                }
              }
            </ul>
          }
        }
      }
    </section>
  `,
  styleUrl: './track-edit.css',
  styles: `
    .suggest {
      display: grid;
      gap: var(--space-2);
      justify-items: start;
      margin-bottom: var(--space-4);
      padding: var(--space-3);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
    }
    h3 {
      margin: 0;
      font-size: var(--text-base, 1rem);
    }
    p {
      margin: 0;
    }
    ul {
      display: grid;
      gap: var(--space-2);
      width: 100%;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
    }
    li span {
      flex: 1 1 12rem;
      min-width: 0;
      overflow-wrap: anywhere;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrackSuggestPanel {
  private readonly api = inject(TrackRevisionsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly locale = inject(LOCALE_ID);

  readonly mediaId = input.required<string>();
  readonly classifies = input(false);
  readonly use = output<SuggestionUse>();

  protected readonly phase = signal<Phase>({ kind: 'idle' });
  protected readonly cost = computed(() => {
    const phase = this.phase();
    return phase.kind === 'estimated'
      ? new Intl.NumberFormat(this.locale, {
          style: 'currency',
          currency: 'USD',
          maximumFractionDigits: 4,
        }).format(phase.estimate.estimateUsd)
      : '';
  });
  protected readonly refused = computed(() => {
    const phase = this.phase();
    return phase.kind === 'estimated' && !phase.estimate.allowed;
  });
  protected readonly failure = computed(() => {
    const phase = this.phase();
    return phase.kind === 'failed' ? phase.message : '';
  });
  protected readonly suggestion = computed(() => {
    const phase = this.phase();
    return phase.kind === 'done' ? phase.suggestion : null;
  });

  protected useLabel(value: string): string {
    return $localize`:@@trackEdit.suggest.useLabel:Usar a sugestão ${value}:value:`;
  }

  protected estimate(): void {
    this.phase.set({ kind: 'estimating' });
    this.api
      .estimate(this.mediaId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (estimate) => this.phase.set({ kind: 'estimated', estimate }),
        error: (err: unknown) => this.fail(err),
      });
  }

  protected run(): void {
    this.phase.set({ kind: 'running' });
    this.api
      .suggest(this.mediaId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (suggestion) => this.phase.set({ kind: 'done', suggestion }),
        error: (err: unknown) => this.fail(err),
      });
  }

  private fail(err: unknown): void {
    this.phase.set({
      kind: 'failed',
      message: errorMessage(toUiErrorCode(err)),
    });
  }
}
