import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  untracked,
} from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type {
  AnswerEvent,
  AnswerSource,
  DocumentRef,
  SearchFilters,
  SearchMode,
} from '@kb-chat/contracts';
import { AnswersApi } from '@core/api/answers-api.js';
import { SpendStore } from '@core/spend/spend-store.js';
import {
  errorMessage,
  toUiErrorCode,
  type UiErrorCode,
} from '@core/api/api-error.js';
import type { Subscription } from 'rxjs';
import {
  citedSource,
  formatCost,
  formatEstimate,
  isInsufficient,
  renderAnswer,
} from './answer-format.js';
import { describeFilters } from './filters-summary.js';

const STOP_SETTLE_MS = 1000;

interface AnswerRun {
  readonly phase: 'idle' | 'streaming' | 'done' | 'error';
  readonly text: string;
  readonly sources: readonly AnswerSource[];
  readonly usd: number | null;
  readonly interrupted: boolean;
  readonly error: UiErrorCode | null;
}

/** Wording specific to answers (screens.md T4) where the generic API message would mislead. */
const AI_MESSAGES: Partial<Record<UiErrorCode, () => string>> = {
  INTERNAL: () => $localize`:@@ai.failed:Não consegui gerar a resposta agora.`,
  RATE_LIMITED: () =>
    $localize`:@@ai.rateLimited:Muitas respostas em pouco tempo. Espere um minuto e tente de novo.`,
};

const IDLE: AnswerRun = {
  phase: 'idle',
  text: '',
  sources: [],
  usd: null,
  interrupted: false,
  error: null,
};

/**
 * "Resposta com IA" at the top of a result message (screens.md T4, KBC-004): never runs by
 * itself, shows the estimated cost first, streams a grounded answer with numbered sources.
 */
@Component({
  selector: 'app-ai-answer',
  templateUrl: './ai-answer.html',
  styleUrl: './ai-answer.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Citation links live in sanitized [innerHTML]: one delegated listener (Enter on a link also clicks).
  host: { '(click)': 'openCitation($event)' },
})
export class AiAnswer {
  private readonly api = inject(AnswersApi);
  private readonly spend = inject(SpendStore);
  private readonly destroyRef = inject(DestroyRef);
  private subscription: Subscription | null = null;

  readonly topic = input.required<string>();
  readonly question = input.required<string>();
  readonly mode = input.required<SearchMode>();
  readonly filters = input.required<SearchFilters>();
  readonly opened = output<DocumentRef>();

  private readonly request = computed(() => ({
    q: this.question(),
    mode: this.mode(),
    filters: this.filters(),
  }));
  /** The answer follows the current search: new filters start over (BR-4). */
  protected readonly run = linkedSignal<unknown, AnswerRun>({
    source: this.request,
    computation: () => IDLE,
  });

  protected readonly estimate = rxResource({
    params: () => ({ topic: this.topic(), request: this.request() }),
    stream: ({ params }) => this.api.estimate(params.topic, params.request),
  });
  protected readonly estimateError = computed(() => {
    const err = this.estimate.error();
    return err ? toUiErrorCode(err) : null;
  });
  protected readonly unavailable = computed(
    () => this.estimateError() === 'LLM_NOT_CONFIGURED',
  );
  protected readonly priceLabel = computed(() =>
    this.estimate.hasValue() ? formatEstimate(this.estimate.value().usd) : '',
  );
  protected readonly html = computed(() =>
    renderAnswer(this.run().text, this.run().sources),
  );
  protected readonly insufficient = computed(
    () => this.run().phase === 'done' && isInsufficient(this.run().text),
  );
  protected readonly considering = computed(() =>
    describeFilters(this.filters()),
  );
  /** Short live-region text: the streamed tokens themselves are not announced. */
  protected readonly announcement = computed(() => {
    const run = this.run();
    if (run.phase === 'done' && !run.interrupted)
      return $localize`:@@ai.ready:Resposta da IA pronta.`;
    return run.phase === 'error' ? this.errorText() : '';
  });
  protected readonly costLabel = computed(() => {
    const usd = this.run().usd;
    return usd === null ? '' : formatCost(usd);
  });
  protected readonly errorText = computed(() => {
    const code = this.run().error ?? this.estimateError();
    return code ? (AI_MESSAGES[code]?.() ?? errorMessage(code)) : '';
  });

  constructor() {
    this.destroyRef.onDestroy(() => this.subscription?.unsubscribe());
    // New question or filters: the answer in flight belongs to the old search and is stopped (BR-4).
    effect(() => {
      this.request();
      untracked(() => this.stopSilently());
    });
  }

  protected start(): void {
    // A second click before the screen updates must not start (and pay for) another answer.
    if (this.run().phase === 'streaming') return;
    this.stopSilently();
    this.run.set({ ...IDLE, phase: 'streaming' });
    this.subscription = this.api
      .answer(this.topic(), this.request(), crypto.randomUUID())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (event) => this.apply(event),
        error: (err: unknown) => {
          this.run.update((run) => ({
            ...run,
            phase: 'error',
            error: toUiErrorCode(err),
          }));
          this.spend.refresh();
        },
        // Today's spend in the side panel follows every finished answer (KBC-005 FR-5).
        complete: () => this.spend.refresh(),
      });
  }

  /** "Parar": aborts the request (the server stops the model and records the partial cost). */
  protected stop(): void {
    this.stopSilently();
    this.run.update((run) => ({ ...run, phase: 'done', interrupted: true }));
    // The server records the partial cost once it notices the abort: read the spend a bit later.
    setTimeout(() => this.spend.refresh(), STOP_SETTLE_MS);
  }

  protected openCitation(event: MouseEvent): void {
    const n = citedSource(event.target);
    const source = this.run().sources.find((s) => s.n === n);
    if (!source) return;
    event.preventDefault();
    this.opened.emit({ id: source.id, title: source.title });
  }

  private apply(event: AnswerEvent): void {
    this.run.update((run) => applyEvent(run, event));
  }

  private stopSilently(): void {
    this.subscription?.unsubscribe();
    this.subscription = null;
  }
}

const EVENT_HANDLERS: {
  [K in AnswerEvent['type']]: (
    run: AnswerRun,
    e: Extract<AnswerEvent, { type: K }>,
  ) => AnswerRun;
} = {
  sources: (run, e) => ({ ...run, sources: e.sources }),
  token: (run, e) => ({ ...run, text: run.text + e.text }),
  // A finished answer without text is a provider failure, not an empty success.
  done: (run, e) =>
    run.text.trim() || e.interrupted
      ? { ...run, phase: 'done', usd: e.usd, interrupted: e.interrupted }
      : { ...run, phase: 'error', usd: e.usd, error: 'INTERNAL' },
  error: (run, e) => ({ ...run, phase: 'error', error: toKnownCode(e.code) }),
};

function toKnownCode(code: string): UiErrorCode {
  const known: readonly UiErrorCode[] = [
    'DAILY_CAP_REACHED',
    'LLM_INSUFFICIENT_CREDIT',
    'LLM_NOT_CONFIGURED',
  ];
  return known.find((value) => value === code) ?? 'INTERNAL';
}

function applyEvent(run: AnswerRun, event: AnswerEvent): AnswerRun {
  const handler = EVENT_HANDLERS[event.type] as (
    run: AnswerRun,
    e: AnswerEvent,
  ) => AnswerRun;
  return handler(run, event);
}
