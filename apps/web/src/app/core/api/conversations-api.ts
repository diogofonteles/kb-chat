import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  conversationListSchema,
  conversationSchema,
  conversationSummarySchema,
  type Conversation,
  type ConversationSummary,
} from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';

export const conversationsUrl = (): string => '/api/v1/conversations';
export const conversationUrl = (id: string): string =>
  `${conversationsUrl()}/${encodeURIComponent(id)}`;

/** The conversation history kept by the local API (every conversation, no cap). */
@Injectable({ providedIn: 'root' })
export class ConversationsApi {
  private readonly http = inject(HttpClient);

  list(): Observable<ConversationSummary[]> {
    return this.http
      .get(conversationsUrl())
      .pipe(map((body) => conversationListSchema.parse(body).items));
  }

  get(id: string): Observable<Conversation> {
    return this.http
      .get(conversationUrl(id))
      .pipe(map((body) => conversationSchema.parse(body)));
  }

  put(conversation: Conversation): Observable<ConversationSummary> {
    return this.http
      .put(conversationUrl(conversation.id), conversation)
      .pipe(map((body) => conversationSummarySchema.parse(body)));
  }

  remove(id: string): Observable<void> {
    return this.http.delete(conversationUrl(id)).pipe(map(() => undefined));
  }
}
