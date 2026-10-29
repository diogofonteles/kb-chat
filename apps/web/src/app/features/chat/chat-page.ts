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
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { suggestionListSchema } from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { suggestionsUrl } from '@core/api/kb-api.js';
import { SessionStore } from '@core/auth/session-store.js';
import { DocumentPanel } from '@features/document/document-panel.js';
import { Sidebar, type SidebarAction } from '@features/sidebar/sidebar.js';
import { NO_FILTERS, type ChatMessage } from './chat-message.js';
import { ChatStore } from './chat-store.js';
import { RESEARCH_RESTORER } from '@core/history/research-restorer.js';
import { provideResearchRestorer } from '@features/research/research-restorer.js';
import { Composer } from './composer.js';
import { describeForAnnouncement } from './result-count.js';
import { ResultMessage } from './result-message.js';
import { ResearchStore } from '@features/research/research-store.js';
import { ResearchThread } from '@features/research/research-thread.js';
import { ViewStore, type ChatView } from './view-store.js';
import { ViewSwitch } from './view-switch.js';

const DESKTOP_QUERY = '(min-width: 1024px)';

const isMediaUrl = (url: string): boolean => /^\/midia(\/|\?|#|$)/.test(url);

/**
 * Chat page (screens.md): two views over one question box and document panel, the free
 * search engine and the research agent (KBC-008), each with its own conversation.
 */
@Component({
  selector: 'app-chat-page',
  imports: [
    Composer,
    ResultMessage,
    ResearchThread,
    ViewSwitch,
    DocumentPanel,
    Sidebar,
    DecimalPipe,
    RouterOutlet,
  ],
  providers: [
    ChatStore,
    ViewStore,
    ResearchStore,
    provideResearchRestorer(RESEARCH_RESTORER),
  ],
  templateUrl: './chat-page.html',
  styleUrl: './chat-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'focusOnSlash($event)' },
})
export class ChatPage {
  protected readonly store = inject(ChatStore);
  protected readonly views = inject(ViewStore);
  protected readonly research = inject(ResearchStore);
  private readonly session = inject(SessionStore);
  /** A member sees only the collections a master granted (KBC-010). */
  protected readonly guest = computed(
    () => this.session.me()?.role === 'member',
  );
  private readonly injector = inject(Injector);
  private readonly view = inject(DOCUMENT).defaultView;
  /** Absent on the media pages (/midia), which render in place of the conversation. */
  private readonly composer = viewChild(Composer);
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
  protected readonly currentView = this.views.current;
  protected readonly researching = computed(
    () => this.currentView() === 'research',
  );
  protected readonly isEmpty = computed(() =>
    this.researching()
      ? this.research.turns().length === 0
      : this.messages().length === 0,
  );
  /** On phones the panel covers the conversation: make it inert so Tab stays in the panel. */
  private readonly router = inject(Router);
  /** /midia and /midia/:id render in this layout instead of the conversation (T14, T15). */
  protected readonly onMedia = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => isMediaUrl(this.router.url)),
    ),
    { initialValue: isMediaUrl(this.router.url) },
  );
  /** The document panel belongs to the conversation: hidden on the media pages. */
  protected readonly panel = computed(() =>
    this.onMedia() ? null : this.opened(),
  );
  protected readonly covered = computed(
    () => this.panel() !== null && !this.desktop(),
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
    const last = this.researching() ? undefined : this.messages().at(-1);
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
        afterNextRender(() => this.composer()?.focus(), {
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
        this.composer()?.focus();
    });
  }

  protected openMenu(): void {
    this.drawer()?.nativeElement.showModal();
  }

  /** Where focus goes when the drawer finishes closing. */
  private focusAfterMenu: 'menu' | 'composer' = 'menu';

  protected closeMenu(): void {
    this.drawer()?.nativeElement.close();
  }

  /**
   * The drawer's `close` event arrives after the action that closed it, so it decides where
   * focus goes: the question box after an action that needs typing, else the Menu button.
   */
  protected menuClosed(): void {
    const target = this.focusAfterMenu;
    this.focusAfterMenu = 'menu';
    if (target === 'composer') this.composer()?.focus();
    else this.menuButton()?.nativeElement.focus();
  }

  /** A tap on the backdrop lands on the <dialog> itself, outside its content. */
  protected drawerClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.closeMenu();
  }

  protected sidebarActed(action: SidebarAction): void {
    // A conversation started or restored from the media pages shows the conversation.
    if ((action === 'new' || action === 'restore') && this.onMedia())
      void this.router.navigateByUrl('/');
    // A new conversation (or another collection) is ready to type into.
    const typing = action === 'new' || (action === 'topic' && !this.onMedia());
    if (this.drawer()?.nativeElement.open) {
      this.focusAfterMenu = typing ? 'composer' : 'menu';
      this.closeMenu();
    } else if (typing) {
      afterNextRender(() => this.composer()?.focus(), {
        injector: this.injector,
      });
    }
  }

  protected changeMode(mode: SearchMode): void {
    this.store.setMode(mode);
  }

  protected changeView(view: ChatView): void {
    this.views.select(view);
  }

  protected ask(question: string): void {
    if (this.researching()) this.askResearch(question);
    else this.store.ask(question);
  }

  /** The new question scrolls into view; focus stays in the question box, as in a chat. */
  private askResearch(question: string): void {
    this.research.ask(question);
    afterNextRender(
      () =>
        this.host
          .querySelector('app-research-message:last-of-type')
          ?.scrollIntoView({ block: 'start' }),
      { injector: this.injector },
    );
  }

  /**
   * A suggestion searches the subject's name with the subject filter on (KBC-006 FR-2); in
   * the research view it becomes a question to the agent.
   */
  protected askAbout(concept: string): void {
    if (this.researching()) {
      this.askResearch(
        $localize`:@@research.aboutSubject:O que o acervo diz sobre ${concept}:subject:?`,
      );
      return;
    }
    this.store.ask(concept, {
      filters: { ...NO_FILTERS, concepts: [concept] },
      origin: 'suggestion',
    });
  }

  /** A cited source opens in the same document panel (AC-3). */
  protected openSource(doc: DocumentRef): void {
    const topic = this.store.topicSlug();
    if (topic) this.store.open(topic, doc);
  }

  /** "Parar" disappears with the answer in flight: focus moves to the question box. */
  protected stopResearch(): void {
    this.research.stop();
    afterNextRender(() => this.composer()?.focus(), {
      injector: this.injector,
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
    else this.composer()?.focus();
  }

  protected reloadTopics(): void {
    this.store.topics.reload();
  }

  /**
   * "/" focuses the question box. Pressed in the box while it is still empty (it has focus
   * on load), it does nothing, so following the hint never types "/" (M-9); in any other
   * field it types as usual.
   */
  protected focusOnSlash(event: KeyboardEvent): void {
    if (event.key !== '/') return;
    if (this.composer()?.isEmptyField(event.target)) {
      event.preventDefault();
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable]')) return;
    event.preventDefault();
    this.composer()?.focus();
  }
}
