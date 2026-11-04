import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  LOCALE_ID,
  computed,
  inject,
  input,
  linkedSignal,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  collectionSubjectsSchema,
  editSubjectsSchema,
  type ProposalEstimate,
  type ProposalFailure,
  type SubjectRef,
  type TrackSubject,
  type TrackSubjects as TrackSubjectsState,
} from '@kb-chat/contracts';
import {
  errorDetailsOf,
  errorMessage,
  toUiErrorCode,
} from '@core/api/api-error.js';
import { SessionStore } from '@core/auth/session-store.js';
import {
  TrackSubjectsApi,
  collectionSubjectsUrl,
  editSubjectsUrl,
} from '@core/media/track-subjects-api.js';
import { interval, map, of, switchMap, type Observable } from 'rxjs';
import { MEDIA_POLL_MS } from '../media-polling.js';
import type { SubjectChoice } from './subject-picker.js';
import {
  TrackSubjectRow,
  type SubjectDecisionEvent,
} from './track-subject-row.js';

type Asking =
  | { readonly kind: 'idle' | 'estimating' }
  | {
      readonly kind: 'estimated' | 'starting';
      readonly estimate: ProposalEstimate;
    };

const FAILURES: Record<ProposalFailure, () => string> = {
  provider: () =>
    $localize`:@@subjects.ai.failed.provider:O provedor de IA não respondeu.`,
  'invalid-output': () =>
    $localize`:@@subjects.ai.failed.output:A resposta da IA não trouxe assuntos que deem para usar.`,
  'run-cap': () =>
    $localize`:@@subjects.ai.failed.cap:Esta sugestão passaria do teto por análise.`,
  interrupted: () =>
    $localize`:@@subjects.ai.failed.interrupted:A sugestão foi interrompida.`,
};

const refOf = (subject: TrackSubject): SubjectRef =>
  subject.id === null
    ? { kind: 'concept', name: subject.name }
    : { kind: 'free', id: subject.id };

const isDuplicate = (err: unknown): boolean => {
  const details = errorDetailsOf(err);
  return (
    typeof details === 'object' &&
    details !== null &&
    'reason' in details &&
    details.reason === 'duplicate-subject'
  );
};

/**
 * "Assuntos" in step 4 of "Preparar áudio" (KBC-069): the column of each track and "Sugerir
 * assuntos com IA", which shows its price first (BR-5). A chip "Sugerido" counts for nothing
 * until a person accepts it (BR-3).
 */
@Component({
  selector: 'app-track-subjects',
  imports: [TrackSubjectRow],
  templateUrl: './track-subjects.html',
  styleUrl: './track-subjects.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrackSubjects {
  private readonly api = inject(TrackSubjectsApi);
  private readonly session = inject(SessionStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly locale = inject(LOCALE_ID);

  readonly mediaId = input.required<string>();
  readonly topic = input.required<string>();

  private readonly step = httpResource(() => editSubjectsUrl(this.mediaId()), {
    parse: (body) => editSubjectsSchema.parse(body),
  });
  private readonly subjects = httpResource(
    () => (this.topic() ? collectionSubjectsUrl(this.topic()) : undefined),
    { parse: (body) => collectionSubjectsSchema.parse(body) },
  );

  private readonly known = computed(() =>
    this.step.hasValue() ? this.step.value() : null,
  );
  /** The list as the last answer left it: each write answers with its own track. */
  protected readonly tracks = linkedSignal<readonly TrackSubjectsState[]>(
    () => this.known()?.tracks ?? [],
  );
  protected readonly collection = computed(() =>
    this.subjects.hasValue()
      ? this.subjects.value()
      : { concepts: [], free: [] },
  );
  protected readonly loading = computed(
    () => this.step.isLoading() && this.known() === null,
  );
  protected readonly readFailed = computed(() => this.step.error() != null);
  protected readonly busy = signal<readonly string[]>([]);
  protected readonly notice = signal('');

  private readonly asking = signal<Asking>({ kind: 'idle' });
  protected readonly estimate = computed(() => {
    const asking = this.asking();
    return 'estimate' in asking ? asking.estimate : null;
  });
  protected readonly waiting = computed(() => {
    const { kind } = this.asking();
    return kind === 'estimating' || kind === 'starting';
  });
  protected readonly run = computed(() => this.known()?.run ?? null);
  protected readonly running = computed(() => this.run()?.status === 'running');
  protected readonly canSuggest = computed(
    () =>
      this.session.can('media-edit-ai') && this.known()?.canSuggest === true,
  );
  protected readonly failureText = computed(() => {
    const failure = this.run()?.failure;
    return failure ? FAILURES[failure]() : '';
  });
  protected readonly cost = computed(() => {
    const run = this.run();
    return run?.status === 'done' ? this.usd(run.spentUsd) : '';
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
      ? $localize`:@@subjects.ai.failed.cap:Esta sugestão passaria do teto por análise.`
      : '';
  });
  protected readonly month = computed(() => {
    const month = this.estimate()?.month;
    return month
      ? $localize`:@@tracks.ai.month:Este mês: ${this.usd(month.spentUsd)}:spent: de ${this.usd(month.capUsd)}:cap:`
      : '';
  });

  constructor() {
    interval(inject(MEDIA_POLL_MS))
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        if (this.running()) this.step.reload();
      });
  }

  private usd(value: number): string {
    return new Intl.NumberFormat(this.locale, {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 3,
    }).format(value);
  }

  protected reload(): void {
    this.notice.set('');
    this.step.reload();
  }

  protected isBusy(track: TrackSubjectsState): boolean {
    return this.busy().includes(track.mediaId);
  }

  protected add(track: TrackSubjectsState, choice: SubjectChoice): void {
    this.write(
      track,
      this.refOfChoice(choice).pipe(
        switchMap((ref) =>
          this.api.save(track, {
            subjects: [...track.subjects.map(refOf), ref],
            summary: track.summary,
          }),
        ),
      ),
    );
  }

  private refOfChoice(choice: SubjectChoice): Observable<SubjectRef> {
    if (choice.kind !== 'create') return of(choice);
    return this.api.createFree(this.topic(), choice.name).pipe(
      map(({ id }): SubjectRef => {
        this.subjects.reload();
        return { kind: 'free', id };
      }),
    );
  }

  protected remove(track: TrackSubjectsState, subject: TrackSubject): void {
    const kept = track.subjects.filter((one) => one !== subject);
    this.write(
      track,
      this.api.save(track, {
        subjects: kept.map(refOf),
        summary: track.summary,
      }),
    );
  }

  protected decide(
    track: TrackSubjectsState,
    decision: SubjectDecisionEvent,
  ): void {
    this.write(
      track,
      this.api.decide(track, {
        accept: [...decision.accept],
        refuse: [...decision.refuse],
        summary: decision.summary,
      }),
    );
  }

  protected saveSummary(track: TrackSubjectsState, summary: string): void {
    this.write(
      track,
      this.api.save(track, {
        subjects: track.subjects.map(refOf),
        summary: summary || null,
      }),
    );
  }

  private write(
    track: TrackSubjectsState,
    work: Observable<TrackSubjectsState>,
  ): void {
    const { mediaId } = track;
    this.notice.set('');
    this.busy.update((now) => [...now, mediaId]);
    const done = () =>
      this.busy.update((now) => now.filter((one) => one !== mediaId));
    work.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (fresh) => {
        done();
        this.tracks.update((all) =>
          all.map((one) => (one.mediaId === mediaId ? fresh : one)),
        );
      },
      error: (err: unknown) => {
        done();
        this.refused(err);
      },
    });
  }

  private refused(err: unknown): void {
    if (isDuplicate(err)) {
      this.notice.set(
        $localize`:@@subjects.repeated:Este assunto já existe. Escolha-o na lista.`,
      );
      this.subjects.reload();
      return;
    }
    if (toUiErrorCode(err) === 'EDIT_STALE') this.step.reload();
    this.notice.set(errorMessage(toUiErrorCode(err)));
  }

  protected askEstimate(): void {
    this.notice.set('');
    this.asking.set({ kind: 'estimating' });
    this.api
      .estimate(this.mediaId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (estimate) => this.asking.set({ kind: 'estimated', estimate }),
        error: (err: unknown) => {
          this.asking.set({ kind: 'idle' });
          this.notice.set(errorMessage(toUiErrorCode(err)));
        },
      });
  }

  protected cancel(): void {
    this.asking.set({ kind: 'idle' });
  }

  /** The press that spends: only here, once per press (BR-5). */
  protected confirm(): void {
    const asking = this.asking();
    if (asking.kind !== 'estimated') return;
    this.notice.set('');
    this.asking.set({ ...asking, kind: 'starting' });
    this.api
      .start(this.mediaId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.asking.set({ kind: 'idle' });
          this.step.reload();
        },
        error: (err: unknown) => {
          this.asking.set({ kind: 'idle' });
          this.notice.set(errorMessage(toUiErrorCode(err)));
          this.step.reload();
        },
      });
  }
}
