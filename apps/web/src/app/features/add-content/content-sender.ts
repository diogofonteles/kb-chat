import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type {
  CreateDocumentUploadRequest,
  CreateDocumentUploadResponse,
  DocumentBatchRequest,
  UploadedDocumentRef,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { MediaApi, type UploadEvent } from '@core/media/media-api.js';
import { DocumentUploadsApi } from '@core/documents/document-uploads-api.js';
import { hashFile } from '@features/media/file-hash.js';
import { titleFromFileName } from '@features/media/upload-rules.js';
import {
  EMPTY,
  Subject,
  catchError,
  concatMap,
  defer,
  filter,
  fromEvent,
  map,
  of,
  retry,
  throwError,
  timer,
  type Observable,
} from 'rxjs';

export type ContentSource =
  | { readonly kind: 'file'; readonly file: File; readonly path: string }
  | { readonly kind: 'audio'; readonly file: File; readonly path: string }
  | {
      readonly kind: 'url';
      readonly url: string;
      /** What the search found it to be; left out, the address decides. */
      readonly as?: 'page' | 'recording';
    };

/** Where an item's send is; one at a time (PD-05: a union, never two flags). */
export type SendPhase =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'hashing'; readonly percent: number }
  | { readonly kind: 'sending'; readonly percent: number }
  | { readonly kind: 'sent' }
  | {
      readonly kind: 'duplicate';
      readonly document: UploadedDocumentRef | null;
      readonly onItsWay: boolean;
    }
  | { readonly kind: 'error'; readonly message: string };

/** What one inclusion sends, and where it goes. */
export interface ContentTarget {
  readonly topic: string;
  readonly level: string | null;
  readonly batch: DocumentBatchRequest;
}

export interface ContentSend {
  readonly key: number;
  readonly name: string;
  readonly source: ContentSource;
  readonly target: ContentTarget;
  readonly phase: SendPhase;
}

/** The API's per-minute limit, or no network: the item waits and goes again by itself. */
const WAIT_MS = 15_000;
const TRIES = 20;
const PASSING = new Set(['RATE_LIMITED', 'OFFLINE']);

/** How a folder's send stands: every item is in one of them, so the sum always closes. */
export interface SendSummary {
  readonly total: number;
  readonly active: number;
  readonly sent: number;
  readonly already: number;
  readonly failed: number;
}

const ACTIVE = new Set<SendPhase['kind']>(['waiting', 'hashing', 'sending']);

const nameOf = (source: ContentSource): string =>
  source.kind === 'url' ? source.url : source.path;

const ALREADY: SendPhase = {
  kind: 'duplicate',
  document: null,
  onItsWay: false,
};

const percentOf = (loaded: number, total: number): number =>
  Math.floor((loaded / Math.max(total, 1)) * 100);

/** What passes by itself (the limit per minute, the network) is tried again after a wait. */
const again = <T>() =>
  retry<T>({
    count: TRIES,
    delay: (err: unknown) =>
      PASSING.has(toUiErrorCode(err)) ? timer(WAIT_MS) : throwError(() => err),
  });

/**
 * Sends what the person included (KBC-184), one item after the other: a file is hashed in the
 * browser, announced and sent by tus (ADR 0033); a link is announced. What is already in the
 * collection says so. An item that fails never stops the next ones.
 *
 * It outlives the page: the person goes on in the app while a folder is sent, and finds the
 * account again on coming back. Closing the tab is what stops it, so the browser asks first.
 */
@Injectable({ providedIn: 'root' })
export class ContentSender {
  private readonly api = inject(DocumentUploadsApi);
  private readonly media = inject(MediaApi);
  private readonly line = new Subject<number>();
  private readonly entries = signal<readonly ContentSend[]>([]);
  private lastKey = 0;

  readonly sends = this.entries.asReadonly();
  /** Something is still on its way out of this browser: leaving would stop it. */
  readonly busy = computed(() =>
    this.entries().some((one) => ACTIVE.has(one.phase.kind)),
  );
  /** Where everything is; `total` is always the sum of the others. */
  readonly summary = computed<SendSummary>(() => {
    const kinds = this.entries().map((one) => one.phase.kind);
    const of = (kind: SendPhase['kind']) =>
      kinds.filter((one) => one === kind).length;
    return {
      total: kinds.length,
      active: kinds.filter((one) => ACTIVE.has(one)).length,
      sent: of('sent'),
      already: of('duplicate'),
      failed: of('error'),
    };
  });

  constructor() {
    this.line
      .pipe(
        concatMap((key) =>
          this.run(key).pipe(
            catchError((err: unknown) => {
              this.put(key, {
                kind: 'error',
                message: errorMessage(toUiErrorCode(err)),
              });
              return EMPTY;
            }),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe();
    const view = inject(DOCUMENT).defaultView;
    if (view)
      fromEvent<BeforeUnloadEvent>(view, 'beforeunload')
        .pipe(
          filter(() => this.busy()),
          takeUntilDestroyed(),
        )
        .subscribe((event) => event.preventDefault());
  }

  add(sources: readonly ContentSource[], target: ContentTarget): void {
    const added = sources.map((source): ContentSend => ({
      key: ++this.lastKey,
      name: nameOf(source),
      source,
      target,
      phase: { kind: 'waiting' },
    }));
    this.entries.update((all) => [...all, ...added]);
    for (const { key } of added) this.line.next(key);
  }

  retry(key: number): void {
    const entry = this.entryOf(key);
    if (entry?.phase.kind !== 'error') return;
    this.put(key, { kind: 'waiting' });
    this.line.next(key);
  }

  retryFailed(): void {
    for (const { key, phase } of this.entries())
      if (phase.kind === 'error') this.retry(key);
  }

  /** What ended well leaves the list; what failed or is on its way stays. */
  clearDone(): void {
    this.entries.update((all) =>
      all.filter(
        ({ phase }) => phase.kind === 'error' || ACTIVE.has(phase.kind),
      ),
    );
  }

  /** Takes an item off the list: one that did not start never goes. */
  remove(key: number): void {
    const kind = this.entryOf(key)?.phase.kind;
    if (kind === 'hashing' || kind === 'sending') return;
    this.entries.update((all) => all.filter((one) => one.key !== key));
  }

  private entryOf(key: number): ContentSend | undefined {
    return this.entries().find((one) => one.key === key);
  }

  private put(key: number, phase: SendPhase): void {
    this.entries.update((all) =>
      all.map((one) => (one.key === key ? { ...one, phase } : one)),
    );
  }

  private run(key: number): Observable<unknown> {
    return defer(() => {
      const entry = this.entryOf(key);
      if (!entry) return EMPTY;
      const { source } = entry;
      if (source.kind === 'url') return this.sendLink(entry, source);
      return source.kind === 'audio'
        ? this.sendAudio(entry, source.file)
        : this.sendFile(entry, source.file);
    });
  }

  private sendLink(
    entry: ContentSend,
    { url, as }: Extract<ContentSource, { kind: 'url' }>,
  ): Observable<unknown> {
    this.put(entry.key, { kind: 'sending', percent: 0 });
    const request = { kind: 'url' as const, url, ...(as && { as }) };
    return this.create(entry, request).pipe(
      map((answer) => this.answered(entry.key, answer)),
    );
  }

  private sendFile(entry: ContentSend, file: File): Observable<unknown> {
    return this.hashed(entry.key, file).pipe(
      concatMap((sha256) =>
        this.create(entry, {
          ...{ kind: 'file', name: file.name, bytes: file.size },
          sha256,
        }),
      ),
      concatMap((answer) => this.sendBytes(entry.key, answer, file)),
    );
  }

  /** The file's hash, its progress on the item's line. */
  private hashed(key: number, file: File): Observable<string> {
    this.put(key, { kind: 'hashing', percent: 0 });
    return hashFile(file).pipe(
      filter((event) => {
        if (event.kind === 'progress')
          this.put(key, { kind: 'hashing', percent: event.percent });
        return event.kind === 'done';
      }),
      map((event) => (event.kind === 'done' ? event.sha256 : '')),
    );
  }

  /** A recording goes to the library (KBC-035) and is transcribed; one stopped goes on. */
  private sendAudio(entry: ContentSend, file: File): Observable<unknown> {
    const { key, target } = entry;
    return this.hashed(key, file).pipe(
      concatMap((sha256) =>
        this.media
          .check(target.topic, { sha256, bytes: file.size, durationMs: null })
          .pipe(
            again(),
            concatMap((check) => {
              if (
                check.verdict === 'duplicate' ||
                check.verdict === 'duplicate-hidden'
              ) {
                this.put(key, ALREADY);
                return EMPTY;
              }
              return check.verdict === 'resume'
                ? of(check.media.id)
                : this.createAudio(entry, { file, sha256 });
            }),
          ),
      ),
      concatMap((id) => {
        this.put(key, { kind: 'sending', percent: 0 });
        return this.media.upload(id, file);
      }),
      map((event) => this.followAudio(key, event)),
    );
  }

  private createAudio(
    { target }: ContentSend,
    { file, sha256 }: { readonly file: File; readonly sha256: string },
  ): Observable<string> {
    const request = {
      title: titleFromFileName(file.name),
      author: null,
      fileName: file.name,
      bytes: file.size,
      sha256,
      ...(target.level !== null && { level: target.level }),
    };
    return this.media.create(target.topic, request).pipe(
      again(),
      map((item) => item.id),
    );
  }

  private followAudio(key: number, event: UploadEvent): void {
    if (event.kind === 'done') this.put(key, { kind: 'sent' });
    else if (event.kind === 'progress')
      this.put(key, {
        kind: 'sending',
        percent: percentOf(event.loaded, event.total),
      });
  }

  private create(
    entry: ContentSend,
    source:
      | { kind: 'url'; url: string; as?: 'page' | 'recording' }
      | { kind: 'file'; name: string; bytes: number; sha256: string },
  ): Observable<CreateDocumentUploadResponse> {
    const { topic, level, batch } = entry.target;
    const request: CreateDocumentUploadRequest = {
      ...source,
      ...(level !== null && { level }),
      batch,
    };
    return this.api.create(topic, request).pipe(again());
  }

  /** The bytes of a new upload, with the progress on screen; none for a duplicate. */
  private sendBytes(
    key: number,
    answer: CreateDocumentUploadResponse,
    file: File,
  ): Observable<unknown> {
    const uploadUrl = this.answered(key, answer);
    if (!uploadUrl) return EMPTY;
    this.put(key, { kind: 'sending', percent: 0 });
    return this.api.send(uploadUrl, file).pipe(
      map((event) =>
        this.put(
          key,
          event.kind === 'done'
            ? { kind: 'sent' }
            : {
                kind: 'sending',
                percent: percentOf(event.loaded, event.total),
              },
        ),
      ),
    );
  }

  /**
   * A duplicate is said; a new upload is sent (a link) or has its bytes to send. One that
   * stopped half-way (the tab closed) goes on from where the server has it (ADR 0033).
   */
  private answered(
    key: number,
    answer: CreateDocumentUploadResponse,
  ): string | null {
    if (answer.outcome === 'duplicate') {
      this.put(key, {
        kind: 'duplicate',
        document: answer.document,
        onItsWay: answer.document === null && answer.upload !== null,
      });
      return null;
    }
    if (answer.upload.uploadUrl) return answer.upload.uploadUrl;
    this.put(key, { kind: 'sent' });
    return null;
  }
}
