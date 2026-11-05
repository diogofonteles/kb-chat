import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import type { Signal } from '@angular/core';

/** What a media page shows, for the header to name it (KBC-091). */
export type HeadingScope =
  { readonly kind: 'all' } | { readonly kind: 'topic'; readonly slug: string };

/**
 * The collection the media page on screen shows: the header never names another one. A page
 * says it while it lives; with none, the header names no collection.
 */
@Injectable({ providedIn: 'root' })
export class CollectionHeading {
  private readonly source = signal<Signal<HeadingScope | null> | null>(null);
  readonly scope = computed(() => this.source()?.() ?? null);

  /** For a page, in an injection context. */
  follow(scope: Signal<HeadingScope | null>): void {
    this.source.set(scope);
    inject(DestroyRef).onDestroy(() => {
      if (this.source() === scope) this.source.set(null);
    });
  }
}
