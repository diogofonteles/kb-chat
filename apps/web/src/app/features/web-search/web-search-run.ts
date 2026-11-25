import { Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type {
  WebSearchKind,
  WebSearchRequestInput,
  WebSearchResponse,
  WebSearchResult,
} from '@kb-chat/contracts';
import { toUiErrorCode, type UiErrorCode } from '@core/api/api-error.js';
import { BusyWork } from '@core/app-version/busy-work.js';
import { WebSearchApi } from '@core/web-search/web-search-api.js';
import {
  EMPTY,
  Subject,
  catchError,
  defer,
  expand,
  finalize,
  groupBy,
  mergeMap,
  switchMap,
  tap,
  type Observable,
} from 'rxjs';

/** Asked of the API at a time: the first results show within a few seconds. */
export const SEARCH_STEP = 10;

/** What is searched for a collection, however many sources are wanted of it. */
export interface SearchAsked {
  readonly topic: string;
  readonly request: Omit<WebSearchRequestInput, 'sources' | 'search'>;
}

/** A result picked to be included: the page sends it as a link (KBC-149). */
export interface PickedWebResult {
  readonly url: string;
  readonly title: string;
  readonly kind: WebSearchKind;
}

/** One search: what came, and where it is. */
export interface SearchState {
  /** What the API goes on with: another press of "Pesquisar" is another search. */
  readonly id: string;
  readonly asked: SearchAsked;
  /** The results wanted so far: "Buscar mais" raises it. */
  readonly wanted: number;
  readonly searching: boolean;
  readonly results: readonly WebSearchResult[];
  /** The addresses the person left out, and the ones included from here. */
  readonly dropped: ReadonlySet<string>;
  readonly taken: ReadonlySet<string>;
  readonly exhausted: boolean;
  readonly partial: boolean;
  readonly skipped: WebSearchResponse['skipped'];
  readonly creditsUsed: number;
  readonly creditsRemaining: number | null;
  readonly low: boolean;
  readonly error: UiErrorCode | null;
}

const begun = (asked: SearchAsked, wanted: number): SearchState => ({
  id: crypto.randomUUID(),
  asked,
  wanted,
  searching: true,
  results: [],
  dropped: new Set(),
  taken: new Set(),
  exhausted: false,
  partial: false,
  skipped: { already: 0, seen: 0 },
  creditsUsed: 0,
  creditsRemaining: null,
  low: false,
  error: null,
});

const pickable = (state: SearchState): readonly WebSearchResult[] =>
  state.results.filter(
    (one) => one.already === null && !state.taken.has(one.url),
  );

/** Paid, and not included: a reload would lose it. */
const wouldBeLost = (state: SearchState): boolean =>
  state.searching || pickable(state).length > 0;

/** A press: go on (or start) in a collection, or stop there. */
interface Turn {
  readonly topic: string;
  readonly go: boolean;
}

/**
 * The web searches of the moment (KBC-185), one per collection: as many requests as the
 * sources wanted take, the results coming in as they arrive. Kept while the app is open: a
 * search is paid, so leaving the page, another tab of it or another collection loses none,
 * and a new version of the app does not reload over it.
 */
@Injectable({ providedIn: 'root' })
export class WebSearchRun {
  private readonly api = inject(WebSearchApi);
  private readonly states = signal<ReadonlyMap<string, SearchState>>(new Map());
  private readonly turns = new Subject<Turn>();

  constructor() {
    inject(BusyWork).holdWhile(
      computed(() => [...this.states().values()].some(wouldBeLost)),
    );
    this.turns
      .pipe(
        groupBy((turn) => turn.topic),
        mergeMap((turns) =>
          turns.pipe(
            switchMap(({ topic, go }) => (go ? this.pull(topic) : EMPTY)),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe();
  }

  /** The collection's search, or null: another collection's is not shown in this one. */
  of(topic: string): SearchState | null {
    return this.states().get(topic) ?? null;
  }

  picksOf(topic: string): readonly PickedWebResult[] {
    const state = this.of(topic);
    if (!state) return [];
    return pickable(state)
      .filter((one) => !state.dropped.has(one.url))
      .map(({ url, title, kind }) => ({ url, title, kind }));
  }

  start(asked: SearchAsked, wanted: number): void {
    const { topic } = asked;
    this.stop(topic);
    this.states.update((states) =>
      new Map(states).set(topic, begun(asked, wanted)),
    );
    this.turns.next({ topic, go: true });
  }

  /** More of the same: what comes is new, what was given before stays. */
  more(topic: string, sources: number): void {
    this.change(topic, (state) => ({
      ...state,
      wanted: state.results.length + sources,
    }));
    this.turns.next({ topic, go: true });
  }

  /** What failed, or was left half-way, asked again: what is there stays. */
  retry(topic: string): void {
    this.turns.next({ topic, go: true });
  }

  /** The API stops too: what it had found waits there for the next press. */
  stop(topic: string): void {
    this.turns.next({ topic, go: false });
  }

  toggle(topic: string, url: string): void {
    this.change(topic, (state) => {
      const dropped = new Set(state.dropped);
      if (!dropped.delete(url)) dropped.add(url);
      return { ...state, dropped };
    });
  }

  /** All of them, or none when all are. */
  toggleAll(topic: string): void {
    this.change(topic, (state) => {
      const urls = pickable(state).map((one) => one.url);
      const all = urls.every((url) => !state.dropped.has(url));
      return { ...state, dropped: new Set(all ? urls : []) };
    });
  }

  /** Included now: they stay listed, and cannot go twice. */
  take(topic: string, urls: readonly string[]): void {
    this.change(topic, (state) => ({
      ...state,
      taken: new Set([...state.taken, ...urls]),
    }));
  }

  private pull(topic: string): Observable<unknown> {
    return defer(() => {
      this.change(topic, (state) => ({
        ...state,
        searching: true,
        error: null,
        partial: false,
      }));
      return this.step(topic).pipe(
        expand(() => (this.goesOn(topic) ? this.step(topic) : EMPTY)),
        catchError((err: unknown) => {
          const error = toUiErrorCode(err);
          this.change(topic, (state) => ({ ...state, error }));
          return EMPTY;
        }),
        finalize(() =>
          this.change(topic, (state) => ({ ...state, searching: false })),
        ),
      );
    });
  }

  private step(topic: string): Observable<WebSearchResponse> {
    return defer(() => {
      const state = this.of(topic);
      if (!state) return EMPTY;
      const missing = state.wanted - state.results.length;
      const sources = Math.max(1, Math.min(SEARCH_STEP, missing));
      return this.api.search(topic, {
        ...state.asked.request,
        search: state.id,
        sources,
      });
    }).pipe(tap((answer) => this.receive(topic, answer)));
  }

  private goesOn(topic: string): boolean {
    const state = this.of(topic);
    return (
      state !== null && state.results.length < state.wanted && !state.exhausted
    );
  }

  private receive(topic: string, answer: WebSearchResponse): void {
    this.change(topic, (state) => {
      const known = new Set(state.results.map((one) => one.url));
      const fresh = answer.results.filter((one) => !known.has(one.url));
      return {
        ...state,
        results: [...state.results, ...fresh],
        exhausted: answer.exhausted,
        partial: state.partial || answer.partial,
        skipped: {
          already: state.skipped.already + answer.skipped.already,
          seen: state.skipped.seen + answer.skipped.seen,
        },
        creditsUsed: state.creditsUsed + answer.creditsUsed,
        creditsRemaining: answer.creditsRemaining,
        low: answer.low,
      };
    });
  }

  private change(
    topic: string,
    apply: (state: SearchState) => SearchState,
  ): void {
    this.states.update((states) => {
      const state = states.get(topic);
      return state ? new Map(states).set(topic, apply(state)) : states;
    });
  }
}
