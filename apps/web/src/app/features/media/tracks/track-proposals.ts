import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  LOCALE_ID,
  afterRenderEffect,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type {
  CollectionSpeaker,
  ProposalEstimate,
  ProposalFailure,
  ProposalRun,
  VoiceSuggestion,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { MediaEditApi } from '@core/media/media-edit-api.js';
import { SpeakersApi } from '@core/media/speakers-api.js';
import { map, of, switchMap, type Observable } from 'rxjs';
import {
  roseEstimateOf,
  type ProposeResult,
  type SaveResult,
} from './track-draft-state.js';
import { notDoneText } from './track-labels.js';

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
  private readonly speakersApi = inject(SpeakersApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly locale = inject(LOCALE_ID);

  readonly mediaId = input.required<string>();
  readonly topic = input.required<string>();
  /** The run the draft shows, from the server (it may be running after a reload). */
  readonly latestRun = input<ProposalRun | null>(null);
  /** Why the newest run failed, from the server (FR-5): it survives a reload. */
  readonly lastFailure = input<ProposalFailure | null>(null);
  readonly suggestions = input<readonly VoiceSuggestion[]>([]);
  readonly speakers = input<readonly CollectionSpeaker[]>([]);
  /** The separation's version; null without one: names cannot be accepted. */
  readonly separation = input<number | null>(null);

  /** Saves the person's changes and starts the run: only when that save came back fine. */
  readonly start =
    input.required<(acceptedUsd: number) => Observable<ProposeResult>>();
  /** A conflict (R-3), or a press on the draft waiting for its answer (F-2): no run starts. */
  readonly blocked = input(false);

  /** The draft has proposals a new run may swap: said before the press (KBC-097). */
  readonly replaces = input(false);

  /** A suggested name was accepted (BR-5). */
  readonly named = output();

  private readonly asking = signal<Asking>({ kind: 'idle' });
  protected readonly error = signal('');
  /**
   * The value rose: its notice and the actions under it are brought into view, clear of the
   * editor's bottom bar (the actions are scrolled to; the notice sits right above them).
   */
  private readonly rose = signal(false);
  private readonly notice = viewChild<ElementRef<HTMLElement>>('notice');
  private readonly actions = viewChild<ElementRef<HTMLElement>>('actions');
  private readonly accepted = signal<readonly number[]>([]);

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
  protected readonly cost = computed(() => {
    const run = this.run();
    return run?.status === 'done' && !this.failed()
      ? this.usd(run.spentUsd)
      : '';
  });
  protected readonly estimateText = computed(() => {
    const estimate = this.estimate();
    return estimate ? this.usd(estimate.estimateUsd) : '';
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
  protected readonly pending = computed(() => {
    const accepted = this.accepted();
    return this.suggestions().filter(
      (one) =>
        (one.name !== null || one.audience) && !accepted.includes(one.voice),
    );
  });

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
  }

  protected askEstimate(): void {
    this.rose.set(false);
    this.error.set('');
    this.asking.set({ kind: 'estimating' });
    this.api
      .estimate(this.mediaId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (estimate) => this.asking.set({ kind: 'estimated', estimate }),
        error: (err: unknown) => {
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

  protected accept(suggestion: VoiceSuggestion): void {
    const version = this.separation();
    if (version === null) return;
    const body = { version, speakerId: null, audience: suggestion.audience };
    this.speakerOf(suggestion)
      .pipe(
        switchMap((speakerId) =>
          this.speakersApi.nameVoice(this.mediaId(), suggestion.voice, {
            ...body,
            speakerId,
          }),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          this.accepted.update((all) => [...all, suggestion.voice]);
          this.named.emit();
        },
        error: (err: unknown) => this.showError(err),
      });
  }

  /** The collection's speaker of that name, registered when it is a new one. */
  private speakerOf(suggestion: VoiceSuggestion): Observable<string | null> {
    if (suggestion.audience || suggestion.name === null) return of(null);
    const name = suggestion.name;
    const known = this.speakers().find((one) => one.name === name);
    return known
      ? of(known.id)
      : this.speakersApi
          .createSpeaker(this.topic(), { name })
          .pipe(map((speaker) => speaker.id));
  }

  private showError(err: unknown): void {
    this.error.set(errorMessage(toUiErrorCode(err)));
  }
}
