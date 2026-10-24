import { DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type {
  Conversation,
  ConversationKind,
  ConversationSummary,
} from '@kb-chat/contracts';
import { HistoryStore } from '@core/history/history-store.js';
import { RESEARCH_RESTORER } from '@core/history/research-restorer.js';
import { EMPTY, Subject, catchError, switchMap } from 'rxjs';
import { SpendStore } from '@core/spend/spend-store.js';
import { THEMES, ThemeStore, type Theme } from '@core/theme/theme-store.js';
import { ChatStore } from '@features/chat/chat-store.js';

export type SidebarAction = 'new' | 'restore' | 'topic';

const THEME_LABELS: Record<Theme, () => string> = {
  auto: () => $localize`:@@theme.auto:Automático (claro/escuro)`,
  light: () => $localize`:@@theme.light:Claro`,
  dark: () => $localize`:@@theme.dark:Escuro`,
  esoteric: () => $localize`:@@theme.esoteric:Esotérico`,
};

const KIND_LABELS: Record<ConversationKind, () => string> = {
  search: () => $localize`:@@sidebar.kindSearch:Busca`,
  research: () => $localize`:@@sidebar.kindResearch:IA`,
};

/**
 * Side panel: new conversation, the complete history on this computer, collection, theme and spend (screens.md T5).
 * A container of the chat page: it works on the page-scoped ChatStore, shown both as a column
 * and inside the phone drawer, so passing a dozen inputs and outputs through ChatPage would not help.
 */
@Component({
  selector: 'app-sidebar',
  imports: [DecimalPipe],
  templateUrl: './sidebar.html',
  styleUrl: './sidebar.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Sidebar {
  protected readonly chat = inject(ChatStore);
  protected readonly history = inject(HistoryStore);
  protected readonly spend = inject(SpendStore);
  private readonly themes = inject(ThemeStore);
  /** Research conversations go to the research view (KBC-008 FR-6); no-op until it exists. */
  private readonly research = inject(RESEARCH_RESTORER);
  /** A newer click cancels the load of the previous one. */
  private readonly opens = new Subject<string>();
  /** The parent closes the drawer and moves focus after each action. */
  readonly acted = output<SidebarAction>();

  protected readonly theme = this.themes.theme;
  protected readonly themeOptions = THEMES.map((value) => ({
    value,
    label: THEME_LABELS[value](),
  }));
  protected readonly titles = computed(
    () => new Map(this.chat.topicList().map((t) => [t.slug, t.title])),
  );
  protected readonly kindLabels: Record<ConversationKind, string> = {
    search: KIND_LABELS.search(),
    research: KIND_LABELS.research(),
  };

  constructor() {
    this.opens
      .pipe(
        // A failed load is reported by HistoryStore.lastError; the list stays usable.
        switchMap((id) => this.history.load(id).pipe(catchError(() => EMPTY))),
        takeUntilDestroyed(),
      )
      .subscribe((conversation) => this.restoreLoaded(conversation));
  }

  protected startNew(): void {
    this.chat.newConversation();
    this.acted.emit('new');
  }

  /** Loads the whole conversation, then restores it by kind. */
  protected open(summary: ConversationSummary): void {
    this.opens.next(summary.id);
  }

  /** Search re-runs its asks; research shows what was saved, never calling the AI again. */
  private restoreLoaded(conversation: Conversation): void {
    if (conversation.kind === 'search') this.chat.restore(conversation);
    else this.research.restore(conversation);
    this.acted.emit('restore');
  }

  protected changeTopic(slug: string): void {
    this.chat.selectTopic(slug);
    this.acted.emit('topic');
  }

  protected changeTheme(value: string): void {
    const theme = THEMES.find((t) => t === value);
    if (theme) this.themes.set(theme);
  }
}
