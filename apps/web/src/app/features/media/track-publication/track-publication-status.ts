import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  mediaPublicationSchema,
  type PublicationOutReason,
  type TrackPublication,
  type TrackPublicationState,
} from '@kb-chat/contracts';
import {
  TrackDocumentsApi,
  publicationUrl,
} from '@core/media/transcribers-api.js';
import { publicationTime } from './publication-time.js';

/** It changes by itself (the Mac, the sync): read again this often while it is not settled. */
const REFRESH_MS = 30_000;

/** States that change only when someone acts: nothing to read again. */
const SETTLED: ReadonlySet<TrackPublicationState> = new Set(['live', 'out']);

/** Never only color (AC-15): each state has its sign, beside its words. */
const ICON: Record<TrackPublicationState, string> = {
  live: '✓',
  updating: '↻',
  'waiting-mac': '⏸',
  failed: '⚠',
  out: '⊘',
};

const OUT_REASON: Record<PublicationOutReason, () => string> = {
  'no-folder': () =>
    $localize`:@@publication.outNoFolder:Fora da pesquisa: o acervo ainda não tem pasta no kb`,
  cap: () =>
    $localize`:@@publication.outCap:Fora da pesquisa: teto mensal da mídia`,
  'not-published': () =>
    $localize`:@@publication.outNotPublished:Fora da pesquisa: ainda não publicada no acervo`,
};

const since = (iso: string): string =>
  $localize`:@@publication.since:desde ${publicationTime(iso)}:time:`;

/** The words of each state (BR-4). */
export function publicationText(publication: TrackPublication): string {
  const texts: {
    [State in TrackPublicationState]: (
      one: Extract<TrackPublication, { state: State }>,
    ) => string;
  } = {
    live: (one) =>
      `${$localize`:@@publication.live:Na pesquisa`} · ${since(one.since)}`,
    updating: (one) =>
      `${$localize`:@@publication.updating:Atualizando na pesquisa`} · ${since(one.since)}`,
    'waiting-mac': (one) =>
      one.offSince
        ? $localize`:@@publication.waitingSince:Aguardando o Mac do dono (desligado desde ${publicationTime(one.offSince)}:time:)`
        : $localize`:@@publication.waiting:Aguardando o Mac do dono`,
    failed: (one) =>
      $localize`:@@publication.failed:Falhou: ${one.reason}:reason:`,
    out: (one) => OUT_REASON[one.reason](),
  };
  const text = texts[publication.state] as (one: TrackPublication) => string;
  return text(publication);
}

/**
 * Where a track (or a recording without tracks) stands in the AI research, under its title,
 * for who edits it (KBC-100 FR-3, T22 "Estado da publicação"): words and a sign, never only
 * color, in a status region so a change is announced; **Tentar de novo** when kb gave up.
 */
@Component({
  selector: 'app-track-publication-status',
  template: `
    @if (publication(); as current) {
      <div class="publication" [attr.data-state]="current.state">
        <p #line class="line" role="status" tabindex="-1">
          <span class="sign" aria-hidden="true">{{ iconOf(current) }}</span>
          <span class="label" i18n="@@publication.label">Pesquisa com IA:</span>
          <span class="text">{{ textOf(current) }}</span>
          @if (notice()) {
            <span class="notice">{{ notice() }}</span>
          }
        </p>
        @if (current.state === 'failed') {
          <button
            type="button"
            class="secondary"
            [disabled]="busy()"
            (click)="retry()"
            i18n="@@publication.retry"
          >
            Tentar de novo
          </button>
        }
      </div>
    }
  `,
  styles: `
    .publication {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      margin-top: var(--space-2);
      min-width: 0;
    }
    .line {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1);
      margin: 0;
      min-width: 0;
      color: var(--color-text-muted);
      font-size: var(--text-sm);
      overflow-wrap: anywhere;
    }
    .label {
      font-weight: 600;
    }
    [data-state='failed'] .line {
      color: var(--color-danger);
    }
    .notice {
      color: var(--color-danger);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrackPublicationStatus {
  readonly mediaId = input.required<string>();

  private readonly api = inject(TrackDocumentsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly line = viewChild<ElementRef<HTMLElement>>('line');

  private readonly read = httpResource(() => publicationUrl(this.mediaId()), {
    parse: (body) => mediaPublicationSchema.parse(body),
  });
  /** What a retry answered, until the next read. */
  private readonly answered = signal<TrackPublication | null>(null);
  protected readonly busy = signal(false);
  protected readonly notice = signal('');

  protected readonly publication = computed<TrackPublication | null>(
    () =>
      this.answered() ??
      (this.read.hasValue() ? this.read.value().publication : null),
  );

  constructor() {
    effect((onCleanup) => {
      const current = this.publication();
      if (!current || SETTLED.has(current.state)) return;
      const timer = setInterval(() => {
        this.answered.set(null);
        this.read.reload();
      }, REFRESH_MS);
      onCleanup(() => clearInterval(timer));
    });
  }

  protected iconOf(publication: TrackPublication): string {
    return ICON[publication.state];
  }

  protected textOf(publication: TrackPublication): string {
    return publicationText(publication);
  }

  protected retry(): void {
    // PD-02: a second click before [disabled] renders sends nothing.
    if (this.busy()) return;
    this.busy.set(true);
    this.notice.set('');
    this.api
      .retry(this.mediaId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ publication }) => {
          this.busy.set(false);
          this.answered.set(publication);
          // The button goes with "Falhou": the focus goes to what the line says now.
          afterNextRender(() => this.line()?.nativeElement.focus(), {
            injector: this.injector,
          });
        },
        error: () => {
          this.busy.set(false);
          this.notice.set(
            $localize`:@@publication.retryFailed:Não foi possível tentar de novo.`,
          );
        },
      });
  }
}
