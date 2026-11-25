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
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
import { formatDate } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import type {
  DocumentUpload,
  MediaPreparation,
  ProcessingQueue,
  ProcessingQueueItem,
  QueuePhase,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { SessionStore } from '@core/auth/session-store.js';
import { editPagePath } from '@core/media/media-edit-api.js';
import { PreparationApi } from '@core/media/preparation-api.js';
import { ChatStore } from '@features/chat/chat-store.js';
import type { Observable } from 'rxjs';
import { ProcessingQueueStore } from './processing-queue-store.js';
import { UiButton, UiCover, UiIcon } from '@ui/index.js';
import { QueueRow, type QueueMove } from './queue-row.js';
import {
  DocumentUploadsSection,
  type OpenedDocument,
} from '@features/document-upload/document-uploads-section.js';
import {
  phaseOf,
  type UploadPhase,
} from '@features/document-upload/document-progress.js';
import { DocumentUploadsStore } from '@features/document-upload/document-uploads-store.js';

/** The sections of the queue: what needs the person first (UP-02). */
const SECTIONS: readonly {
  readonly phase: QueuePhase;
  readonly title: () => string;
}[] = [
  {
    phase: 'attention',
    title: () => $localize`:@@queue.attention:Precisa de você`,
  },
  { phase: 'running', title: () => $localize`:@@queue.running:Agora` },
  { phase: 'next', title: () => $localize`:@@queue.next.title:A seguir` },
  {
    phase: 'stopped',
    title: () => $localize`:@@queue.stopped:Parados no acervo`,
  },
];

/**
 * "Fila de processamento" (T23, KBC-090): one place for what is at work, what comes next and
 * what waits for a person, for the audios this person may see. The moves answer here; what
 * opens a step goes to its page.
 */
@Component({
  selector: 'app-processing-queue-page',
  imports: [
    RouterLink,
    QueueRow,
    DocumentUploadsSection,
    UiButton,
    UiCover,
    UiIcon,
  ],
  // KBC-149: the sent documents, read for this page only.
  providers: [DocumentUploadsStore],
  templateUrl: './processing-queue-page.html',
  styleUrls: [
    '../preparation/preparation-buttons.css',
    './processing-queue-page.css',
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProcessingQueuePage {
  private readonly api = inject(PreparationApi);
  private readonly chat = inject(ChatStore);
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);
  private readonly locale = inject(LOCALE_ID);
  private readonly destroyRef = inject(DestroyRef);
  private readonly heading =
    viewChild.required<ElementRef<HTMLElement>>('heading');
  private readonly body = viewChild.required<ElementRef<HTMLElement>>('body');
  private readonly rows = viewChildren(QueueRow);
  protected readonly store = inject(ProcessingQueueStore);
  private readonly documents = inject(DocumentUploadsStore);

  /** The audio a press is on: one at a time, and read before anything else (PD-02). */
  protected readonly acting = signal<string | null>(null);
  protected readonly actionError = signal('');
  protected readonly canEdit = computed(() => this.session.can('media-edit'));
  protected readonly loading = computed(
    () => this.store.queue() === null && !this.store.failed(),
  );
  protected readonly loadFailed = computed(
    () => this.store.queue() === null && this.store.failed(),
  );
  protected readonly stale = computed(
    () => this.store.queue() !== null && this.store.failed(),
  );
  protected readonly empty = computed(
    () =>
      this.store.queue() !== null &&
      this.store.items().length === 0 &&
      this.documents.items().length === 0,
  );
  /** Each row with the name of its collection, read once per reading (NG-08). */
  protected readonly sections = computed(() => {
    const titles = this.titles();
    return SECTIONS.map(({ phase, title }) => ({
      phase,
      title: title(),
      rows: this.store
        .items()
        .filter((item) => item.phase === phase)
        .map((item) => ({
          item,
          topicTitle: titles.get(item.topic) ?? item.topic,
        })),
    })).filter(({ rows }) => rows.length > 0);
  });
  /** The art's side: 208 on desktop, 120 on a phone. */
  protected readonly artSize = 208;
  /** "32 itens · 2 precisam de você · 28 a seguir": audios and sent documents together. */
  protected readonly summary = computed(() =>
    this.store.queue() === null
      ? ''
      : summaryText(this.store.items(), this.documents.items()),
  );

  /** "Aguardando o transcritor": the usual reason nothing moves, in a title and a line. */
  protected readonly transcriberText = computed(() => {
    const queue = this.store.queue();
    if (!this.store.items().some((one) => one.waitsForTranscriber)) return null;
    const since = queue?.transcriberOffSince;
    const title = $localize`:@@queue.transcriberTitle:Aguardando o transcritor`;
    if (queue?.transcriber === 'none')
      return {
        title,
        text: $localize`:@@queue.noTranscriberText:Nenhum transcritor está pareado. Um master pareia em Transcritores.`,
      };
    return {
      title,
      text: since
        ? $localize`:@@queue.transcriberOffText:Desligado desde ${formatDate(since, 'dd/MM HH:mm', this.locale)}:date:. Nada anda até ele voltar.`
        : $localize`:@@queue.transcriberWaitingText:Nada anda até ele voltar.`,
    };
  });
  protected readonly titles = computed(
    () => new Map(this.chat.topicList().map((one) => [one.slug, one.title])),
  );

  /** The audio that keeps the focus once the next reading is on screen. */
  private refocusing: {
    readonly mediaId: string;
    readonly seen: ProcessingQueue | null;
  } | null = null;

  constructor() {
    this.store.refresh();
    // Before what holds the focus goes away for "Nada processando" (WCAG 2.4.3).
    effect(() => {
      if (!this.empty()) return;
      const body = untracked(this.body).nativeElement;
      if (body.contains(body.ownerDocument.activeElement)) this.focusHeading();
    });
    // A row may change section, and a new row takes its place: only the new reading tells.
    afterRenderEffect(() => {
      const queue = this.store.queue();
      const failed = this.store.failed();
      const wanted = this.refocusing;
      if (!wanted || (queue === wanted.seen && !failed)) return;
      this.refocusing = null;
      this.focusRow(wanted.mediaId);
    });
  }

  protected focusHeading(): void {
    this.heading().nativeElement.focus();
  }

  /** The button pressed may be gone, and the row too: the focus never falls to the page. */
  private focusRow(mediaId: string): void {
    const row = this.rows().find((one) => one.item().mediaId === mediaId);
    if (row) row.focusTitle();
    else this.focusHeading();
  }

  /** A sent document, ready: it opens in the conversation's reading panel, as the sidebar's. */
  protected openDocument(doc: OpenedDocument): void {
    this.chat.open(doc.topic, { id: doc.id, title: doc.title });
    void this.router.navigateByUrl('/');
  }

  protected reload(): void {
    this.store.refresh();
  }

  protected move(item: ProcessingQueueItem, move: QueueMove): void {
    if (this.acting() !== null) return;
    const { mediaId, action } = item;
    const request =
      move.kind === 'retry'
        ? this.api.retry(mediaId, move.stage)
        : this.api.advance(mediaId);
    this.act(mediaId, request, action === 'validate');
  }

  private act(
    mediaId: string,
    request: Observable<MediaPreparation>,
    toValidation: boolean,
  ): void {
    this.acting.set(mediaId);
    this.actionError.set('');
    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.acting.set(null);
        if (toValidation) void this.router.navigateByUrl(editPagePath(mediaId));
        else this.refreshAndKeepFocus(mediaId);
      },
      error: (err: unknown) => {
        this.acting.set(null);
        this.actionError.set(errorMessage(toUiErrorCode(err)));
        this.refreshAndKeepFocus(mediaId);
      },
    });
  }

  private refreshAndKeepFocus(mediaId: string): void {
    this.refocusing = { mediaId, seen: this.store.queue() };
    this.store.refresh();
  }
}

/**
 * How each sent document stands. What is ready waits for nothing: it is not being processed; and
 * a recording that came by its link is in both lists, as one thing.
 */
function sentPhases(
  items: readonly ProcessingQueueItem[],
  documents: readonly DocumentUpload[],
): readonly UploadPhase[] {
  const recordings = new Set(items.map((one) => one.mediaId));
  return documents
    .filter((one) => one.mediaId === null || !recordings.has(one.mediaId))
    .map(phaseOf)
    .filter((phase) => phase !== 'ready');
}

function summaryText(
  items: readonly ProcessingQueueItem[],
  documents: readonly DocumentUpload[],
): string {
  const sent = sentPhases(items, documents);
  const total = items.length + sent.length;
  if (total === 0)
    return $localize`:@@queue.summaryNone:Nada sendo processado agora`;
  const need =
    items.filter((one) => one.phase === 'attention').length +
    sent.filter((phase) => phase === 'yours' || phase === 'failed').length;
  const next =
    items.filter((one) => one.phase === 'next').length +
    sent.filter((phase) => phase === 'waiting').length;
  const parts = [
    total === 1
      ? $localize`:@@queue.summaryOne:1 item`
      : $localize`:@@queue.summaryMany:${total}:count: itens`,
  ];
  if (need > 0)
    parts.push(
      need === 1
        ? $localize`:@@queue.summaryNeedPart:1 precisa de você`
        : $localize`:@@queue.summaryNeedMany:${need}:need: precisam de você`,
    );
  if (next > 0)
    parts.push($localize`:@@queue.summaryNext:${next}:next: a seguir`);
  return parts.join(' · ');
}
