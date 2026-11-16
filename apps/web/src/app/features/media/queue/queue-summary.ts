import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ProcessingQueueItem, QueueAction } from '@kb-chat/contracts';
import { SessionStore } from '@core/auth/session-store.js';
import { mediaPagePath } from '@core/media/media-api.js';
import { editPagePath } from '@core/media/media-edit-api.js';
import {
  QUEUE_PAGE_PATH,
  preparationPagePath,
} from '@core/media/preparation-api.js';
import { UiCover } from '@ui/cover.js';
import { UiPill, type Tone } from '@ui/pill.js';
import { ProcessingQueueStore } from './processing-queue-store.js';
import { queueStateText } from './queue-labels.js';

/** How many audios the block shows; the page has the rest. */
const SHOWN = 3;

/**
 * The queue, in brief, on the library (KBC-090; v2 KBC-128 FR-2 "Precisa da sua atenção"):
 * one card per audio with its cover, its state in a word and in full, and the direct action
 * (validate, continue, conclude, try again, or see the details). Nothing when nothing is there.
 */
@Component({
  selector: 'app-queue-summary',
  imports: [RouterLink, UiCover, UiPill],
  template: `
    @if (lines().length > 0) {
      <section class="summary" aria-labelledby="queue-summary-title">
        <div class="top">
          <h3 id="queue-summary-title">{{ titleText() }}</h3>
          <a class="see" [routerLink]="path" i18n="@@queue.open">Ver a fila</a>
        </div>
        <ul class="cards">
          @for (line of lines(); track line.id) {
            <li class="card">
              <ui-cover [title]="line.title" [size]="48" />
              <span class="body">
                <span class="name">{{ line.title }}</span>
                <span class="line">
                  @if (line.pill) {
                    <ui-pill [tone]="line.tone">{{ line.pill }}</ui-pill>
                  }
                  <span class="state">{{ line.state }}</span>
                </span>
              </span>
              <a
                class="action"
                [class.strong]="line.strong"
                [routerLink]="line.link"
                [attr.aria-label]="line.actionLabel"
                >{{ line.action }}</a
              >
            </li>
          }
        </ul>
        @if (hiddenCount() > 0) {
          <p class="more" i18n="@@queue.more">e mais {{ hiddenCount() }}</p>
        }
      </section>
    }
  `,
  styles: `
    .summary {
      display: grid;
      gap: var(--space-3);
    }

    .top {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-1) var(--space-3);
    }

    h3 {
      margin: 0;
      font-size: 1.25rem;
      font-weight: 700;
      letter-spacing: -0.01em;
    }

    .see {
      display: inline-flex;
      align-items: center;
      min-height: var(--target-desktop);
      color: var(--color-text-muted);
      font-size: var(--text-sm);
      font-weight: 700;
      text-decoration: none;
    }

    .see:hover {
      color: var(--color-text);
      text-decoration: underline;
    }

    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
      gap: var(--space-3);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    /* "Precisa da sua atenção": cover, title, status in a word and the direct action. */
    .card {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      min-width: 0;
      padding: var(--space-3);
      border-radius: var(--radius-card);
      background: var(--overlay-1);
    }

    .body {
      display: grid;
      flex: 1;
      gap: var(--space-1);
      min-width: 0;
    }

    .name {
      overflow: hidden;
      font-size: var(--text-sm);
      font-weight: 700;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .line {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-1) var(--space-2);
      min-width: 0;
    }

    .state,
    .more {
      min-width: 0;
      margin: 0;
      color: var(--color-text-muted);
      font-size: var(--text-xs);
      overflow-wrap: anywhere;
    }

    .action {
      flex: none;
      display: inline-flex;
      align-items: center;
      min-height: var(--target-desktop);
      padding: 0 var(--space-4);
      border-radius: var(--radius-pill);
      background: var(--overlay-3);
      color: var(--color-text);
      font-size: var(--text-meta);
      font-weight: 700;
      text-decoration: none;
    }

    .action:hover {
      background: var(--overlay-4);
    }

    .action.strong {
      background: var(--color-text);
      color: var(--color-bg);
    }

    @media (max-width: 1023px) {
      h3 {
        font-size: var(--text-md);
      }

      .see,
      .action {
        min-height: var(--target);
      }

      .cards {
        grid-template-columns: minmax(0, 1fr);
        gap: var(--space-2);
      }

      .card {
        padding: var(--space-2) var(--space-3);
      }

      .card ui-cover {
        --ui-cover-size: 40px !important;
      }

      .state {
        display: -webkit-box;
        overflow: hidden;
        -webkit-line-clamp: 1;
        -webkit-box-orient: vertical;
      }

      .action {
        padding: 0 var(--space-3);
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QueueSummary {
  private readonly store = inject(ProcessingQueueStore);
  private readonly session = inject(SessionStore);
  protected readonly path = QUEUE_PAGE_PATH;
  /** What needs the person first: with three at work it would never show. */
  private readonly shown = computed(() => {
    const items = this.store.items();
    return [
      ...items.filter(({ phase }) => phase === 'attention'),
      ...items.filter(({ phase }) => phase === 'running' || phase === 'next'),
    ];
  });
  private readonly canEdit = computed(() => this.session.can('media-edit'));
  protected readonly lines = computed(() =>
    this.shown()
      .slice(0, SHOWN)
      .map((item) => {
        const { pill, tone } = pillOf(item);
        const action = actionTextOf(item);
        return {
          id: item.mediaId,
          title: item.title,
          state: queueStateText(item),
          pill,
          tone,
          link: linkOf(item, this.canEdit()),
          action,
          actionLabel: `${action}: ${item.title}`,
          strong: item.action === 'validate' || item.action === 'conclude',
        };
      }),
  );
  protected readonly hiddenCount = computed(() =>
    Math.max(0, this.shown().length - SHOWN),
  );
  protected readonly titleText = computed(() => {
    const active = this.store.active();
    if (active === 0)
      return $localize`:@@queue.summary.waiting:Precisa da sua atenção`;
    return active === 1
      ? $localize`:@@queue.summary.one:1 áudio em processamento`
      : $localize`:@@queue.summary.many:${active}:count: áudios em processamento`;
  });
}

/** The state in a word, its tone backing it (never the colour alone). */
function pillOf(item: ProcessingQueueItem): {
  readonly pill: string;
  readonly tone: Tone;
} {
  if (item.state === 'failed')
    return { pill: $localize`:@@queue.pill.failed:Falhou`, tone: 'err' };
  if (item.waitsForTranscriber)
    return { pill: $localize`:@@queue.pill.waiting:Aguardando`, tone: 'warn' };
  if (item.action === 'validate')
    return {
      pill: $localize`:@@queue.pill.validate:Para validar`,
      tone: 'info',
    };
  if (item.phase === 'running')
    return {
      pill: $localize`:@@queue.pill.running:Em processamento`,
      tone: 'info',
    };
  return { pill: '', tone: 'muted' };
}

/** What the card's button does, in the queue's own words. */
const ACTION_TEXTS: Record<QueueAction, () => string> = {
  validate: () => $localize`:@@queue.action.validate:Validar`,
  continue: () => $localize`:@@queue.continue:Continuar`,
  conclude: () => $localize`:@@prep.conclude:Concluir`,
  retry: () => $localize`:@@prep.retry:Tentar de novo`,
};

function actionTextOf({ action }: ProcessingQueueItem): string {
  return action
    ? ACTION_TEXTS[action]()
    : $localize`:@@queue.action.details:Ver detalhes`;
}

/** Where the action happens: the plan's step for who prepares, else the audio's page. */
function linkOf(item: ProcessingQueueItem, canEdit: boolean): string {
  const { mediaId, step } = item;
  if (step === null || !canEdit || item.action === null)
    return mediaPagePath(mediaId);
  return step === 3 ? editPagePath(mediaId) : preparationPagePath(mediaId);
}
