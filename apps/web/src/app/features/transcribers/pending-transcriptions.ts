import { HttpErrorResponse, httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  signal,
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
import { TranscriberStatus } from './transcriber-status.js';
import { TranscriberStatusStore } from './transcriber-status-store.js';

const usd = (value: number): string =>
  new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  }).format(value);

const transcriptions = (count: number): string =>
  count === 1
    ? $localize`:@@pending.one:1 transcrição`
    : $localize`:@@pending.many:${count}:count: transcrições`;

/** The collection and its sub-collections (ADR 0028), as the conversation searches them. */
const inScope = (slug: string, one: TrackDocumentsCollection): boolean =>
  one.topic === slug || one.topic.startsWith(`${slug}/`);

/**
 * "N transcrições ainda não são documentos — Publicar" (KBC-114 FR-6): in the collection,
 * for masters, the transcriptions (tracks and recordings without tracks) of it and its
 * sub-collections that are not documents yet, kb's estimated cost and one action that queues
 * them for the Mac, which creates the collection's vault folder by itself. The transcriber's
 * status chip says whether the Mac will take them now.
 */
@Component({
  selector: 'app-pending-transcriptions',
  imports: [TranscriberStatus],
  providers: [TranscriberStatusStore],
  templateUrl: './pending-transcriptions.html',
  styleUrl: './pending-transcriptions.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PendingTranscriptions {
  private readonly api = inject(TrackDocumentsApi);
  private readonly destroyRef = inject(DestroyRef);

  /** The collection on screen. */
  readonly topic = input.required<string>();

  private readonly overview = httpResource(() => trackDocumentsUrl(), {
    parse: (body) => trackDocumentsOverviewSchema.parse(body),
  });
  private readonly collections = computed(() =>
    this.overview.hasValue()
      ? this.overview
          .value()
          .collections.filter((one) => inScope(this.topic(), one))
      : [],
  );
  protected readonly pending = computed(() =>
    this.collections().reduce((sum, one) => sum + one.toPublish, 0),
  );
  protected readonly queued = computed(() =>
    this.collections().reduce((sum, one) => sum + one.queued, 0),
  );
  protected readonly capSpent = computed(
    () => this.overview.hasValue() && this.overview.value().remainingUsd <= 0,
  );
  /** Shown while there is something to publish or on its way, and after acting. */
  protected readonly visible = computed(
    () => this.pending() > 0 || this.queued() > 0 || this.notice() !== '',
  );
  protected readonly headline = computed(() =>
    this.pending() === 1
      ? $localize`:@@pending.headlineOne:1 transcrição ainda não é documento deste acervo`
      : $localize`:@@pending.headline:${this.pending()}:count: transcrições ainda não são documentos deste acervo`,
  );
  protected readonly cost = computed(() => {
    const perTrack = this.overview.hasValue()
      ? this.overview.value().usdPerTrack
      : 0;
    return $localize`:@@pending.cost:Custo estimado do kb ≈ US$ ${usd(this.pending() * perTrack)}:cost:. O Mac cria a pasta do acervo no vault se faltar.`;
  });
  protected readonly queuedLine = computed(
    () =>
      $localize`:@@pending.queued:${transcriptions(this.queued())}:count: na fila para o Mac.`,
  );
  protected readonly busy = signal(false);
  protected readonly notice = signal('');

  /** One request at a time (PD-02); the counts are read again after it. */
  protected publish(): void {
    const topics = this.collections()
      .filter((one) => one.toPublish > 0)
      .map((one) => one.topic);
    if (this.busy() || topics.length === 0 || this.capSpent()) return;
    this.busy.set(true);
    this.notice.set('');
    this.api
      .publish(topics)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result) => this.published(result),
        error: (err: unknown) => {
          this.busy.set(false);
          this.notice.set(
            err instanceof HttpErrorResponse && err.status === 429
              ? $localize`:@@pending.cap:Teto mensal da mídia atingido: nada é publicado até o mês que vem.`
              : $localize`:@@pending.failed:Não foi possível publicar. Tente de novo.`,
          );
        },
      });
  }

  private published({ queued, skipped }: PublishExistingTracksResult): void {
    this.busy.set(false);
    this.notice.set(
      queued > 0
        ? $localize`:@@pending.done:${transcriptions(queued)}:count: na fila para o Mac. Elas viram documentos quando ele as publicar.`
        : $localize`:@@pending.nothing:Nada novo: ${transcriptions(skipped)}:count: já estavam no acervo ou na fila.`,
    );
    this.overview.reload();
  }
}
