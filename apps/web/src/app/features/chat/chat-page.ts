import { DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
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
import { ResultMessage } from './result-message.js';

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
  private readonly composer = viewChild.required(Composer);

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
    this.store.close();
    this.composer().focus();
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
