import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type {
  CreateDocumentUploadRequest,
  CreateDocumentUploadResponse,
  DocumentBatchRequest,
  UploadedDocumentRef,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { DocumentUploadsApi } from '@core/documents/document-uploads-api.js';
import { hashFile } from '@features/media/file-hash.js';
import {
  EMPTY,
  Subject,
  catchError,
  concatMap,
  defer,
  map,
  retry,
  throwError,
  timer,
  type Observable,
} from 'rxjs';

export type ContentSource =
  | { readonly kind: 'file'; readonly file: File }
  | { readonly kind: 'url'; readonly url: string };

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

/** The API's per-minute limit: the item waits and goes again, the person does nothing. */
const RATE_LIMIT_WAIT_MS = 15_000;
const RATE_LIMIT_TRIES = 8;

const ACTIVE = new Set<SendPhase['kind']>(['waiting', 'hashing', 'sending']);

const nameOf = (source: ContentSource): string =>
  source.kind === 'file' ? source.file.name : source.url;

/**
 * Sends what the person included (KBC-184), one item after the other: a file is hashed in the
 * browser, announced and sent by tus (ADR 0033); a link is announced. What is already in the
 * collection says so. An item that fails never stops the next ones.
 */
@Injectable()
export class ContentSender {
  private readonly api = inject(DocumentUploadsApi);
  private readonly line = new Subject<number>();
  private readonly entries = signal<readonly ContentSend[]>([]);
  private lastKey = 0;

  readonly sends = this.entries.asReadonly();
  /** Something is still on its way out of this browser: leaving would stop it. */
  readonly busy = computed(() =>
    this.entries().some((one) => ACTIVE.has(one.phase.kind)),
  );
  /** Items the API has: the list of what is being processed reads again on each. */
  readonly sentCount = computed(
    () => this.entries().filter((one) => one.phase.kind === 'sent').length,
  );

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
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe();
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
      return entry.source.kind === 'file'
        ? this.sendFile(entry, entry.source.file)
        : this.sendLink(entry, entry.source.url);
    });
  }

  private sendLink(entry: ContentSend, url: string): Observable<unknown> {
    this.put(entry.key, { kind: 'sending', percent: 0 });
    return this.create(entry, { kind: 'url', url }).pipe(
      map((answer) => this.answered(entry.key, answer)),
    );
  }

  private sendFile(entry: ContentSend, file: File): Observable<unknown> {
    this.put(entry.key, { kind: 'hashing', percent: 0 });
    return hashFile(file).pipe(
      concatMap((event) => {
        if (event.kind === 'progress') {
          this.put(entry.key, { kind: 'hashing', percent: event.percent });
          return EMPTY;
        }
        return this.create(entry, {
          ...{ kind: 'file', name: file.name, bytes: file.size },
          sha256: event.sha256,
        });
      }),
      concatMap((answer) => this.sendBytes(entry.key, answer, file)),
    );
  }

  private create(
    entry: ContentSend,
    source:
      | { kind: 'url'; url: string }
      | { kind: 'file'; name: string; bytes: number; sha256: string },
  ): Observable<CreateDocumentUploadResponse> {
    const { topic, level, batch } = entry.target;
    const request: CreateDocumentUploadRequest = {
      ...source,
      ...(level !== null && { level }),
      batch,
    };
    return this.api.create(topic, request).pipe(
      retry({
        count: RATE_LIMIT_TRIES,
        delay: (err: unknown) =>
          toUiErrorCode(err) === 'RATE_LIMITED'
            ? timer(RATE_LIMIT_WAIT_MS)
            : throwError(() => err),
      }),
    );
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
                percent: Math.floor(
                  (event.loaded / Math.max(event.total, 1)) * 100,
                ),
              },
        ),
      ),
    );
  }

  /** A duplicate is said; a new upload is sent (a link) or has its bytes to send. */
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
