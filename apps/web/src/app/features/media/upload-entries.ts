import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  PREPARATION_MAX_DURATION_MS,
  type UploadCheck,
} from '@kb-chat/contracts';
import { SessionStore } from '@core/auth/session-store.js';
import { MediaApi } from '@core/media/media-api.js';
import { PreparationApi } from '@core/media/preparation-api.js';
import {
  EMPTY,
  Subject,
  catchError,
  concat,
  concatMap,
  defer,
  filter,
  ignoreElements,
  of,
  takeWhile,
  tap,
  type Observable,
} from 'rxjs';
import { AUDIO_LENGTH_READER } from './audio-length.js';
import { hashFile } from './file-hash.js';
import {
  fileProblemOf,
  titleFromFileName,
  unreadableFile,
} from './upload-rules.js';

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
  | {
      readonly kind: 'resume';
      readonly mediaId: string;
      readonly offset: number;
    }
  | { readonly kind: 'expired' }
  | {
      readonly kind: 'sending';
      readonly loaded: number;
      readonly total: number;
      /** The network went away: the upload goes on by itself when it returns (AC-1). */
      readonly offline?: boolean;
    }
  | { readonly kind: 'stopped'; readonly problem: string }
  | { readonly kind: 'done' };

export interface UploadEntry {
  readonly key: number;
  readonly file: File;
  readonly title: string;
  readonly sha256: string | null;
  readonly durationMs: number | null;
  /** Continues an item of an earlier upload, which keeps the plan it was created with. */
  readonly resumes: boolean;
  /** What that plan may spend, once read; null when it is free or unknown. */
  readonly keptUsd: number | null;
  readonly state: EntryState;
}

/** The length the plan's estimates go by, or why there is none. */
export type PlannedLength = number | 'unknown' | 'past-limit';

/** What "Enviar" takes; the others say why not on their own line. */
const SENDABLE: readonly EntryState['kind'][] = [
  'ready',
  'resume',
  'expired',
  'stopped',
];

/** What will not become an item with the panel's plan. */
const OUTSIDE_THE_PLAN: readonly EntryState['kind'][] = [
  'refused',
  'duplicate',
  'over-quota',
];

/** What a change of collection does not ask about again. */
const SETTLED: readonly EntryState['kind'][] = ['refused', 'sending', 'done'];

/** What each verdict of the API is on the list. */
const STATE_OF: {
  readonly [V in UploadCheck['verdict']]: (
    check: Extract<UploadCheck, { verdict: V }>,
  ) => EntryState;
} = {
  new: () => ({ kind: 'ready' }),
  duplicate: ({ media }) => ({ kind: 'duplicate', media }),
  resume: ({ media, offset }) => ({
    kind: 'resume',
    mediaId: media.id,
    offset,
  }),
  expired: () => ({ kind: 'expired' }),
  'over-quota': ({ quotaBytes }) => ({ kind: 'over-quota', quotaBytes }),
};

const stateOf = <V extends UploadCheck['verdict']>(
  check: Extract<UploadCheck, { verdict: V }>,
): EntryState => STATE_OF[check.verdict as V](check);

/**
 * The files of the upload panel: each is hashed and measured in the browser and asked about,
 * one at a time, while the panel goes on (KBC-035 FR-1). Nothing is sent from here.
 */
@Injectable()
export class UploadEntries {
  private readonly api = inject(MediaApi);
  private readonly preparations = inject(PreparationApi);
  private readonly session = inject(SessionStore);
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
  /** The files the panel's plan is for. */
  private readonly planned = computed(() =>
    this.list().filter(
      ({ resumes, state }) =>
        !resumes && !OUTSIDE_THE_PLAN.includes(state.kind),
    ),
  );
  /** Every file on the list goes on with the plan it already has. */
  readonly onlyResuming = computed(
    () => this.list().length > 0 && this.list().every(({ resumes }) => resumes),
  );
  readonly anyResuming = computed(() =>
    this.list().some(({ resumes }) => resumes),
  );
  /** The value kept by what goes on, in all; null when none of it is paid. */
  readonly keptUsd = computed<number | null>(() => {
    const kept = this.list().flatMap(({ resumes, keptUsd }) =>
      resumes && keptUsd !== null ? [keptUsd] : [],
    );
    return kept.length > 0 ? kept.reduce((sum, usd) => sum + usd, 0) : null;
  });
  /**
   * The length the plan's estimates go by: all of its files, unless one is not known or
   * cannot be read, or the sum is past what the API estimates (KBC-072 BR-4).
   */
  readonly plannedLength = computed<PlannedLength>(() => {
    const planned = this.planned();
    if (planned.length === 0) return 'unknown';
    let allMs = 0;
    for (const { durationMs } of planned) {
      if (durationMs === null) return 'unknown';
      allMs += durationMs;
    }
    if (allMs > PREPARATION_MAX_DURATION_MS) return 'past-limit';
    return allMs > 0 ? allMs : 'unknown';
  });
  readonly plannedMs = computed<number | null>(() => {
    const length = this.plannedLength();
    return typeof length === 'number' ? length : null;
  });

  constructor() {
    this.toCheck
      .pipe(
        concatMap((key) => this.inspect(key)),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe();
  }

  /**
   * The collection the files would go to: a change asks about every file again (BR-2), except
   * those that went or are going, whose collection no longer changes.
   */
  aim(topic: string): void {
    if (topic === this.topic) return;
    this.topic = topic;
    for (const entry of this.list()) {
      if (entry.sha256 === null || SETTLED.includes(entry.state.kind)) continue;
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
        resumes: false,
        keptUsd: null,
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
    // Past the 24 h the old item is gone: the next one takes the panel's plan.
    this.update(
      key,
      state.kind === 'expired' ? { state, resumes: false } : { state },
    );
  }

  /** A file on its way waits for the network, where it stopped. */
  markOffline(key: number): void {
    const state = this.entry(key)?.state;
    if (state?.kind === 'sending') this.set(key, { ...state, offline: true });
  }

  /** After a cancel: what was on its way, or stopped, can go again as new. */
  backToReady(): void {
    this.list.update((list) =>
      list.map((entry) =>
        ['sending', 'stopped'].includes(entry.state.kind)
          ? { ...entry, resumes: false, state: { kind: 'ready' } }
          : entry,
      ),
    );
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

  /**
   * Hash, length, then the API's word; a file taken off the list stops counting, and one
   * that can no longer be read fails alone: the rest of the queue goes on.
   */
  private inspect(key: number): Observable<never> {
    const entry = this.entry(key);
    if (!entry) return EMPTY;
    return concat(
      this.measure(entry),
      defer(() => this.ask(key)),
    ).pipe(
      catchError(() => {
        this.set(key, { kind: 'refused', problem: unreadableFile() });
        return EMPTY;
      }),
    );
  }

  private measure(entry: UploadEntry): Observable<never> {
    if (entry.sha256 !== null) return EMPTY;
    const { key, file } = entry;
    const listed = () => this.entry(key) !== undefined;
    const hashed = hashFile(file).pipe(
      takeWhile(listed),
      tap((event) =>
        event.kind === 'done'
          ? this.update(key, { sha256: event.sha256 })
          : this.onlyIfChecking(key, event.percent),
      ),
    );
    const length = defer(() => (listed() ? this.readLength(file) : EMPTY)).pipe(
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
    const { topic } = this;
    return this.api.check(topic, request).pipe(
      catchError(() => of<UploadCheck>({ verdict: 'new' })),
      // Another collection was chosen meanwhile: its own check is already queued.
      filter(() => topic === this.topic),
      tap((check) => {
        // A resumed upload keeps the title it was started with.
        if (check.verdict === 'resume') this.rename(key, check.media.title);
        this.update(key, { resumes: check.verdict === 'resume' });
        this.set(key, stateOf(check));
      }),
      concatMap((check) => this.readKept(key, check)),
      ignoreElements(),
    );
  }

  /**
   * What the plan of a resumed item may spend, for the panel's notice. Only who may ask for
   * the paid step can have one; if it cannot be read the notice just says less.
   */
  private readKept(key: number, check: UploadCheck): Observable<unknown> {
    if (check.verdict !== 'resume' || !this.session.can('media-edit-ai'))
      return EMPTY;
    return this.preparations.read(check.media.id).pipe(
      tap(({ plan }) => {
        if (plan?.tracks === 'ai')
          this.update(key, { keptUsd: plan.acceptedUsd });
      }),
      catchError(() => EMPTY),
    );
  }
}
