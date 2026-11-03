import { RouterLink, RouterLinkActive } from '@angular/router';
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
  ConversationStatus,
  ConversationSummary,
  Topic,
} from '@kb-chat/contracts';
import { treeTitle } from '@core/topics/topic-tree.js';
import { CollectionDialog } from '@features/collections/collection-dialog.js';
import { HistoryStore } from '@core/history/history-store.js';
import { RESEARCH_RESTORER } from '@core/history/research-restorer.js';
import { EMPTY, Subject, catchError, switchMap } from 'rxjs';
import { SpendStore } from '@core/spend/spend-store.js';
import { THEMES, ThemeStore, type Theme } from '@core/theme/theme-store.js';
import { ChatStore } from '@features/chat/chat-store.js';
import { ViewStore } from '@features/chat/view-store.js';
import { ResearchStore } from '@features/research/research-store.js';
import { AccessRequestsStore } from '@core/auth/access-requests-store.js';
import { SettingsButton } from '@features/settings/settings-button.js';
import { SettingsStore } from '@features/settings/settings-store.js';
import { GoogleIdentity } from '@core/auth/google-identity.js';
import { SessionStore } from '@core/auth/session-store.js';

export type SidebarAction = 'new' | 'restore' | 'topic' | 'media';

const THEME_LABELS: Record<Theme, () => string> = {
  auto: () => $localize`:@@theme.auto:Automático (claro/escuro)`,
  light: () => $localize`:@@theme.light:Claro`,
  dark: () => $localize`:@@theme.dark:Escuro`,
  esoteric: () => $localize`:@@theme.esoteric:Esotérico`,
};

/** How a conversation stands, in words (KBC-029): never color alone. */
const STATUS_LABELS: Record<ConversationStatus, () => string> = {
  pending: () => $localize`:@@sidebar.statusPending:pesquisando…`,
  interrupted: () => $localize`:@@sidebar.statusInterrupted:interrompida`,
  failed: () => $localize`:@@sidebar.statusFailed:falhou`,
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
  imports: [
    DecimalPipe,
    SettingsButton,
    RouterLink,
    RouterLinkActive,
    CollectionDialog,
  ],
  templateUrl: './sidebar.html',
  styleUrl: './sidebar.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Sidebar {
  protected readonly chat = inject(ChatStore);
  private readonly views = inject(ViewStore);
  private readonly research = inject(ResearchStore);
  protected readonly history = inject(HistoryStore);
  protected readonly spend = inject(SpendStore);
  /** One's own AI on free models or a free tier (KBC-023): no spend in US$ to show. */
  protected readonly ownFree = computed(() => {
    const status = this.settings.aiStatus.hasValue()
      ? this.settings.aiStatus.value()
      : null;
    return status?.source === 'own' && status.free;
  });
  /**
   * Served by the app's AI (KBC-022): its researches left instead of a spend in US$ the person
   * does not pay; null otherwise.
   */
  protected readonly appServed = computed(() => {
    const status = this.settings.aiStatus.hasValue()
      ? this.settings.aiStatus.value()
      : null;
    if (status?.source !== 'app' || status.remainingToday === null) return null;
    return {
      remaining: status.remainingToday,
      daily: status.dailyResearches ?? status.remainingToday,
    };
  });
  private readonly themes = inject(ThemeStore);
  protected readonly session = inject(SessionStore);
  /** The count badge on "Pessoas e permissões" (masters, KBC-014). */
  protected readonly requests = inject(AccessRequestsStore);
  private readonly google = inject(GoogleIdentity);
  private readonly settings = inject(SettingsStore);
  /** Research conversations go to the research view (KBC-008 FR-6), shown as saved. */
  private readonly restorer = inject(RESEARCH_RESTORER);
  /** A newer click cancels the load of the previous one. */
  private readonly opens = new Subject<string>();
  /** The parent closes the drawer and moves focus after each action. */
  readonly acted = output<SidebarAction>();

  protected readonly theme = this.themes.theme;
  /** "Mídia" (T14): when the server has the media library on and a collection is chosen. */
  protected readonly mediaOn = computed(
    () =>
      this.session.me()?.media === true &&
      this.session.can('media') &&
      this.chat.topicSlug() !== null,
  );
  /** The signed-in person's initial, when Google gave no picture. */
  protected readonly initial = computed(() => {
    const me = this.session.me();
    return (me?.name || me?.email || '?').charAt(0).toUpperCase();
  });
  protected readonly themeOptions = THEMES.map((value) => ({
    value,
    label: THEME_LABELS[value](),
  }));
  /** The conversation on screen: the one of the current view (KBC-008 FR-5). */
  protected readonly currentId = computed(() =>
    this.views.current() === 'research'
      ? this.research.conversationId()
      : this.chat.conversationId(),
  );
  protected readonly titles = computed(
    () => new Map(this.chat.topicList().map((t) => [t.slug, t.title])),
  );
  /**
   * The history with how each conversation stands (KBC-029): the one on screen from what this
   * page sees (a search or research still running), the others as the server keeps them.
   */
  protected readonly entries = computed(() => {
    const searching = this.chat.searching() ? this.chat.conversationId() : null;
    const researching = this.research.streaming()
      ? this.research.conversationId()
      : null;
    return this.history.conversations().map((conversation) => {
      const running =
        conversation.id === searching || conversation.id === researching;
      const status = running ? 'pending' : conversation.status;
      return { ...conversation, status };
    });
  });
  protected readonly statusLabels: Record<ConversationStatus, string> = {
    pending: STATUS_LABELS.pending(),
    interrupted: STATUS_LABELS.interrupted(),
    failed: STATUS_LABELS.failed(),
  };
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

  /** "+ Nova conversa" starts over in the current view; the other one keeps its conversation. */
  protected startNew(): void {
    if (this.views.current() === 'research') this.research.newConversation();
    else this.chat.newConversation();
    this.acted.emit('new');
  }

  /** Loads the whole conversation, then restores it by kind. */
  protected open(summary: ConversationSummary): void {
    this.opens.next(summary.id);
  }

  /**
   * Search re-runs its asks in the search view; research shows what was saved in the
   * research view, never calling the AI again.
   */
  private restoreLoaded(conversation: Conversation): void {
    if (conversation.kind === 'search') {
      this.views.select('search');
      this.chat.restore(conversation);
    } else this.restorer.restore(conversation);
    this.acted.emit('restore');
  }

  protected openMedia(): void {
    this.acted.emit('media');
  }

  /** "Novo acervo" and "Editar acervo" (KBC-048 FR-6): only with "Criar acervos". */
  protected readonly canCreateCollections = computed(() =>
    this.session.can('collection-create'),
  );
  protected readonly treeTitle = treeTitle;

  /** A new collection opens at once (≤ 2 s, NFR-1); a renamed one keeps its place. */
  protected collectionSaved(topic: Topic): void {
    this.chat.putTopic(topic);
    if (topic.slug !== this.chat.topicSlug()) this.changeTopic(topic.slug);
  }

  protected changeTopic(slug: string): void {
    this.chat.selectTopic(slug);
    this.acted.emit('topic');
  }

  /** "Pessoas e permissões" (masters): the Configurações section of its own. */
  protected openPeople(): void {
    this.settings.openSettings('people');
  }

  protected signOut(): void {
    this.google.disableAutoSelect();
    // The page starts over at the login screen once the session is gone (SessionStore).
    this.session.signOut().subscribe();
  }

  protected changeTheme(value: string): void {
    const theme = THEMES.find((t) => t === value);
    if (theme) this.themes.set(theme);
  }
}
