import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  LOCALE_ID,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type {
  AcceptedLimitStop,
  ProposalEstimate,
  ProposalFailure,
  ProposalRun,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { MediaEditApi } from '@core/media/media-edit-api.js';
import type { Observable } from 'rxjs';
import {
  roseEstimateOf,
  type ProposeResult,
  type SaveResult,
} from './track-draft-state.js';
import { usdUpText } from '../preparation/preparation-labels.js';
import { notDoneText } from './track-labels.js';

/**
 * Focuses a button with its row brought into view by the row's scroll margin: a plain
 * focus scrolls just enough to leave it under the editor's bottom bar on a phone.
 */
function focusClearOfTheBar(row: HTMLElement, button: HTMLElement): void {
  row.scrollIntoView({ block: 'nearest' });
  button.focus({ preventScroll: true });
}

/** Where the person is in asking for a run. */
type Asking =
  | { readonly kind: 'idle' | 'estimating' }
  | {
      readonly kind: 'estimated' | 'starting';
      readonly estimate: ProposalEstimate;
    };

/**
 * "Propor faixas com IA" (KBC-067), inside step 3: estimate, confirm, and what the run says.
 * The page follows the run, for who has no access to this panel too (R-5).
 */
@Component({
  selector: 'app-track-proposals',
  imports: [NgTemplateOutlet],
  templateUrl: './track-proposals.html',
  styleUrl: './track-proposals.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrackProposals {
  private readonly api = inject(MediaEditApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly locale = inject(LOCALE_ID);

  readonly mediaId = input.required<string>();
  /** The run the draft shows, from the server (it may be running after a reload). */
  readonly latestRun = input<ProposalRun | null>(null);
  /** Why the newest run failed, from the server (FR-5): it survives a reload. */
  readonly lastFailure = input<ProposalFailure | null>(null);

  /** Saves the person's changes and starts the run: only when that save came back fine. */
  readonly start =
    input.required<(acceptedUsd: number) => Observable<ProposeResult>>();
  /** A conflict (R-3), or a press on the draft waiting for its answer (F-2): no run starts. */
  readonly blocked = input(false);

  /** The draft has proposals a new run may swap: said before the press (KBC-097). */
  readonly replaces = input(false);

  /** Where the newest run stopped at the value accepted, from the server (KBC-112 FR-3). */
  readonly stopped = input<AcceptedLimitStop | null>(null);

  private readonly asking = signal<Asking>({ kind: 'idle' });
  protected readonly error = signal('');
  /**
   * The value rose: its notice and the actions under it are brought into view, clear of the
   * editor's bottom bar (the actions are scrolled to; the notice sits right above them).
   */
  private readonly rose = signal(false);
  private readonly notice = viewChild<ElementRef<HTMLElement>>('notice');
  private readonly actions = viewChild<ElementRef<HTMLElement>>('actions');
  private readonly retryButton = viewChild<ElementRef<HTMLElement>>('retry');
  /** What going on from a stop costs: read when the stop is shown (KBC-112 FR-3). */
  private readonly going = signal<{
    readonly key: string;
    readonly estimate: ProposalEstimate | null;
  } | null>(null);
  /** A run followed here stopped: the focus goes to "Tentar de novo" (KBC-112 AC-14). */
  private followed = false;
  /** The pressed button goes with the estimate: the focus goes to the actions (PD-01). */
  private focusActions = false;

  protected readonly estimate = computed(() => {
    const asking = this.asking();
    return 'estimate' in asking ? asking.estimate : null;
  });
  protected readonly busy = computed(() => {
    const { kind } = this.asking();
    return kind === 'estimating' || kind === 'starting';
  });
  protected readonly run = computed(() => this.latestRun());
  protected readonly running = computed(() => this.run()?.status === 'running');
  protected readonly failed = computed(() => this.lastFailure() !== null);
  protected readonly stop = computed(() =>
    this.lastFailure() === 'accepted-limit' ? this.stopped() : null,
  );
  private readonly stopKey = computed(() => {
    const stop = this.stop();
    return stop
      ? `${stop.limitUsd}:${stop.windowsDone}:${stop.windowsTotal}`
      : null;
  });
  protected readonly stopText = computed(() => {
    const stop = this.stop();
    if (!stop) return '';
    const limit = this.usdUp(stop.limitUsd);
    const { windowsDone: done, windowsTotal: total } = stop;
    const going = this.going();
    const estimate =
      going?.key === this.stopKey() ? going.estimate?.estimateUsd : undefined;
    return estimate === undefined
      ? $localize`:@@tracks.ai.stopped:A análise parou no valor aceito (${limit}:limit:): ${done}:done: de ${total}:total: janelas prontas.`
      : $localize`:@@tracks.ai.stoppedGoingOn:A análise parou no valor aceito (${limit}:limit:): ${done}:done: de ${total}:total: janelas prontas. Continuar custa cerca de ${this.usdUp(estimate)}:value:.`;
  });
  protected readonly cost = computed(() => {
    const run = this.run();
    return run?.status === 'done' && !this.failed()
      ? this.usd(run.spentUsd)
      : '';
  });
  protected readonly estimateText = computed(() => {
    const estimate = this.estimate();
    return estimate ? this.usdUp(estimate.estimateUsd) : '';
  });
  protected readonly refusal = computed(() => {
    const refusal = this.estimate()?.refusal;
    if (refusal === 'monthly-cap')
      return $localize`:@@tracks.ai.monthlyCap:O teto mensal da mídia foi atingido.`;
    return refusal === 'run-cap'
      ? $localize`:@@tracks.ai.runCap:Esta análise passaria do teto por análise.`
      : '';
  });
  protected readonly month = computed(() => {
    const month = this.estimate()?.month;
    return month
      ? $localize`:@@tracks.ai.month:Este mês: ${this.usd(month.spentUsd)}:spent: de ${this.usd(month.capUsd)}:cap:`
      : '';
  });
  /** An estimate or a limit: rounded up, never below what the run holds to (KBC-112 BR-7). */
  private usdUp(value: number): string {
    return usdUpText(value, this.locale);
  }

  private usd(value: number): string {
    return new Intl.NumberFormat(this.locale, {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 3,
    }).format(value);
  }

  constructor() {
    afterRenderEffect({
      write: () => {
        const actions = this.actions()?.nativeElement;
        if (actions && this.notice() && this.rose())
          actions.scrollIntoView({ block: 'nearest' });
      },
    });
    this.watchStop();
    this.keepFocus();
  }

  /** A stop at the value reads what going on costs, once per stop (KBC-112 FR-3). */
  private watchStop(): void {
    effect(() => {
      if (this.running()) this.followed = true;
    });
    effect(() => {
      const key = this.stopKey();
      if (key !== null) untracked(() => this.readGoingOn(key));
    });
  }

  /** A button that goes leaves the focus on what comes in its place (PD-01, AC-14). */
  private keepFocus(): void {
    afterRenderEffect({
      write: () => {
        const actions = this.actions()?.nativeElement;
        const first = actions?.querySelector('button');
        if (!actions || !first || !this.focusActions) return;
        this.focusActions = false;
        focusClearOfTheBar(actions, first);
      },
    });
    afterRenderEffect({
      write: () => {
        const retry = this.retryButton()?.nativeElement;
        const actions = retry?.parentElement;
        if (!retry || !actions || !this.followed) return;
        this.followed = false;
        focusClearOfTheBar(actions, retry);
      },
    });
  }

  /** The free estimate of the windows left; without it the stop still offers a retry. */
  private readGoingOn(key: string): void {
    if (this.going()?.key === key) return;
    this.going.set({ key, estimate: null });
    this.api
      .estimate(this.mediaId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (estimate) => {
          if (this.going()?.key === key) this.going.set({ key, estimate });
        },
        // Not a failure to show: the stop is said, and "Tentar de novo" asks the value again.
        error: () => undefined,
      });
  }

  protected askEstimate(): void {
    this.rose.set(false);
    this.error.set('');
    this.asking.set({ kind: 'estimating' });
    this.focusActions = true;
    this.api
      .estimate(this.mediaId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (estimate) => this.asking.set({ kind: 'estimated', estimate }),
        error: (err: unknown) => {
          this.focusActions = false;
          this.asking.set({ kind: 'idle' });
          this.showError(err);
        },
      });
  }

  protected cancel(): void {
    this.rose.set(false);
    this.asking.set({ kind: 'idle' });
  }

  /** The press on "Confirmar e propor": its answer comes back here and nothing stays (R-1). */
  protected confirm(): void {
    const asking = this.asking();
    if (asking.kind !== 'estimated') return;
    this.rose.set(false);
    this.error.set('');
    // This press's own state: its answer counts only while the screen still waits on it.
    const pressed: Asking = { ...asking, kind: 'starting' };
    this.asking.set(pressed);
    this.start()(asking.estimate.estimateUsd)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result) => this.answered(result, { pressed, asking }),
        // No answer: another press got there first, and this one stays to press again.
        complete: () => {
          if (this.asking() === pressed) this.asking.set(asking);
        },
      });
  }

  /** A press cancelled, or followed by a newer one, answers too late to change anything (PD-03). */
  private answered(
    result: ProposeResult,
    press: { readonly pressed: Asking; readonly asking: Asking },
  ): void {
    if (this.asking() !== press.pressed) return;
    if (result.kind === 'started') {
      this.asking.set({ kind: 'idle' });
      return;
    }
    this.asking.set(press.asking);
    if (result.kind === 'stopped') this.showStopped(result.result);
    else if (roseEstimateOf(result.error) !== null) this.askAgain();
    else this.showError(result.error);
  }

  /**
   * What was confirmed no longer holds (a price, the plan or the draft changed it): the new
   * value, to confirm. Neutral: the cause is not known here.
   */
  private askAgain(): void {
    this.askEstimate();
    this.rose.set(true);
    this.error.set(
      $localize`:@@tracks.ai.estimateRose:O valor mudou. Nada foi gasto: confira o novo valor.`,
    );
  }

  private showStopped(result: SaveResult): void {
    this.error.set(notDoneText(result));
  }

  private showError(err: unknown): void {
    this.error.set(errorMessage(toUiErrorCode(err)));
  }
}
