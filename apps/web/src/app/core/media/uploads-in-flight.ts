import {
  type DestroyRef,
  Injectable,
  type Signal,
  computed,
  signal,
} from '@angular/core';

/** A file this browser is sending now: its title and how much has gone. */
export interface UploadInFlight {
  readonly key: string;
  readonly title: string;
  readonly loaded: number;
  readonly total: number;
}

/**
 * What this browser is sending, for the library's "N áudios em processamento" (v2 ·
 * media-upload-sending): each upload panel registers what it sends, the queue's block shows
 * it before what the API already lists. Only the browser knows how far a send has gone. The
 * panels' signals are read, never copied, so nothing is written from an effect (NG-14).
 */
@Injectable({ providedIn: 'root' })
export class UploadsInFlight {
  private readonly panels = signal<
    readonly Signal<readonly UploadInFlight[]>[]
  >([]);

  readonly items = computed(() => this.panels().flatMap((sends) => sends()));

  /** One panel's sends, followed until the panel is destroyed. */
  register(
    sends: Signal<readonly UploadInFlight[]>,
    destroyRef: DestroyRef,
  ): void {
    this.panels.update((all) => [...all, sends]);
    destroyRef.onDestroy(() =>
      this.panels.update((all) => all.filter((one) => one !== sends)),
    );
  }
}

/** "Enviando · 12%": how far a send has gone, in whole percent. */
export const percentOfUpload = ({ loaded, total }: UploadInFlight): number =>
  total > 0 ? Math.min(100, Math.floor((loaded / total) * 100)) : 0;
