import {
  HttpErrorResponse,
  HttpResponse,
  type HttpInterceptorFn,
  type HttpRequest,
} from '@angular/common/http';
import {
  EMPTY_FILTERS,
  conversationSchema,
  summarizeConversation,
  type Conversation,
  type SearchConversation,
} from '@kb-chat/contracts';
import { of, throwError, type Observable } from 'rxjs';

const PREFIX = '/api/v1/conversations';

/** A search conversation as the API keeps it. */
export const aSearchConversation = (
  overrides: Partial<SearchConversation> = {},
): SearchConversation => {
  const title = overrides.title ?? 'lei do ritmo';
  return {
    kind: 'search',
    id: crypto.randomUUID(),
    topic: 'hermetismo',
    title,
    createdAt: '2026-10-24T12:00:00.000Z',
    updatedAt: '2026-10-24T12:00:00.000Z',
    asks: [{ question: title, mode: 'all', filters: EMPTY_FILTERS, total: 1 }],
    ...overrides,
  };
};

/**
 * In-memory stand-in for the /api/v1/conversations routes, as an interceptor in front of
 * HttpTestingController (page-level tests care about the history's behavior, not its HTTP).
 */
export class FakeConversationsServer {
  readonly saved = new Map<string, Conversation>();
  /** Status every call answers with while set (0 = network down). */
  failWith: number | null = null;

  readonly interceptor: HttpInterceptorFn = (request, next) =>
    request.url.startsWith(PREFIX) ? this.handle(request) : next(request);

  private handle(
    request: HttpRequest<unknown>,
  ): Observable<HttpResponse<unknown>> {
    const id = decodeURIComponent(request.url.slice(PREFIX.length + 1));
    const missing = request.method === 'GET' && id && !this.saved.has(id);
    const status = this.failWith ?? (missing ? 404 : null);
    if (status !== null)
      return throwError(
        () => new HttpErrorResponse({ status, url: request.url }),
      );
    return of(
      new HttpResponse({ status: 200, body: this.answer(request, id) }),
    );
  }

  private answer(request: HttpRequest<unknown>, id: string): unknown {
    if (request.method === 'PUT') {
      const conversation = conversationSchema.parse(request.body);
      this.saved.set(id, conversation);
      return summarizeConversation(conversation);
    }
    if (request.method === 'DELETE') {
      this.saved.delete(id);
      return null;
    }
    if (id) return this.saved.get(id);
    const items = [...this.saved.values()]
      .map(summarizeConversation)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { items };
  }
}
