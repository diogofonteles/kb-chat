import { httpResource } from '@angular/common/http';
import { Injectable, computed, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import {
  libraryCountsSchema,
  myMediaBookmarkListSchema,
} from '@kb-chat/contracts';
import { SessionStore } from '@core/auth/session-store.js';
import { MY_BOOKMARKS_URL } from '@core/media/bookmarks-api.js';
import { LIBRARY_COUNTS_URL } from '@core/media/library-api.js';
import { hasLibrary } from '@features/media/library/library-access.js';
import { filter } from 'rxjs';

/**
 * The counts in "Sua biblioteca" (v2: "Todas as mídias · 11", "Lista · 12 marcadores",
 * "Acervo · 11 áudios · 1 documento"): the library's media, in all and per collection, for
 * who has the library, and one's bookmarks, for who listens. Asked again on each navigation,
 * so a media sent or a bookmark made shows on the next page.
 */
@Injectable({ providedIn: 'root' })
export class LibraryCounts {
  private readonly session = inject(SessionStore);
  private readonly media = httpResource(
    () => (hasLibrary(this.session) ? LIBRARY_COUNTS_URL : undefined),
    { parse: (body) => libraryCountsSchema.parse(body) },
  );
  private readonly bookmarkList = httpResource(
    () => (this.listens() ? MY_BOOKMARKS_URL : undefined),
    { parse: (body) => myMediaBookmarkListSchema.parse(body).items.length },
  );
  private readonly listens = computed(
    () => this.session.me()?.media === true && this.session.can('media'),
  );
  /** The library's media in all; null until known (or without the library). */
  readonly total = computed(() =>
    this.media.hasValue() ? this.media.value().total : null,
  );
  /** One's bookmarks; null until known. */
  readonly bookmarks = computed(() =>
    this.bookmarkList.hasValue() ? this.bookmarkList.value() : null,
  );

  constructor() {
    inject(Router)
      .events.pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => {
        if (this.media.status() !== 'idle') this.media.reload();
        if (this.bookmarkList.status() !== 'idle') this.bookmarkList.reload();
      });
  }

  /** A collection's media (its own and its sub-collections'); null until known. */
  mediaIn(slug: string, children: readonly string[] = []): number | null {
    if (!this.media.hasValue()) return null;
    const { topics } = this.media.value();
    return [slug, ...children].reduce(
      (sum, one) => sum + (topics[one] ?? 0),
      0,
    );
  }
}
