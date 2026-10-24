import { DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
} from '@angular/core';
import {
  HistoryStore,
  type Conversation,
} from '@core/history/history-store.js';
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

/** Side panel: new conversation, history in this browser, collection, theme and spend (screens.md T5). */
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

  protected startNew(): void {
    this.chat.newConversation();
    this.acted.emit('new');
  }

  protected open(conversation: Conversation): void {
    this.chat.restore(conversation);
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
