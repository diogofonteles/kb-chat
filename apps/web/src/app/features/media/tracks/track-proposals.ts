import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  LOCALE_ID,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import type {
  CollectionSpeaker,
  ProposalEstimate,
  ProposalRun,
  VoiceSuggestion,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { MediaEditApi } from '@core/media/media-edit-api.js';
import { SpeakersApi } from '@core/media/speakers-api.js';
import {
  EMPTY,
  interval,
  map,
  of,
  switchMap,
  takeWhile,
  type Observable,
} from 'rxjs';
import { MEDIA_POLL_MS } from '../media-polling.js';

/** "Propor faixas com IA" (KBC-067), inside step 3: estimate, confirm, follow, cost. */
@Component({
  selector: 'app-track-proposals',
  templateUrl: './track-proposals.html',
  styleUrl: './track-proposals.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrackProposals {
  private readonly api = inject(MediaEditApi);
  private readonly speakersApi = inject(SpeakersApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly locale = inject(LOCALE_ID);
  private readonly pollMs = inject(MEDIA_POLL_MS);

  readonly mediaId = input.required<string>();
  readonly topic = input.required<string>();
  /** The run the draft shows, from the server (it may be running after a reload). */
  readonly latestRun = input<ProposalRun | null>(null);
  readonly suggestions = input<readonly VoiceSuggestion[]>([]);
  readonly speakers = input<readonly CollectionSpeaker[]>([]);
  /** The separation's version; null without one: names cannot be accepted. */
  readonly separation = input<number | null>(null);

  /** The draft grew or a run ended: read it again. */
  readonly changed = output();
  /** A suggested name was accepted (BR-5). */
  readonly named = output();

  protected readonly estimate = signal<ProposalEstimate | null>(null);
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  private readonly followed = linkedSignal<ProposalRun | null>(() =>
    this.latestRun(),
  );
  protected readonly run = this.followed.asReadonly();
  private readonly accepted = signal<readonly number[]>([]);

  protected readonly running = computed(() => this.run()?.status === 'running');
  protected readonly cost = computed(() => {
    const run = this.run();
    return run?.status === 'done' ? this.usd(run.spentUsd) : '';
  });
  protected readonly failed = computed(() => this.run()?.status === 'failed');
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

  constructor() {
    toObservable(computed(() => (this.running() ? this.run()?.id : null)))
      .pipe(
        switchMap((runId) => (runId ? this.follow(runId) : EMPTY)),
        takeUntilDestroyed(),
      )
      .subscribe({
        next: (run) => {
          this.followed.set(run);
          this.changed.emit();
        },
        error: (err: unknown) => this.showError(err),
      });
  }

  /** The run, until it ends, for the list to grow as windows end (KBC-067 FR-3). */
  private follow(runId: string): Observable<ProposalRun> {
    return interval(this.pollMs).pipe(
      switchMap(() => this.api.run(this.mediaId(), runId)),
      takeWhile((run) => run.status === 'running', true),
    );
  }

  private usd(value: number): string {
    return new Intl.NumberFormat(this.locale, {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 3,
    }).format(value);
  }

  protected askEstimate(): void {
    this.error.set('');
    this.busy.set(true);
    this.api
      .estimate(this.mediaId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (estimate) => {
          this.busy.set(false);
          this.estimate.set(estimate);
        },
        error: (err: unknown) => this.showError(err),
      });
  }

  protected cancel(): void {
    this.estimate.set(null);
  }

  protected confirm(): void {
    this.busy.set(true);
    this.api
      .propose(this.mediaId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (run) => {
          this.busy.set(false);
          this.estimate.set(null);
          this.followed.set(run);
          this.changed.emit();
        },
        error: (err: unknown) => this.showError(err),
      });
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
    this.busy.set(false);
    this.error.set(errorMessage(toUiErrorCode(err)));
  }
}
