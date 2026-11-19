import { Injectable, computed, signal } from '@angular/core';

/** A file this browser is sending now: its title and how much has gone. */
export interface UploadInFlight {
  readonly key: string;
  readonly title: string;
  readonly loaded: number;
  readonly total: number;
}

/**
 * What this browser is sending, for the library's "N áudios em processamento" (v2 ·
 * media-upload-sending): the upload panel says it here, the queue's block shows it before
 * what the API already lists. Only the browser knows how far a send has gone.
 */
@Injectable({ providedIn: 'root' })
export class UploadsInFlight {
  private readonly bySource = signal<
    ReadonlyMap<string, readonly UploadInFlight[]>
  >(new Map());

  readonly items = computed(() => [...this.bySource().values()].flat());

  /** Puts what one panel sends now in place of what it said before. */
  report(source: string, items: readonly UploadInFlight[]): void {
    this.bySource.update((all) => {
      const next = new Map(all);
      if (items.length > 0) next.set(source, items);
      else next.delete(source);
      return next;
    });
  }
}

/** "Enviando · 12%": how far a send has gone, in whole percent. */
export const percentOfUpload = ({ loaded, total }: UploadInFlight): number =>
  total > 0 ? Math.min(100, Math.floor((loaded / total) * 100)) : 0;
