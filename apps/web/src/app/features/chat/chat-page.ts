import { DOCUMENT, DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  DestroyRef,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import type {
  DocumentRef,
  SearchFilters,
  SearchMode,
} from '@kb-chat/contracts';
import { httpResource } from '@angular/common/http';
import { suggestionListSchema } from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { suggestionsUrl } from '@core/api/kb-api.js';
import { DocumentPanel } from '@features/document/document-panel.js';
import { Sidebar, type SidebarAction } from '@features/sidebar/sidebar.js';
import { NO_FILTERS, type ChatMessage } from './chat-message.js';
import { ChatStore } from './chat-store.js';
import { Composer } from './composer.js';
import { describeForAnnouncement } from './result-count.js';
import { ResultMessage } from './result-message.js';

const DESKTOP_QUERY = '(min-width: 1024px)';

/** Chat-style search page: conversation, question box and document panel (screens.md). */
@Component({
  selector: 'app-chat-page',
  imports: [Composer, ResultMessage, DocumentPanel, Sidebar, DecimalPipe],
  providers: [ChatStore],
  templateUrl: './chat-page.html',
  styleUrl: './chat-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'focusOnSlash($event)' },
})
export class ChatPage {
  protected readonly store = inject(ChatStore);
  private readonly injector = inject(Injector);
  private readonly view = inject(DOCUMENT).defaultView;
  private readonly composer = viewChild.required(Composer);
  private readonly host =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly drawer = viewChild<ElementRef<HTMLDialogElement>>('drawer');
  private readonly menuButton =
    viewChild<ElementRef<HTMLButtonElement>>('menuButton');

  /** Desktop shows the side panel as a column; phones open it as a drawer (KBC-005 FR-6). */
  protected readonly desktop = signal(this.matchesDesktop());

  protected readonly topic = this.store.topic;
  protected readonly messages = this.store.messages;
  protected readonly opened = this.store.openDocument;
  protected readonly isEmpty = computed(() => this.messages().length === 0);
  /** On phones the panel covers the conversation: make it inert so Tab stays in the panel. */
  protected readonly covered = computed(
    () => this.opened() !== null && !this.desktop(),
  );
  /** The largest subjects as one-click starting points (KBC-006 FR-1); hidden when unavailable. */
  private readonly suggestionList = httpResource(
    () => {
      const slug = this.store.topicSlug();
      return slug ? suggestionsUrl(slug) : undefined;
    },
    { parse: (body) => suggestionListSchema.parse(body) },
  );
  protected readonly suggestions = computed(() =>
    this.suggestionList.hasValue() ? this.suggestionList.value().items : [],
  );
  protected readonly topicNotice = computed(() => {
    const slug = this.store.topicNotice();
    const topic = this.store.topicList().find((t) => t.slug === slug);
    return topic
      ? $localize`:@@page.newInTopic:Nova conversa em ${topic.title}:topic:`
      : '';
  });
  protected readonly topicsError = computed(() => {
    const err = this.store.topics.error();
    return err ? errorMessage(toUiErrorCode(err)) : '';
  });
  protected readonly noTopics = computed(
    () => this.store.topics.hasValue() && this.store.topicList().length === 0,
  );
  /** Short live-region text (the cards themselves are not announced). */
  protected readonly announcement = computed(() => {
    const last = this.messages().at(-1);
    if (!last || last.status === 'loading') return '';
    // Prefixed with the question so a repeated identical count is still announced.
    const outcome = last.response
      ? describeForAnnouncement(last.response)
      : errorMessage(last.error ?? 'INTERNAL');
    return `${last.question}: ${outcome}`;
  });

  private matchesDesktop(): boolean {
    return this.view?.matchMedia?.(DESKTOP_QUERY).matches ?? true;
  }

  constructor() {
    const query = this.view?.matchMedia?.(DESKTOP_QUERY);
    const onChange = (event: MediaQueryListEvent) => {
      const drawer = this.drawer()?.nativeElement;
      this.desktop.set(event.matches);
      // Grown to desktop with the drawer open: it goes away with the Menu button, so focus moves on.
      if (event.matches && drawer?.open) {
        drawer.close();
        afterNextRender(() => this.composer().focus(), {
          injector: this.injector,
        });
      }
    };
    query?.addEventListener('change', onChange);
    inject(DestroyRef).onDestroy(() =>
      query?.removeEventListener('change', onChange),
    );
    // The question box starts focused on desktop; on phones it would pop the keyboard.
    afterNextRender(() => {
      if (this.view?.matchMedia?.(DESKTOP_QUERY).matches)
        this.composer().focus();
    });
  }

  protected openMenu(): void {
    this.drawer()?.nativeElement.showModal();
  }

  protected closeMenu(): void {
    this.drawer()?.nativeElement.close();
  }

  /** Back to the Menu button when the drawer closes (Esc, ×, backdrop or an action). */
  protected menuClosed(): void {
    this.menuButton()?.nativeElement.focus();
  }

  /** A tap on the backdrop lands on the <dialog> itself, outside its content. */
  protected drawerClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.closeMenu();
  }

  protected sidebarActed(action: SidebarAction): void {
    this.closeMenu();
    // A new conversation is ready to type into; elsewhere focus stays put (the drawer returns it).
    if (action !== 'restore')
      afterNextRender(() => this.composer().focus(), {
        injector: this.injector,
      });
  }

  protected changeMode(mode: SearchMode): void {
    this.store.setMode(mode);
  }

  protected ask(question: string): void {
    this.store.ask(question);
  }

  /** A suggestion searches the subject's name with the subject filter on (KBC-006 FR-2). */
  protected askAbout(concept: string): void {
    this.store.ask(concept, {
      filters: { ...NO_FILTERS, concepts: [concept] },
      origin: 'suggestion',
    });
  }

  protected openHit(doc: DocumentRef, message: ChatMessage): void {
    this.store.open(message.topic, doc, message);
  }

  /** A subject chip in the panel filters the message that opened it (KBC-003 FR-5). */
  protected filterByConcept(concept: string): void {
    const message = this.messages().find(
      (m) => m.id === this.opened()?.messageId,
    );
    if (!message || message.filters.concepts.includes(concept)) return;
    this.store.refine(message, {
      ...message.filters,
      concepts: [...message.filters.concepts, concept],
    });
  }

  protected refine(message: ChatMessage, filters: SearchFilters): void {
    this.store.refine(message, filters);
  }

  protected loadMore(message: ChatMessage): void {
    this.store.loadMore(message);
  }

  protected retry(message: ChatMessage): void {
    this.store.retry(message);
  }

  protected askAgainIn(message: ChatMessage, mode: SearchMode): void {
    this.store.setMode(mode);
    this.store.ask(message.question, {
      mode,
      filters: message.filters,
      origin: 'mode',
    });
  }

  protected closeDocument(): void {
    const closedId = this.opened()?.id;
    this.store.close();
    // Back to the card that opened the document (focusing the question box would pop the
    // phone keyboard); runs after the conversation is visible again so focus never lands on <body>.
    afterNextRender(() => this.focusCard(closedId), {
      injector: this.injector,
    });
  }

  private focusCard(id: string | undefined): void {
    const cards = this.host.querySelectorAll<HTMLElement>('[data-doc-id]');
    const card = [...cards].find((element) => element.dataset['docId'] === id);
    if (card) card.focus();
    else this.composer().focus();
  }

  protected reloadTopics(): void {
    this.store.topics.reload();
  }

  protected focusOnSlash(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    const typing = target?.closest(
      'input, textarea, select, [contenteditable]',
    );
    if (event.key !== '/' || typing) return;
    event.preventDefault();
    this.composer().focus();
  }
}
