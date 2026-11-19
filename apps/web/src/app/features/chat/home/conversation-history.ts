import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type {
  Conversation,
  ConversationKind,
  ConversationSummary,
} from '@kb-chat/contracts';
import { EMPTY, Subject, catchError, switchMap } from 'rxjs';
import { HistoryStore } from '@core/history/history-store.js';
import { RESEARCH_RESTORER } from '@core/history/research-restorer.js';
import { UiButton } from '@ui/button.js';
import { UiDialog } from '@ui/dialog.js';
import { UiIcon } from '@ui/icon.js';
import { UiMenu, UiMenuItem } from '@ui/menu.js';
import { ChatStore } from '../chat-store.js';
import { ViewStore } from '../view-store.js';

/** The list's chips: every conversation, or one kind (chat-history@mobile). */
type HistoryFilter = 'all' | ConversationKind;

interface HistoryRow {
  readonly summary: ConversationSummary;
  /** "Pesquisa com IA · falhou", "Busca · Hermetismo". */
  readonly meta: string;
  readonly failed: boolean;
}

const KIND_LABELS: Record<ConversationKind, string> = {
  research: $localize`:@@history.kindResearch:Pesquisa com IA`,
  search: $localize`:@@history.kindSearch:Busca`,
};

const STATUS_LABELS = {
  pending: $localize`:@@sidebar.statusPending:pesquisando…`,
  interrupted: $localize`:@@sidebar.statusInterrupted:interrompida`,
  failed: $localize`:@@sidebar.statusFailed:falhou`,
} as const;

/**
 * A phone's "Conversas" list (v2 · Conversa, chat-history@mobile): the chips Tudo · Pesquisa
 * com IA · Busca, then each conversation as a 52 cover with its kind's icon, the question and
 * "kind · how it stands" (or its collection), and ⋯ (Abrir, Apagar conversa). Opening one
 * restores it as the library does: a search re-runs, a research shows what was saved.
 */
@Component({
  selector: 'app-conversation-history',
  imports: [UiButton, UiDialog, UiIcon, UiMenu, UiMenuItem],
  template: `
    <div
      class="chips"
      role="radiogroup"
      aria-label="Mostrar conversas"
      i18n-aria-label="@@history.filter"
    >
      @for (chip of chips; track chip.id) {
        <button
          type="button"
          class="ui-chip"
          role="radio"
          [class.ui-chip--on]="filter() === chip.id"
          [attr.aria-checked]="filter() === chip.id"
          (click)="filter.set(chip.id)"
        >
          {{ chip.label }}
        </button>
      }
    </div>
    @if (rows().length === 0) {
      <p class="empty" i18n="@@history.empty">Suas conversas aparecem aqui.</p>
    } @else {
      <ul class="rows" aria-label="Conversas" i18n-aria-label="@@history.list">
        @for (row of rows(); track row.summary.id) {
          <li class="row">
            <button type="button" class="open" (click)="open(row.summary)">
              <span
                class="cover"
                [class.research]="row.summary.kind === 'research'"
                aria-hidden="true"
              >
                <ui-icon
                  [name]="
                    row.summary.kind === 'research' ? 'sparkle' : 'search'
                  "
                  [size]="22"
                />
              </span>
              <span class="text">
                <span class="title">{{ row.summary.title }}</span>
                <span class="meta" [class.failed]="row.failed">{{
                  row.meta
                }}</span>
              </span>
            </button>
            <ui-menu
              class="more"
              label="Opções da conversa"
              i18n-label="@@history.moreMenu"
              triggerLabel="Mais opções: {{ row.summary.title }}"
              i18n-triggerLabel="@@history.more"
              [menuId]="'history-' + row.summary.id"
              triggerClass="ui-icon-button"
              align="end"
            >
              <ui-icon uiMenuTrigger name="more" [size]="20" />
              <button uiMenuItem type="button" (click)="open(row.summary)">
                <ui-icon name="chevRight" [size]="18" />
                <span i18n="@@history.open">Abrir</span>
              </button>
              <button uiMenuItem type="button" (click)="askRemove(row.summary)">
                <ui-icon name="trash" [size]="18" />
                <span i18n="@@history.remove">Apagar conversa</span>
              </button>
            </ui-menu>
          </li>
        }
      </ul>
    }
    <ui-dialog
      #confirm
      title="Apagar esta conversa?"
      i18n-title="@@history.removeTitle"
      titleId="history-remove-title"
      [width]="420"
      (closed)="removing.set(null)"
    >
      <p class="confirm-text">{{ removing()?.title }}</p>
      <div uiDialogFooter class="confirm-actions">
        <button
          uiButton="ghost"
          type="button"
          (click)="confirm.close()"
          i18n="@@history.keep"
        >
          Cancelar
        </button>
        <button
          uiButton="white"
          type="button"
          (click)="remove()"
          i18n="@@history.removeConfirm"
        >
          Apagar
        </button>
      </div>
    </ui-dialog>
  `,
  styles: `
    :host {
      display: grid;
      gap: var(--space-2);
      align-content: start;
      margin-inline: calc(-1 * var(--space-4));
    }
    .chips {
      display: flex;
      gap: var(--space-2);
      padding: 0 var(--space-4) var(--space-1);
      overflow-x: auto;
      scrollbar-width: none;
    }
    .chips .ui-chip {
      flex: none;
    }
    .empty {
      margin: var(--space-4);
      color: var(--color-text-muted);
      font-size: var(--text-sm);
    }
    .rows {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .row {
      display: flex;
      align-items: center;
      padding-inline-end: var(--space-2);
    }
    .open {
      display: flex;
      flex: 1 1 auto;
      align-items: center;
      gap: var(--space-3);
      min-width: 0;
      padding: var(--space-2) var(--space-2) var(--space-2) var(--space-4);
      border: 0;
      background: transparent;
      color: var(--color-text);
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .cover {
      display: grid;
      flex: none;
      place-items: center;
      width: 52px;
      height: 52px;
      border-radius: 4px;
      background: linear-gradient(
        135deg,
        var(--tint-search),
        var(--color-surface)
      );
      color: var(--color-on-cover);
    }
    .cover.research {
      background: linear-gradient(
        135deg,
        var(--tint-history-research),
        var(--color-surface)
      );
    }
    .text {
      display: grid;
      gap: 3px;
      min-width: 0;
    }
    .title {
      overflow: hidden;
      font-size: var(--text-item);
      font-weight: 500;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .meta {
      overflow: hidden;
      color: var(--color-text-muted);
      font-size: var(--text-meta);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .meta.failed {
      color: var(--color-danger);
    }
    .more ::ng-deep .ui-icon-button {
      color: var(--color-text-muted);
    }
    .confirm-text {
      margin: 0;
      color: var(--color-text-muted);
      overflow-wrap: anywhere;
    }
    .confirm-actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--space-2);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConversationHistory {
  private readonly history = inject(HistoryStore);
  private readonly chat = inject(ChatStore);
  private readonly views = inject(ViewStore);
  private readonly restorer = inject(RESEARCH_RESTORER);
  /** A conversation is back on screen: the page leaves the list. */
  readonly restored = output();
  /** A newer tap cancels the load of the previous one. */
  private readonly opens = new Subject<string>();
  private readonly confirm = viewChild.required<UiDialog>('confirm');

  protected readonly chips: readonly { id: HistoryFilter; label: string }[] = [
    { id: 'all', label: $localize`:@@history.all:Tudo` },
    { id: 'research', label: KIND_LABELS.research },
    { id: 'search', label: KIND_LABELS.search },
  ];
  protected readonly filter = signal<HistoryFilter>('all');
  protected readonly removing = signal<ConversationSummary | null>(null);
  private readonly titles = computed(
    () => new Map(this.chat.topicList().map((t) => [t.slug, t.title])),
  );
  protected readonly rows = computed((): HistoryRow[] => {
    const filter = this.filter();
    return this.history
      .conversations()
      .filter((c) => filter === 'all' || c.kind === filter)
      .map((summary) => {
        const where = summary.status
          ? STATUS_LABELS[summary.status]
          : (this.titles().get(summary.topic) ?? summary.topic);
        return {
          summary,
          meta: `${KIND_LABELS[summary.kind]} · ${where}`,
          failed: summary.status === 'failed',
        };
      });
  });

  constructor() {
    this.opens
      .pipe(
        // A failed load is reported by HistoryStore.lastError; the list stays usable.
        switchMap((id) => this.history.load(id).pipe(catchError(() => EMPTY))),
        takeUntilDestroyed(),
      )
      .subscribe((conversation) => this.restore(conversation));
  }

  protected open(summary: ConversationSummary): void {
    this.opens.next(summary.id);
  }

  protected askRemove(summary: ConversationSummary): void {
    this.removing.set(summary);
    this.confirm().open();
  }

  protected remove(): void {
    const summary = this.removing();
    if (summary) this.history.remove(summary.id);
    this.confirm().close();
  }

  private restore(conversation: Conversation): void {
    if (conversation.kind === 'search') {
      this.views.select('search');
      this.chat.restore(conversation);
    } else this.restorer.restore(conversation);
    this.restored.emit();
  }
}
