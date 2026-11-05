import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  librarySearchSchema,
  type LibraryFacets,
  type LibraryFilters,
  type LibraryHit as Hit,
  type LibrarySearch,
  type LibrarySort,
  type LibraryView,
  type Topic,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { SessionStore } from '@core/auth/session-store.js';
import {
  LibraryApi,
  librarySearchUrlOf,
  type LibrarySearchRequest,
} from '@core/media/library-api.js';
import { MediaEngine } from '@core/media/media-engine.js';
import { UsageLog } from '@core/usage/usage-log.js';
import { Subject, catchError, map, of, switchMap } from 'rxjs';
import { playbackStartOf } from '../search-hit/passage-focus.js';
import { LibraryControls } from './library-controls.js';
import { LibraryHit } from './library-hit.js';
import {
  activeFiltersOf,
  resultCountOf,
  type FilterChange,
} from './library-labels.js';
import { NearEnd } from './near-end.js';
import { PlayNow } from './play-now.js';

/** One page asked after the first: of which search, and from where. */
interface MoreAsked {
  readonly request: LibrarySearchRequest;
  readonly cursor: string;
}

/**
 * The results of "Buscar na biblioteca" (KBC-096): the first content under the box, tracks and
 * audio that answer, the speech first. A new search's answer replaces the last one, so a late
 * answer never lands: `httpResource` drops the request of words no longer asked.
 */
@Component({
  selector: 'app-library-search-results',
  imports: [LibraryControls, LibraryHit, NearEnd],
  templateUrl: './library-search-results.html',
  styleUrl: './library-search-results.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LibrarySearchResults {
  private readonly api = inject(LibraryApi);
  private readonly session = inject(SessionStore);
  private readonly engine = inject(MediaEngine);
  private readonly playNow = inject(PlayNow);
  private readonly usage = inject(UsageLog);

  /** The words asked, after the pause. */
  readonly query = input.required<string>();
  /** The words in the box now; while they differ, an answer is on its way. */
  readonly typed = input.required<string>();
  readonly filters = input.required<LibraryFilters>();
  readonly facets = input.required<LibraryFacets>();
  readonly topics = input<readonly Topic[]>([]);
  readonly sort = input.required<LibrarySort>();
  readonly view = input.required<LibraryView>();
  readonly filtersChange = output<FilterChange>();
  readonly clearedSearch = output();
  readonly clearedFilters = output();
  /** The count, for the page's status region. */
  readonly announced = output<string>();

  private readonly request = computed<LibrarySearchRequest | null>(
    () => {
      const query = this.query().trim();
      return query ? { query, filters: this.filters() } : null;
    },
    { equal: (a, b) => urlOf(a) === urlOf(b) },
  );
  protected readonly firstPage = httpResource(
    () => {
      const url = urlOf(this.request());
      return url || undefined;
    },
    { parse: (body) => librarySearchSchema.parse(body) },
  );
  private readonly firstAnswer = computed(() =>
    this.firstPage.hasValue() ? this.firstPage.value() : null,
  );
  /** What was on screen stays while the next answer is on its way. */
  protected readonly lastPage = linkedSignal<
    LibrarySearch | null,
    LibrarySearch | null
  >({
    source: this.firstAnswer,
    computation: (page, previous) => page ?? previous?.value ?? null,
  });
  /** The pages after the first; each new answer forgets them. */
  private readonly more = linkedSignal<
    LibrarySearch | null,
    { items: readonly Hit[]; nextCursor: string | null }
  >({
    source: this.firstAnswer,
    computation: (page) => ({
      items: [],
      nextCursor: page?.nextCursor ?? null,
    }),
  });
  private readonly moreAsked = new Subject<MoreAsked>();
  protected readonly loadingMore = signal(false);
  protected readonly moreError = signal('');

  protected readonly hits = computed(() => [
    ...(this.lastPage()?.items ?? []),
    ...this.more().items,
  ]);
  protected readonly hasMore = computed(() => this.more().nextCursor !== null);
  /** Words typed, or asked and not answered yet. */
  protected readonly pending = computed(
    () => this.typed() !== this.query().trim() || this.firstPage.isLoading(),
  );
  protected readonly failed = computed(
    () => this.firstPage.error() !== undefined,
  );
  protected readonly showSkeleton = computed(
    () => this.pending() && this.lastPage() === null,
  );
  protected readonly nothingFound = computed(
    () =>
      !this.pending() &&
      !this.failed() &&
      this.lastPage() !== null &&
      this.hits().length === 0,
  );
  protected readonly countText = computed(() => {
    const page = this.lastPage();
    return page ? resultCountOf(page.total, page.capped) : '';
  });
  protected readonly filtered = computed(
    () => activeFiltersOf(this.filters()) > 0,
  );
  /** The speech is said only to who searches in it (R4). */
  protected readonly searchesSpeech = computed(() =>
    this.session.can('search'),
  );
  protected readonly playingId = computed(() =>
    this.engine.playing() ? (this.engine.source()?.id ?? null) : null,
  );

  constructor() {
    this.moreAsked
      .pipe(
        switchMap((asked) =>
          this.api.search(asked.request, asked.cursor).pipe(
            catchError((failure: unknown) => {
              this.moreError.set(errorMessage(toUiErrorCode(failure)));
              return of(null);
            }),
            // Past this search: the answer belongs to words no longer on screen.
            map((page) => (asked.request === this.request() ? page : null)),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((page) => {
        this.loadingMore.set(false);
        if (page)
          this.more.update(({ items }) => ({
            items: [...items, ...page.items],
            nextCursor: page.nextCursor,
          }));
      });
    effect(() => {
      if (!this.pending() && !this.failed())
        this.announced.emit(`${this.countText()}: ${this.query().trim()}`);
    });
  }

  protected loadMore(): void {
    const request = this.request();
    const cursor = this.more().nextCursor;
    if (!request || !cursor || this.loadingMore()) return;
    this.moreError.set('');
    this.loadingMore.set(true);
    this.moreAsked.next({ request, cursor });
  }

  protected reload(): void {
    this.firstPage.reload();
  }

  /** The row's ▶: from the passage when there is one, else from where the person stopped. */
  protected play(hit: Hit, position: number): void {
    const { item, passage } = hit;
    if (!passage) {
      this.playNow.play(item);
      return;
    }
    this.report(hit, position);
    this.playNow.playFrom(item, playbackStartOf(passage));
  }

  /** The metric of KBC-039 FR-4: a passage opened from the results. */
  protected report({ item, passage }: Hit, position: number): void {
    if (passage)
      this.usage.track({
        type: 'media_hit_opened',
        mediaId: item.id,
        startMs: passage.startMs,
        position,
      });
  }
}

function urlOf(request: LibrarySearchRequest | null): string {
  return request ? librarySearchUrlOf(request) : '';
}
