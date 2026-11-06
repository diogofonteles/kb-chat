import { HttpErrorResponse, httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  trackDocumentsOverviewSchema,
  type PublishExistingTracksResult,
  type TrackDocumentsCollection,
} from '@kb-chat/contracts';
import {
  TrackDocumentsApi,
  trackDocumentsUrl,
} from '@core/media/transcribers-api.js';

/** While the Mac works on them, the counts are read again this often. */
const REFRESH_MS = 20_000;

const usd = (value: number, digits: number): string =>
  new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  }).format(value);

const tracksWord = (count: number): string =>
  count === 1
    ? $localize`:@@existingTracks.oneTrack:1 faixa`
    : $localize`:@@existingTracks.tracks:${count}:count: faixas`;

const capReached = (): string =>
  $localize`:@@existingTracks.capReached:Teto mensal da mídia atingido: nada é publicado até o mês que vem.`;

/** What the live region says after publishing (UP-01). */
const resultText = ({ queued, skipped }: PublishExistingTracksResult) =>
  queued > 0
    ? $localize`:@@existingTracks.queued:${tracksWord(queued)}:tracks: na fila para o Mac.`
    : $localize`:@@existingTracks.nothingNew:Nada novo a publicar: ${tracksWord(skipped)}:tracks: já estavam no acervo.`;

/**
 * "Publicar no acervo as faixas que já existem" (KBC-099 AC-16, the owner's scope of
 * 2026-11-06; masters, in Transcritores beside "Publica no acervo"): which collections have
 * published tracks not in the vault as they are now, how many and kb's estimated cost,
 * chosen before anything is queued; then the progress, read again while the Mac works.
 */
@Component({
  selector: 'app-existing-tracks',
  templateUrl: './existing-tracks.html',
  styleUrls: ['../settings/settings-form.css', './transcribers-panel.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExistingTracks {
  private readonly api = inject(TrackDocumentsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly action = viewChild<ElementRef<HTMLButtonElement>>('action');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly overview = httpResource(() => trackDocumentsUrl(), {
    parse: (body) => trackDocumentsOverviewSchema.parse(body),
  });
  protected readonly collections = computed<TrackDocumentsCollection[]>(() =>
    this.overview.hasValue() ? this.overview.value().collections : [],
  );
  /** Collections with something to publish: what the choice offers. */
  protected readonly offered = computed(() =>
    this.collections().filter((one) => one.toPublish > 0),
  );
  /** Collections whose documents the Mac has seen, or is about to. */
  protected readonly progress = computed(() =>
    this.collections().filter(
      (one) => one.queued + one.published + one.failed > 0,
    ),
  );
  protected readonly choosing = signal(false);
  /** Topics left out of the choice (all are in by default). */
  protected readonly leftOut = signal<ReadonlySet<string>>(new Set());
  protected readonly busy = signal(false);
  protected readonly notice = signal('');
  /**
   * The collections of the last request, while "na fila para o Mac" holds; the sentence
   * goes once the counts showed them queued and then show none left (QA F-10).
   */
  private readonly waitingFor = signal<{
    readonly topics: ReadonlySet<string>;
    readonly sawQueued: boolean;
  } | null>(null);
  protected readonly chosen = computed(() =>
    this.offered().filter((one) => !this.leftOut().has(one.topic)),
  );
  protected readonly chosenTracks = computed(() =>
    this.chosen().reduce((sum, one) => sum + one.toPublish, 0),
  );
  protected readonly remainingUsd = computed(() =>
    this.overview.hasValue() ? this.overview.value().remainingUsd : 0,
  );
  protected readonly capSpent = computed(
    () => this.overview.hasValue() && this.remainingUsd() <= 0,
  );
  /** "5 faixas · custo estimado do kb ≈ US$ 0,005". */
  protected readonly summary = computed(() => {
    const perTrack = this.overview.hasValue()
      ? this.overview.value().usdPerTrack
      : 0;
    const cost = usd(this.chosenTracks() * perTrack, 3);
    return $localize`:@@existingTracks.summary:${tracksWord(this.chosenTracks())}:tracks: · custo estimado do kb ≈ US$ ${cost}:cost:`;
  });
  protected readonly remaining = computed(
    () =>
      $localize`:@@existingTracks.remaining:resta US$ ${usd(this.remainingUsd(), 2)}:usd: do teto mensal da mídia`,
  );
  protected readonly confirmLabel = computed(
    () =>
      $localize`:@@existingTracks.confirm:Publicar ${tracksWord(this.chosenTracks())}:tracks:`,
  );

  constructor() {
    // While something waits for the Mac, the counts follow it (FR-11's progress).
    effect((onCleanup) => {
      const waiting = this.collections().some((one) => one.queued > 0);
      if (!waiting) return;
      const timer = setInterval(() => this.overview.reload(), REFRESH_MS);
      onCleanup(() => clearInterval(timer));
    });
    effect(() => this.followQueued(this.collections()));
  }

  private followQueued(collections: readonly TrackDocumentsCollection[]): void {
    const waiting = this.waitingFor();
    if (!waiting) return;
    const queued = collections.some(
      (one) => waiting.topics.has(one.topic) && one.queued > 0,
    );
    if (queued && !waiting.sawQueued)
      this.waitingFor.set({ ...waiting, sawQueued: true });
    else if (!queued && waiting.sawQueued) {
      this.waitingFor.set(null);
      this.notice.set('');
    }
  }

  protected choiceLabelOf(collection: TrackDocumentsCollection): string {
    return $localize`:@@existingTracks.choice:${collection.title}:title: · ${tracksWord(collection.toPublish)}:tracks: a publicar`;
  }

  protected progressOf(collection: TrackDocumentsCollection): string {
    return $localize`:@@existingTracks.progress:${collection.title}:title:: ${collection.queued}:queued: na fila · ${collection.published}:published: publicadas · ${collection.failed}:failed: falharam`;
  }

  protected isChosen(topic: string): boolean {
    return !this.leftOut().has(topic);
  }

  protected toggle(topic: string, event: Event): void {
    const on = (event.target as HTMLInputElement).checked;
    const next = new Set(this.leftOut());
    if (on) next.delete(topic);
    else next.add(topic);
    this.leftOut.set(next);
  }

  /** The choice opens with the focus on its first collection (WCAG 2.4.3). */
  protected open(): void {
    this.choosing.set(true);
    this.leftOut.set(new Set());
    this.focusAfterRender(
      () =>
        this.host.nativeElement.querySelector<HTMLInputElement>(
          'input[data-choice]',
        ) ?? undefined,
    );
  }

  protected cancel(): void {
    this.choosing.set(false);
    this.focusAfterRender(() => this.action()?.nativeElement);
  }

  protected publish(): void {
    const topics = this.chosen().map((one) => one.topic);
    // PD-02: a second click in the same frame, before [disabled] renders, sends nothing.
    if (this.busy() || topics.length === 0 || this.capSpent()) return;
    this.busy.set(true);
    this.notice.set('');
    this.api
      .publish(topics)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result) => {
          this.busy.set(false);
          this.choosing.set(false);
          this.notice.set(resultText(result));
          this.waitingFor.set(
            result.queued > 0
              ? { topics: new Set(topics), sawQueued: false }
              : null,
          );
          this.overview.reload();
          this.focusAfterRender(() => this.action()?.nativeElement);
        },
        error: (err: unknown) => {
          this.busy.set(false);
          this.notice.set(
            err instanceof HttpErrorResponse && err.status === 429
              ? capReached()
              : $localize`:@@existingTracks.failed:Não foi possível publicar. Tente de novo.`,
          );
        },
      });
  }

  protected readonly capReachedText = capReached;

  private focusAfterRender(target: () => HTMLElement | undefined): void {
    afterNextRender(() => target()?.focus(), { injector: this.injector });
  }
}
