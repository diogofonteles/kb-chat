import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  signal,
  viewChild,
  type Signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { Title } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { mediaItemSchema, type RetryStage } from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { mediaPagePath, mediaUrl } from '@core/media/media-api.js';
import { editPagePath } from '@core/media/media-edit-api.js';
import { PreparationApi } from '@core/media/preparation-api.js';
import { map, of, switchMap, type Observable } from 'rxjs';
import { TrackAudition } from '../tracks/track-audition.js';
import type { MediaPreparation } from '@kb-chat/contracts';
import { PlanForm } from './plan-form.js';
import { PreparationOptions } from './preparation-options.js';
import { PreparationStageList } from './preparation-stages.js';
import { PreparationSteps, stepTitle } from './preparation-steps.js';
import { PreparationTracks } from './preparation-tracks.js';
import { PreparationVoices } from './preparation-voices.js';
import { PreparationWatch } from './preparation-watch.js';

/** "Processamento concluído: 12 faixas propostas, 3 vozes." */
function concludedText({ tracks, voices }: MediaPreparation): string {
  const trackCount = tracks.length;
  const voiceCount = voices.length;
  if (trackCount === 0 && voiceCount === 0)
    return $localize`:@@prep.concluded.plain:Processamento concluído.`;
  if (trackCount === 0)
    return $localize`:@@prep.concluded.voices:Processamento concluído: ${voiceCount}:voices: vozes.`;
  return $localize`:@@prep.concluded:Processamento concluído: ${trackCount}:tracks: faixas propostas, ${voiceCount}:voices: vozes.`;
}

/**
 * "Preparar áudio", steps 1 and 2 (T20, KBC-072): what to do with an audio already sent, and
 * the work going on with the tracks appearing. Everything lives on the server: leaving,
 * reloading or another device come back to the same step (BR-8). Moving on is always a press
 * (FR-5), and nothing here reaches listeners (BR-7).
 */
@Component({
  selector: 'app-preparation-page',
  imports: [
    RouterLink,
    PreparationOptions,
    PreparationStageList,
    PreparationSteps,
    PreparationTracks,
    PreparationVoices,
  ],
  templateUrl: './preparation-page.html',
  styleUrls: ['./preparation-buttons.css', './preparation-page.css'],
  providers: [PlanForm, PreparationWatch, TrackAudition],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:visibilitychange)': 'watch.resume()',
    '(window:online)': 'watch.resume()',
  },
})
export class PreparationPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(PreparationApi);
  private readonly pageTitle = inject(Title);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly watch = inject(PreparationWatch);
  protected readonly form = inject(PlanForm);
  protected readonly audition = inject(TrackAudition);
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  private readonly audio = viewChild<ElementRef<HTMLAudioElement>>('audio');

  protected readonly id = toSignal(
    this.route.paramMap.pipe(map((params) => params.get('id') ?? '')),
    { initialValue: '' },
  );
  private readonly item = httpResource(() => mediaUrl(this.id()), {
    parse: (body) => mediaItemSchema.parse(body),
  });
  protected readonly preparation = this.watch.preparation;
  protected readonly busy = signal(false);
  protected readonly actionError = signal('');
  /** The form: before any plan, or after one ended, for what is still missing (AC-16). */
  protected readonly choosing = computed(() => {
    const preparation = this.preparation();
    return (
      preparation !== null &&
      (preparation.plan === null || preparation.finished)
    );
  });
  protected readonly step = computed(() =>
    this.choosing() ? 1 : (this.preparation()?.step ?? 2),
  );
  protected readonly ready = computed(
    () => this.item.hasValue() && this.item.value().status === 'ready',
  );
  protected readonly concluded = computed(() => {
    const preparation = this.preparation();
    return preparation?.next ? concludedText(preparation) : '';
  });
  protected readonly canStart = computed(() => {
    const { transcribe } = this.form.choices();
    return transcribe || this.form.guided();
  });
  protected readonly mediaLink = computed(() => mediaPagePath(this.id()));
  protected readonly editLink = computed(() => editPagePath(this.id()));
  protected readonly streamUrl = computed(
    () => `${mediaUrl(this.id())}/stream`,
  );

  constructor() {
    effect(() => {
      const id = this.id();
      if (id) this.watch.start(id);
    });
    effect(() => {
      if (this.choosing()) this.form.aim({ mediaId: this.id() });
    });
    // The tab's title follows the step (T20): not a signal, so an effect is the sync.
    effect(() => {
      const preparation = this.preparation();
      if (preparation)
        this.pageTitle.setTitle(
          `${stepTitle(this.step())} — ${preparation.title}`,
        );
    });
    this.onceRendered(this.audio, (element) => this.audition.attach(element));
    // Arriving is the one time the focus moves: on to the step's title.
    this.onceRendered(this.heading, (element) => element.focus());
    this.destroyRef.onDestroy(() => this.audition.stop());
  }

  /** Runs once, the first time the element is on the page. */
  private onceRendered<T extends HTMLElement>(
    query: Signal<ElementRef<T> | undefined>,
    run: (element: T) => void,
  ): void {
    let done = false;
    afterRenderEffect(() => {
      const element = query()?.nativeElement;
      if (element && !done) {
        done = true;
        run(element);
      }
    });
  }

  protected start(): void {
    this.act(this.api.start(this.id(), this.form.plan()));
  }

  protected retry(stage: RetryStage): void {
    this.act(this.api.retry(this.id(), stage));
  }

  /** From the AI to the person: on to step 3 when the words are there (AC-11). */
  protected markByHand(): void {
    const id = this.id();
    this.act(
      this.api
        .markByHand(id)
        .pipe(
          switchMap((preparation) =>
            preparation.next === 'validate'
              ? this.api.advance(id)
              : of(preparation),
          ),
        ),
    );
  }

  /** Only a press moves on (FR-5). */
  protected moveOn(): void {
    this.act(this.api.advance(this.id()));
  }

  protected named(): void {
    this.watch.start(this.id());
  }

  private act(request: Observable<MediaPreparation>): void {
    this.busy.set(true);
    this.actionError.set('');
    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (preparation) => {
        this.busy.set(false);
        this.arrive(preparation);
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.actionError.set(errorMessage(toUiErrorCode(err)));
      },
    });
  }

  private arrive(preparation: MediaPreparation): void {
    if (preparation.finished) void this.router.navigateByUrl(this.mediaLink());
    else if (preparation.step === 3)
      void this.router.navigateByUrl(this.editLink());
    else this.watch.replace(preparation);
  }
}
