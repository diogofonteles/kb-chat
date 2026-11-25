import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type {
  WebSearchKind,
  WebSearchRequestInput,
  WebSearchResponse,
  WebSearchResult,
} from '@kb-chat/contracts';
import { toUiErrorCode, type UiErrorCode } from '@core/api/api-error.js';
import { WebSearchApi } from '@core/web-search/web-search-api.js';
import {
  EMPTY,
  Subject,
  catchError,
  defer,
  expand,
  finalize,
  switchMap,
  tap,
  type Observable,
} from 'rxjs';

/** Asked of the API at a time: the first results show within a few seconds. */
export const SEARCH_STEP = 10;

/** What is searched for a collection, however many sources are wanted of it. */
export interface SearchAsked {
  readonly topic: string;
  readonly request: Omit<WebSearchRequestInput, 'sources'>;
}

/** A result picked to be included: the page sends it as a link (KBC-149). */
export interface PickedWebResult {
  readonly url: string;
  readonly title: string;
  readonly kind: WebSearchKind;
}

/** One search: what came, and where it is. */
export interface SearchState {
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

/**
 * The web search of the moment (KBC-185): as many requests as the sources wanted take, the
 * results coming in as they arrive. Kept while the app is open: a search is paid, so leaving
 * the page, or looking at another tab of it, loses none.
 */
@Injectable({ providedIn: 'root' })
export class WebSearchRun {
  private readonly api = inject(WebSearchApi);
  private readonly state = signal<SearchState | null>(null);
  private readonly turns = new Subject<'go' | 'stop'>();

  constructor() {
    this.turns
      .pipe(
        switchMap((turn) => (turn === 'go' ? this.pull() : EMPTY)),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe();
  }

  /** The collection's search, or null: another collection's is not shown in this one. */
  of(topic: string): SearchState | null {
    const state = this.state();
    return state?.asked.topic === topic ? state : null;
  }

  picksOf(topic: string): readonly PickedWebResult[] {
    const state = this.of(topic);
    if (!state) return [];
    return pickable(state)
      .filter((one) => !state.dropped.has(one.url))
      .map(({ url, title, kind }) => ({ url, title, kind }));
  }

  readonly searching = computed(() => this.state()?.searching === true);

  start(asked: SearchAsked, wanted: number): void {
    this.state.set(begun(asked, wanted));
    this.turns.next('go');
  }

  /** More of the same: what comes is new, what was given before stays. */
  more(sources: number): void {
    this.change((state) => ({
      ...state,
      wanted: state.results.length + sources,
      searching: true,
    }));
    this.turns.next('go');
  }

  /** What failed, or was left half-way, asked again: what is there stays. */
  retry(): void {
    this.change((state) => ({ ...state, searching: true }));
    this.turns.next('go');
  }

  stop(): void {
    this.turns.next('stop');
  }

  toggle(url: string): void {
    this.change((state) => {
      const dropped = new Set(state.dropped);
      if (!dropped.delete(url)) dropped.add(url);
      return { ...state, dropped };
    });
  }

  /** All of them, or none when all are. */
  toggleAll(): void {
    this.change((state) => {
      const urls = pickable(state).map((one) => one.url);
      const all = urls.every((url) => !state.dropped.has(url));
      return { ...state, dropped: new Set(all ? urls : []) };
    });
  }

  /** Included now: they stay listed, and cannot go twice. */
  take(urls: readonly string[]): void {
    this.change((state) => ({
      ...state,
      taken: new Set([...state.taken, ...urls]),
    }));
  }

  private pull(): Observable<unknown> {
    this.change((state) => ({ ...state, error: null, partial: false }));
    return this.step().pipe(
      expand(() => (this.goesOn() ? this.step() : EMPTY)),
      catchError((err: unknown) => {
        this.change((state) => ({ ...state, error: toUiErrorCode(err) }));
        return EMPTY;
      }),
      finalize(() => this.change((state) => ({ ...state, searching: false }))),
    );
  }

  private step(): Observable<WebSearchResponse> {
    return defer(() => {
      const state = this.state();
      if (!state) return EMPTY;
      const missing = state.wanted - state.results.length;
      const sources = Math.max(1, Math.min(SEARCH_STEP, missing));
      const { topic, request } = state.asked;
      return this.api.search(topic, { ...request, sources });
    }).pipe(tap((answer) => this.receive(answer)));
  }

  private goesOn(): boolean {
    const state = this.state();
    return (
      state !== null &&
      state.results.length < state.wanted &&
      !state.exhausted &&
      !state.partial
    );
  }

  private receive(answer: WebSearchResponse): void {
    this.change((state) => {
      const known = new Set(state.results.map((one) => one.url));
      const fresh = answer.results.filter((one) => !known.has(one.url));
      return {
        ...state,
        results: [...state.results, ...fresh],
        exhausted: answer.exhausted,
        partial: answer.partial,
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

  private change(apply: (state: SearchState) => SearchState): void {
    this.state.update((state) => state && apply(state));
  }
}
