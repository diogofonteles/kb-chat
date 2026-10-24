import { DOCUMENT } from '@angular/common';
import {
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

export type HistoryAction = 'list' | 'save' | 'load' | 'remove';

/** The last history call that failed; the next success of the same action clears it. */
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

  private readonly list = rxResource({
    stream: () => this.migrateLegacy().pipe(switchMap(() => this.api.list())),
  });
  /** The server's list plus local saves and removals since it arrived. */
  private readonly summaries = linkedSignal<readonly ConversationSummary[]>(
    () => (this.list.hasValue() ? this.list.value() : []),
  );
  /** Every conversation, newest first. */
  readonly conversations = this.summaries.asReadonly();
  readonly loading = computed(() => this.list.isLoading());
  private readonly errorState = signal<HistoryError | null>(null);
  readonly lastError = computed<HistoryError | null>(
    () =>
      this.errorState() ??
      (this.list.error() ? { action: 'list', id: null } : null),
  );
  /** False when the list cannot be read or the last save did not reach the server. */
  readonly available = computed(
    () => !this.list.error() && this.errorState()?.action !== 'save',
  );

  constructor() {
    // One PUT at a time, so a newer version of a conversation never lands before an older one.
    this.saves
      .pipe(
        concatMap((conversation) =>
          this.api.put(conversation).pipe(
            map(() => null),
            catchError(() => of(conversation.id)),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((failedId) =>
        failedId ? this.fail('save', failedId) : this.clear('save'),
      );
  }

  /** Shows the conversation at the top right away and saves it on the server. */
  save(conversation: Conversation): void {
    const summary = summarizeConversation(conversation);
    this.summaries.update((list) => [summary, ...withoutId(list, summary.id)]);
    this.saves.next(conversation);
  }

  /** The full conversation (asks or turns); the caller subscribes. */
  load(id: string): Observable<Conversation> {
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
    // A single DELETE completes by itself; nothing to unsubscribe from (NG-21).
    this.api.remove(id).subscribe({
      next: () => this.clear('remove'),
      error: () => {
        this.fail('remove', id);
        this.list.reload();
      },
    });
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
