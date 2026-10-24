import { DOCUMENT, DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  viewChild,
} from '@angular/core';
import type { SearchHit, SearchMode } from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { DocumentPanel } from '@features/document/document-panel.js';
import type { ChatMessage } from './chat-message.js';
import { ChatStore } from './chat-store.js';
import { Composer } from './composer.js';
import { describeForAnnouncement } from './result-count.js';
import { ResultMessage } from './result-message.js';

const DESKTOP_QUERY = '(min-width: 1024px)';

/** Chat-style search page: conversation, question box and document panel (screens.md). */
@Component({
  selector: 'app-chat-page',
  imports: [Composer, ResultMessage, DocumentPanel, DecimalPipe],
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

  protected readonly topic = this.store.topic;
  protected readonly messages = this.store.messages;
  protected readonly opened = this.store.openDocument;
  protected readonly isEmpty = computed(() => this.messages().length === 0);
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

  constructor() {
    // The question box starts focused on desktop; on phones it would pop the keyboard.
    afterNextRender(() => {
      if (this.view?.matchMedia?.(DESKTOP_QUERY).matches)
        this.composer().focus();
    });
  }

  protected changeMode(mode: SearchMode): void {
    this.store.setMode(mode);
  }

  protected ask(question: string): void {
    this.store.ask(question);
  }

  protected openHit(hit: SearchHit, message: ChatMessage): void {
    this.store.open(message.topic, hit);
  }

  protected retry(message: ChatMessage): void {
    this.store.retry(message);
  }

  protected askAgainIn(message: ChatMessage, mode: SearchMode): void {
    this.store.setMode(mode);
    this.store.ask(message.question, mode);
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
