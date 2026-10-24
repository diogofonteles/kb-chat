import { DOCUMENT } from '@angular/common';
import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  summarizeConversation,
  type Conversation,
  type ConversationSummary,
} from '@kb-chat/contracts';
import { ConversationsApi } from '@core/api/conversations-api.js';
import {
  Subject,
  catchError,
  concat,
  concatMap,
  map,
  of,
  switchMap,
  tap,
  toArray,
  type Observable,
} from 'rxjs';
import {
  forgetLegacyHistory,
  parseLegacyHistory,
  readLegacyHistory,
} from './legacy-history.js';
import { PendingSaves } from './pending-saves.js';

/** First retry of a failed save; each new failure doubles it, up to the maximum. */
export const RETRY_FIRST_MS = 2_000;
const RETRY_MAX_MS = 60_000;

interface SaveResult {
  readonly conversation: Conversation;
  readonly ok: boolean;
}

export type HistoryAction = 'list' | 'save' | 'load' | 'remove';

/**
 * A history call that failed. A save stays reported while any conversation is pending; a
 * load or a removal until the next success of the same action.
 */
export interface HistoryError {
  readonly action: HistoryAction;
  /** The conversation involved, or null for the list. */
  readonly id: string | null;
}

/** localStorage access itself can throw (blocked site data). */
function safeStorage(view: Window | null): Storage | undefined {
  try {
    return view?.localStorage;
  } catch {
    return undefined;
  }
}

const withoutId = (list: readonly ConversationSummary[], id: string) =>
  list.filter((item) => item.id !== id);

/** The list with every pending conversation in it, a pending one first when missing. */
function withPending(
  list: readonly ConversationSummary[],
  pending: readonly Conversation[],
): readonly ConversationSummary[] {
  const listed = new Set(list.map((item) => item.id));
  const missing = pending
    .filter((conversation) => !listed.has(conversation.id))
    .map(summarizeConversation);
  return missing.length === 0 ? list : [...missing, ...list];
}

/**
 * The complete conversation history, kept by the local API on this computer (no cap;
 * owner, 2026-10-24). Both kinds: "search" (re-run on restore) and "research" (restored as
 * saved). Saves are optimistic and sent in order; reads are Observables (NG-19).
 */
@Injectable({ providedIn: 'root' })
export class HistoryStore {
  private readonly api = inject(ConversationsApi);
  private readonly storage = safeStorage(inject(DOCUMENT).defaultView);
  private readonly saves = new Subject<Conversation>();
  private readonly pending = new PendingSaves(this.storage);
  /** The newest snapshot saved of each conversation; an older PUT's outcome is moot. */
  private readonly latest = new Map<string, Conversation>();
  /** Snapshots waiting in or for the PUT queue, so a retry never sends one twice. */
  private readonly queued = new Set<Conversation>();
  private retryDelay = RETRY_FIRST_MS;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly list = rxResource({
    stream: () =>
      this.migrateLegacy().pipe(
        switchMap(() => this.api.list()),
        // Each (re)load is a chance to send what is still pending.
        tap(() => this.retryPending()),
      ),
  });
  /** The server's list plus local saves and removals since it arrived. */
  private readonly summaries = linkedSignal<readonly ConversationSummary[]>(
    () => (this.list.hasValue() ? this.list.value() : []),
  );
  /** Every conversation, newest first, including those whose save is pending. */
  readonly conversations = computed(() =>
    withPending(this.summaries(), this.pending.items()),
  );
  readonly loading = computed(() => this.list.isLoading());
  private readonly errorState = signal<HistoryError | null>(null);
  readonly lastError = computed<HistoryError | null>(() => {
    const [waiting] = this.pending.items();
    if (waiting) return { action: 'save', id: waiting.id };
    return (
      this.errorState() ??
      (this.list.error() ? { action: 'list', id: null } : null)
    );
  });
  /** False when the list cannot be read or a conversation is not on the server yet. */
  readonly available = computed(
    () => !this.list.error() && this.pending.size() === 0,
  );

  constructor() {
    // One PUT at a time, so a newer version of a conversation never lands before an older one.
    this.saves
      .pipe(
        concatMap((conversation) =>
          this.api.put(conversation).pipe(
            map((): SaveResult => ({ conversation, ok: true })),
            catchError(() => of<SaveResult>({ conversation, ok: false })),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((result) => this.settle(result));
    inject(DestroyRef).onDestroy(() => clearTimeout(this.retryTimer));
  }

  /** Shows the conversation at the top right away and saves it on the server. */
  save(conversation: Conversation): void {
    const summary = summarizeConversation(conversation);
    this.summaries.update((list) => [summary, ...withoutId(list, summary.id)]);
    this.latest.set(conversation.id, conversation);
    this.enqueue(conversation);
    this.retryPending();
  }

  /** The full conversation (asks or turns); a pending one comes from this browser. */
  load(id: string): Observable<Conversation> {
    const waiting = this.pending.get(id);
    if (waiting) return of(waiting);
    return this.api.get(id).pipe(
      tap({
        next: () => this.clear('load'),
        error: () => this.fail('load', id),
      }),
    );
  }

  /** Removes it from the list now; if the server refuses, the list is read again. */
  remove(id: string): void {
    this.summaries.update((list) => withoutId(list, id));
    this.pending.remove(id);
    this.latest.delete(id);
    // A single DELETE completes by itself; nothing to unsubscribe from (NG-21).
    this.api.remove(id).subscribe({
      next: () => this.clear('remove'),
      error: () => {
        this.fail('remove', id);
        this.list.reload();
      },
    });
  }

  private enqueue(conversation: Conversation): void {
    if (this.queued.has(conversation)) return;
    this.queued.add(conversation);
    this.saves.next(conversation);
  }

  /** Sends again every pending snapshot that no newer save replaced. */
  private retryPending(): void {
    for (const conversation of this.pending.items()) {
      const newest = this.latest.get(conversation.id) ?? conversation;
      if (newest === conversation) this.enqueue(conversation);
    }
  }

  private settle({ conversation, ok }: SaveResult): void {
    this.queued.delete(conversation);
    const newest = this.latest.get(conversation.id) ?? conversation;
    if (newest !== conversation) return;
    if (!ok) {
      this.pending.add(conversation);
      this.scheduleRetry();
      return;
    }
    this.pending.remove(conversation.id);
    this.latest.delete(conversation.id);
    if (this.pending.size() === 0) this.retryDelay = RETRY_FIRST_MS;
  }

  /** Retries with backoff (2 s, 4 s, … 60 s) while something is pending. */
  private scheduleRetry(): void {
    if (this.retryTimer !== undefined) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.retryPending();
    }, this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
  }

  private fail(action: HistoryAction, id: string | null): void {
    this.errorState.set({ action, id });
  }

  private clear(action: HistoryAction): void {
    if (this.errorState()?.action === action) this.errorState.set(null);
  }

  /**
   * One-time move of the old browser history (localStorage) to the server. The key is
   * deleted only after every conversation was saved; a failure keeps it for the next start.
   */
  private migrateLegacy(): Observable<void> {
    const raw = readLegacyHistory(this.storage);
    if (raw === null) return of(undefined);
    const puts = parseLegacyHistory(raw).map((c) => this.api.put(c));
    return concat(...puts).pipe(
      toArray(),
      tap(() => forgetLegacyHistory(this.storage)),
      map(() => undefined),
      catchError(() => of(undefined)),
    );
  }
}
