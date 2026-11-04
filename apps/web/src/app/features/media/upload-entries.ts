import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { UploadCheck } from '@kb-chat/contracts';
import { MediaApi } from '@core/media/media-api.js';
import {
  EMPTY,
  Subject,
  catchError,
  concat,
  concatMap,
  defer,
  ignoreElements,
  map,
  of,
  tap,
  type Observable,
} from 'rxjs';
import { AUDIO_LENGTH_READER } from './audio-length.js';
import { hashFile } from './file-hash.js';
import { fileProblemOf, titleFromFileName } from './upload-rules.js';

/** Where a chosen file is, from the choice to "Enviado" (screens.md T14, KBC-035). */
export type EntryState =
  | { readonly kind: 'checking'; readonly percent: number }
  | { readonly kind: 'ready' }
  | { readonly kind: 'refused'; readonly problem: string }
  | {
      readonly kind: 'duplicate';
      readonly media: { readonly id: string; readonly title: string };
    }
  | { readonly kind: 'over-quota'; readonly quotaBytes: number }
  | { readonly kind: 'resume'; readonly mediaId: string; readonly offset: number }
  | { readonly kind: 'expired' }
  | { readonly kind: 'sending'; readonly loaded: number; readonly total: number }
  | { readonly kind: 'stopped'; readonly problem: string }
  | { readonly kind: 'done' };

export interface UploadEntry {
  readonly key: number;
  readonly file: File;
  readonly title: string;
  readonly sha256: string | null;
  readonly durationMs: number | null;
  readonly state: EntryState;
}

/** What "Enviar" takes; the others say why not on their own line. */
const SENDABLE: readonly EntryState['kind'][] = [
  'ready',
  'resume',
  'expired',
  'stopped',
];

/** A verdict the API gave, as a line of the list. */
function stateOf(check: UploadCheck): EntryState {
  switch (check.verdict) {
    case 'new':
      return { kind: 'ready' };
    case 'duplicate':
      return { kind: 'duplicate', media: check.media };
    case 'resume':
      return {
        kind: 'resume',
        mediaId: check.media.id,
        offset: check.offset,
      };
    case 'expired':
      return { kind: 'expired' };
    case 'over-quota':
      return { kind: 'over-quota', quotaBytes: check.quotaBytes };
  }
}

/**
 * The files of the upload panel: each is hashed and measured in the browser and asked about,
 * one at a time, while the panel goes on (KBC-035 FR-1). Nothing is sent from here.
 */
@Injectable()
export class UploadEntries {
  private readonly api = inject(MediaApi);
  private readonly readLength = inject(AUDIO_LENGTH_READER);
  private readonly list = signal<readonly UploadEntry[]>([]);
  private readonly toCheck = new Subject<number>();
  private topic = '';
  private lastKey = 0;

  readonly entries = this.list.asReadonly();
  readonly checking = computed(() =>
    this.list().some(({ state }) => state.kind === 'checking'),
  );
  readonly sendable = computed(() =>
    this.list().filter(({ state }) => SENDABLE.includes(state.kind)),
  );

  constructor() {
    this.toCheck
      .pipe(
        concatMap((key) => this.inspect(key)),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe();
  }

  /** The collection the files would go to: a change asks about every file again (BR-2). */
  aim(topic: string): void {
    if (topic === this.topic) return;
    this.topic = topic;
    for (const entry of this.list()) {
      if (entry.sha256 === null || entry.state.kind === 'refused') continue;
      this.set(entry.key, { kind: 'checking', percent: 100 });
      this.toCheck.next(entry.key);
    }
  }

  /** Adds what was chosen; the same file chosen twice stays once. */
  add(files: readonly File[]): void {
    for (const file of files) {
      if (this.holds(file)) continue;
      const problem = fileProblemOf(file);
      this.lastKey += 1;
      const key = this.lastKey;
      const entry: UploadEntry = {
        key,
        file,
        title: titleFromFileName(file.name),
        sha256: null,
        durationMs: null,
        state: problem
          ? { kind: 'refused', problem }
          : { kind: 'checking', percent: 0 },
      };
      this.list.update((list) => [...list, entry]);
      if (!problem) this.toCheck.next(key);
    }
  }

  remove(key: number): void {
    this.list.update((list) => list.filter((entry) => entry.key !== key));
  }

  rename(key: number, title: string): void {
    this.update(key, { title });
  }

  set(key: number, state: EntryState): void {
    this.update(key, { state });
  }

  private holds({ name, size, lastModified }: File): boolean {
    return this.list().some(
      ({ file }) =>
        file.name === name &&
        file.size === size &&
        file.lastModified === lastModified,
    );
  }

  private entry(key: number): UploadEntry | undefined {
    return this.list().find((entry) => entry.key === key);
  }

  private update(key: number, change: Partial<UploadEntry>): void {
    this.list.update((list) =>
      list.map((entry) =>
        entry.key === key ? { ...entry, ...change } : entry,
      ),
    );
  }

  /** Hash, length, then the API's word; a file taken off the list stops counting. */
  private inspect(key: number): Observable<never> {
    const entry = this.entry(key);
    if (!entry) return EMPTY;
    return concat(this.measure(entry), defer(() => this.ask(key)));
  }

  private measure(entry: UploadEntry): Observable<never> {
    if (entry.sha256 !== null) return EMPTY;
    const { key, file } = entry;
    const hashed = hashFile(file).pipe(
      tap((event) =>
        event.kind === 'done'
          ? this.update(key, { sha256: event.sha256 })
          : this.onlyIfChecking(key, event.percent),
      ),
    );
    const length = this.readLength(file).pipe(
      tap((durationMs) => this.update(key, { durationMs })),
    );
    return concat(hashed, length).pipe(ignoreElements());
  }

  private onlyIfChecking(key: number, percent: number): void {
    if (this.entry(key)?.state.kind === 'checking')
      this.set(key, { kind: 'checking', percent });
  }

  /** A check that fails lets the file through: creating the item decides the same rules. */
  private ask(key: number): Observable<never> {
    const entry = this.entry(key);
    if (!entry?.sha256) return EMPTY;
    const { sha256, durationMs, file, state } = entry;
    if (state.kind !== 'checking') return EMPTY;
    const request = { sha256, durationMs, bytes: file.size };
    return this.api.check(this.topic, request).pipe(
      tap((check) => {
        // A resumed upload keeps the title it was started with.
        if (check.verdict === 'resume') this.rename(key, check.media.title);
      }),
      map(stateOf),
      catchError(() => of<EntryState>({ kind: 'ready' })),
      tap((next) => this.set(key, next)),
      ignoreElements(),
    );
  }
}
