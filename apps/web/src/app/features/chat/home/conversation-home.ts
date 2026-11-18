import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { EMPTY, Subject, catchError, switchMap } from 'rxjs';
import type {
  Conversation,
  ConversationKind,
  ConversationStatus,
} from '@kb-chat/contracts';
import { HistoryStore } from '@core/history/history-store.js';
import { RESEARCH_RESTORER } from '@core/history/research-restorer.js';
import type { SidebarAction } from '@features/sidebar/sidebar.js';
import { PendingTranscriptions } from '@features/transcribers/pending-transcriptions.js';
import { UiBanner, UiButton, UiCover, UiEmptyState } from '@ui/index.js';
import { ChatStore } from '../chat-store.js';
import { ViewStore } from '../view-store.js';
import { homeTiles, type HomeTile } from './home-tiles.js';

/** A subject card of "Comece por um assunto" (KBC-006 FR-1). */
export interface HomeSubject {
  readonly concept: string;
}

const KIND_LABELS: Record<ConversationKind, () => string> = {
  search: () => $localize`:@@home.kindSearch:Busca`,
  research: () => $localize`:@@home.kindResearch:Pesquisa com IA`,
};

const STATUS_LABELS: Record<ConversationStatus, () => string> = {
  pending: () => $localize`:@@home.statusPending:pesquisando…`,
  interrupted: () => $localize`:@@home.statusInterrupted:interrompida`,
  failed: () => $localize`:@@home.statusFailed:falhou`,
};

/**
 * The conversation's start in v2 (KBC-126): scope chips and "Em: <acervo>", the greeting,
 * up to six recent shortcuts from the server's history, "Comece por um assunto" as cards
 * and, instead of them, the states of the collections (error, none, empty).
 */
@Component({
  selector: 'app-conversation-home',
  imports: [PendingTranscriptions, UiBanner, UiButton, UiCover, UiEmptyState],
  templateUrl: './conversation-home.html',
  styleUrl: './conversation-home.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConversationHome {
  protected readonly store = inject(ChatStore);
  protected readonly views = inject(ViewStore);
  private readonly history = inject(HistoryStore);
  private readonly restorer = inject(RESEARCH_RESTORER);

  readonly researching = input(false);
  /** "Nova conversa em <acervo>" after choosing another collection. */
  readonly topicNotice = input('');
  readonly topicsError = input('');
  readonly noTopics = input(false);
  /** A member sees only what a master granted: "peça a um master" (KBC-010). */
  readonly guest = input(false);
  readonly emptyTopic = input(false);
  /** The collection whose transcriptions a master may publish (KBC-114), or null. */
  readonly pendingTopic = input<string | null>(null);
  readonly subjects = input<readonly HomeSubject[]>([]);
  readonly subjectChosen = output<string>();
  readonly reloadTopics = output();
  /** The same actions as the library's: the page moves the focus after them. */
  readonly acted = output<SidebarAction>();

  protected readonly errorAgain = $localize`:@@message.errorText:Tente de novo.`;
  /** The topics' error without its "Tente de novo.", which goes on the line under it. */
  protected readonly topicsErrorTitle = computed(() => {
    const text = this.topicsError();
    return text.endsWith(` ${this.errorAgain}`)
      ? text.slice(0, -this.errorAgain.length - 1)
      : text;
  });
  /** The shortcuts with what each one says under its title. */
  protected readonly tiles = computed(() =>
    homeTiles(this.history.conversations(), this.store.topicList()).map(
      (tile) => ({
        tile,
        title:
          tile.kind === 'collection'
            ? tile.topic.title
            : tile.conversation.title,
        meta: this.tileMeta(tile),
      }),
    ),
  );
  private readonly opens = new Subject<string>();

  constructor() {
    this.opens
      .pipe(
        // A failed load is reported by HistoryStore.lastError, as in the library.
        switchMap((id) => this.history.load(id).pipe(catchError(() => EMPTY))),
        takeUntilDestroyed(),
      )
      .subscribe((conversation) => this.restoreLoaded(conversation));
  }

  protected chooseCollection(slug: string): void {
    this.store.selectTopic(slug);
    this.acted.emit('topic');
  }

  protected openTile(tile: HomeTile): void {
    if (tile.kind === 'collection') this.chooseCollection(tile.topic.slug);
    else this.opens.next(tile.conversation.id);
  }

  /** "Busca · Hermetismo · falhou": what the tile is, where, and how it stands. */
  private tileMeta(tile: HomeTile): string {
    if (tile.kind === 'collection')
      return $localize`:@@home.tileCollection:Acervo`;
    const { kind, status, topic } = tile.conversation;
    const where = this.store.topicList().find((t) => t.slug === topic)?.title;
    return [KIND_LABELS[kind](), where, status ? STATUS_LABELS[status]() : null]
      .filter((part): part is string => !!part)
      .join(' · ');
  }

  /** Search re-runs its asks; research shows what was saved, never calling the AI again. */
  private restoreLoaded(conversation: Conversation): void {
    if (conversation.kind === 'search') {
      this.views.select('search');
      this.store.restore(conversation);
    } else this.restorer.restore(conversation);
    this.acted.emit('restore');
  }
}
