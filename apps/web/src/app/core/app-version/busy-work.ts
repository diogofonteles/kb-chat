import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
  type Signal,
} from '@angular/core';

/**
 * What a reload would lose right now (KBC-123): text typed and not sent, an upload, audio
 * playing, an answer arriving. AppVersion reads it before reloading into a new version;
 * whoever has such work registers it here, with no other dependency.
 */
@Injectable({ providedIn: 'root' })
export class BusyWork {
  private readonly holds = signal<ReadonlySet<string>>(new Set());
  private readonly sources = signal<readonly Signal<boolean>[]>([]);

  /** Something here would be lost by a reload. */
  readonly busy = computed(
    () => this.holds().size > 0 || this.sources().some((source) => source()),
  );

  /** Marks `key` as in progress until `release(key)` (an upload, say). */
  hold(key: string): void {
    this.holds.update((keys) => new Set(keys).add(key));
  }

  release(key: string): void {
    this.holds.update((keys) => {
      const left = new Set(keys);
      left.delete(key);
      return left;
    });
  }

  /** In progress while `busy` is true, until the caller is destroyed. */
  holdWhile(
    busy: Signal<boolean>,
    destroyRef: DestroyRef = inject(DestroyRef),
  ): void {
    this.sources.update((list) => [...list, busy]);
    destroyRef.onDestroy(() =>
      this.sources.update((list) => list.filter((source) => source !== busy)),
    );
  }
}
