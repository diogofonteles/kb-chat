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
import { UiIcon } from '@ui/icon.js';
import { UiPill, type Tone } from '@ui/pill.js';
import {
  TranscribeWithGroq,
  type GroqCandidate,
} from '../transcribe-with-groq.js';
import { ProcessingQueueStore } from './processing-queue-store.js';
import { queueStateText } from './queue-labels.js';
import { STAGE_NAMES } from '../preparation/preparation-labels.js';

/** How many audios the block shows; the page has the rest. */
const SHOWN = 3;

/**
 * The queue, in brief, on the library (KBC-090; v2 KBC-128 FR-2 "Precisa da sua atenção"):
 * one card per audio with its cover, its state in a word and in full, and the direct action
 * (validate, continue, conclude, try again, transcribe with Groq, or see the details). On a
 * phone, one card sums it all up and leads to the queue (media-library@mobile), so the list
 * starts above the fold. Nothing when nothing is there.
 */
@Component({
  selector: 'app-queue-summary',
  imports: [RouterLink, TranscribeWithGroq, UiCover, UiIcon, UiPill],
  template: `
    @if (lines().length > 0) {
      <section class="summary" aria-labelledby="queue-summary-title">
        <a class="phone-card" [routerLink]="path">
          <ui-cover icon="upload" from="#1f9c56" to="#0b3d22" [size]="40" />
          <span class="body">
            <span class="name">{{ compactTitle() }}</span>
            <span class="state">{{ compactParts() }}</span>
          </span>
          <ui-icon class="chevron" name="chevRight" [size]="20" />
        </a>
        <div class="top">
          <h3 id="queue-summary-title">{{ titleText() }}</h3>
          <a class="see" [routerLink]="path" i18n="@@queue.open">Ver a fila</a>
        </div>
        <ul class="cards">
          @for (line of lines(); track line.id) {
            <li class="card">
              @if (!line.groq && !line.hasAction) {
                <a
                  class="card-link"
                  [routerLink]="line.link"
                  [attr.aria-label]="line.actionLabel"
                ></a>
              }
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
              @if (line.groq; as groq) {
                <app-transcribe-with-groq
                  [media]="groq"
                  [subject]="line.title"
                  [compact]="true"
                  (sent)="refresh()"
                  (capped)="refresh()"
                />
              } @else if (line.hasAction) {
                <a
                  class="action"
                  [class.strong]="line.strong"
                  [routerLink]="line.link"
                  [attr.aria-label]="line.actionLabel"
                  >{{ line.action }}</a
                >
              }
            </li>
          }
        </ul>
      </section>
    }
  `,
  styles: `
    :host {
      display: block;
      container: queue-summary / inline-size;
    }

    .summary {
      display: grid;
      gap: var(--space-3);
    }

    /* The phone's single card (media-library@mobile): hidden on a wide screen. */
    .phone-card {
      display: none;
      align-items: center;
      gap: var(--space-3);
      min-width: 0;
      padding: var(--space-3);
      border-radius: var(--radius-menu);
      background: var(--overlay-1);
      color: var(--color-text);
      text-decoration: none;
    }

    .phone-card:hover {
      background: var(--overlay-2);
    }

    .phone-card:focus-visible {
      outline: 2px solid var(--color-focus);
      outline-offset: 2px;
    }

    .chevron {
      flex: none;
      color: var(--color-text-muted);
    }

    .top {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-1) var(--space-3);
    }

    /* v2 · media-library: "Precisa da sua atenção" 20/24, "Ver a fila" 13 on the same line. */
    h3 {
      margin: 0;
      font-size: 1.25rem;
      font-weight: 700;
      line-height: 1.5rem;
      letter-spacing: -0.01em;
    }

    .see {
      display: inline-flex;
      align-items: center;
      min-height: 1.5rem;
      color: var(--color-text-muted);
      font-size: var(--text-meta);
      font-weight: 700;
      text-decoration: none;
    }

    .see:hover {
      color: var(--color-text);
      text-decoration: underline;
    }

    /* Three cards side by side; two on a narrow panel (media-library, the right panel open). */
    .cards {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      align-items: start;
      gap: var(--space-3);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    /* "Precisa da sua atenção": cover, title, status in a word and the direct action. */
    @container queue-summary (max-width: 52rem) {
      .cards {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .card:nth-child(n + 3) {
        display: none;
      }
    }

    /* A card with nothing to do here is its own way to the details. */
    .card-link {
      position: absolute;
      inset: 0;
      border-radius: inherit;
    }

    .card-link:hover {
      background: var(--overlay-1);
    }

    .card-link:focus-visible {
      outline: 2px solid var(--color-focus);
      outline-offset: 2px;
    }

    /* Cover and text on a row; the action beside them while the text keeps its room (11rem),
       else on its own row under them, never squeezing the text. */
    .card {
      position: relative;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-3);
      min-width: 0;
      padding: var(--space-3);
      border-radius: var(--radius-card);
      background: var(--overlay-1);
    }

    .card > ui-cover {
      flex: none;
      align-self: flex-start;
    }

    .body {
      display: grid;
      flex: 1 1 10rem;
      gap: var(--space-1);
      min-width: 0;
    }

    /* A long title takes two lines, then "…". */
    .name {
      display: -webkit-box;
      overflow: hidden;
      font-size: var(--text-sm);
      font-weight: 700;
      line-height: 1.3;
      overflow-wrap: anywhere;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      line-clamp: 2;
    }

    /* The pill, then the words on the text's whole width: three lines at most. */
    .line {
      display: -webkit-box;
      overflow: hidden;
      font-size: var(--text-xs);
      line-height: 1.5;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 3;
      line-clamp: 3;
    }

    .line ui-pill {
      display: inline-flex;
      margin-inline-end: var(--space-2);
      vertical-align: middle;
    }

    .state {
      margin: 0;
      color: var(--color-text-muted);
    }

    app-transcribe-with-groq {
      flex: none;
    }

    /* Its question and its estimate take the card's whole width. */
    app-transcribe-with-groq:has(.confirm, .error) {
      flex-basis: 100%;
    }

    .action {
      position: relative;
      flex: none;
      display: inline-flex;
      align-items: center;
      min-height: 2rem;
      padding: 0 0.875rem;
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
      .phone-card {
        display: flex;
      }

      .top,
      .cards {
        display: none;
      }

      /* v2 · media-library@mobile: the count 14/700, what each needs 12 under it. */
      .phone-card .body {
        gap: 0.125rem;
      }

      .phone-card .name {
        font-size: var(--text-sm);
        font-weight: 700;
      }

      .phone-card .state {
        font-size: var(--text-xs);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
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
          state: cardStateOf(item, this.store.queue()?.transcriber ?? null),
          pill,
          tone,
          link: linkOf(item, this.canEdit()),
          action,
          actionLabel: `${action}: ${item.title}`,
          strong: item.action === 'validate' || item.action === 'conclude',
          hasAction: item.action !== null,
          groq: groqOf(item),
        };
      }),
  );
  /** The phone's card: how many, then what each needs (media-library@mobile). */
  protected readonly compactTitle = computed(() => {
    const active = this.store.active();
    if (active > 0) return this.titleText();
    const count = this.shown().length;
    return count === 1
      ? $localize`:@@queue.summary.attentionOne:1 item precisa de atenção`
      : $localize`:@@queue.summary.attentionMany:${count}:count: itens precisam de atenção`;
  });
  protected readonly compactParts = computed(() =>
    partsOf(this.shown()).join(' · '),
  );
  protected readonly titleText = computed(() => {
    const active = this.store.active();
    if (active === 0)
      return $localize`:@@queue.summary.waiting:Precisa da sua atenção`;
    return active === 1
      ? $localize`:@@queue.summary.one:1 áudio em processamento`
      : $localize`:@@queue.summary.many:${active}:count: áudios em processamento`;
  });

  /** Groq took it, or the cap held it: the queue says where it is now. */
  protected refresh(): void {
    this.store.refresh();
  }
}

/** Groq may take this one now (KBC-037): the card offers it in place of the details. */
function groqOf(item: ProcessingQueueItem): GroqCandidate | null {
  if (!item.waitsForTranscriber || !item.canUseGroq) return null;
  return { id: item.mediaId, durationMs: item.durationMs, canUseGroq: true };
}

/** "1 para validar · 1 falhou · 1 aguardando", leaving out what has none. */
function partsOf(items: readonly ProcessingQueueItem[]): string[] {
  const count = (test: (item: ProcessingQueueItem) => boolean) =>
    items.filter(test).length;
  const validate = count(({ action }) => action === 'validate');
  const failed = count(({ state }) => state === 'failed');
  const waiting = count(
    (item) => item.state !== 'failed' && item.waitsForTranscriber,
  );
  const working = count(
    (item) =>
      item.state !== 'failed' &&
      !item.waitsForTranscriber &&
      (item.phase === 'running' || item.phase === 'next'),
  );
  return [
    validate > 0 &&
      $localize`:@@queue.part.validate:${validate}:count: para validar`,
    failed > 0 &&
      (failed === 1
        ? $localize`:@@queue.part.failedOne:1 falhou`
        : $localize`:@@queue.part.failedMany:${failed}:count: falharam`),
    waiting > 0 &&
      $localize`:@@queue.part.waiting:${waiting}:count: aguardando`,
    working > 0 &&
      $localize`:@@queue.part.working:${working}:count: em processamento`,
  ].filter((part): part is string => typeof part === 'string');
}

/**
 * The card's second line, short (media-library "Precisa da sua atenção": "Falta validar as
 * faixas", "Falhou · conversão", "Aguardando · transcritor desligado"); the queue page keeps
 * the long words (queueStateText).
 */
function cardStateOf(
  item: ProcessingQueueItem,
  transcriber: string | null,
): string {
  // A failure with its own reason says it (the stage, then why; clamped to three lines);
  // one that only "did not finish" names the stage (media-library: "Falhou · conversão").
  if (item.state === 'failed' && item.stage)
    return item.failure && item.failure !== 'work'
      ? queueStateText(item)
      : STAGE_NAMES[item.stage]().toLocaleLowerCase('pt-BR');
  if (item.waitsForTranscriber)
    return transcriber === 'off'
      ? $localize`:@@queue.card.transcriberOff:transcritor desligado`
      : $localize`:@@queue.card.transcriberQueue:na fila do transcritor`;
  if (item.action === 'validate')
    return $localize`:@@queue.card.validate:Falta validar as faixas`;
  return queueStateText(item);
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
