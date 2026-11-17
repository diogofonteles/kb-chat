import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import {
  DOCUMENT_UPLOAD_EXTENSIONS,
  DOCUMENT_UPLOAD_MAX_BYTES,
  hasDocumentExtension,
  type CreateDocumentUploadRequest,
  type CreateDocumentUploadResponse,
  type UploadedDocumentRef,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { DocumentUploadsApi } from '@core/documents/document-uploads-api.js';
import { mediaLevelsUrl, parseLevelChoices } from '@core/media/media-api.js';
import { hashFile } from '@features/media/file-hash.js';
import { UiBanner, UiButton, UiDialog, UiIcon, UiProgress } from '@ui/index.js';
import { EMPTY, concatMap, map, type Observable } from 'rxjs';

/** A document opened from "Este documento já está no acervo". */
export interface OpenedDocument {
  readonly topic: string;
  readonly id: string;
  readonly title: string;
}

type Mode = 'file' | 'link';

/** Where a send is; one at a time (PD-05: a union, never two flags). */
type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'hashing'; readonly percent: number }
  | { readonly kind: 'sending'; readonly percent: number }
  | { readonly kind: 'done' }
  | {
      readonly kind: 'duplicate';
      readonly document: UploadedDocumentRef | null;
      readonly onItsWay: boolean;
    }
  | { readonly kind: 'error'; readonly message: string };

const ACCEPT = DOCUMENT_UPLOAD_EXTENSIONS.map((one) => `.${one}`).join(',');
const MAX_MB = Math.round(DOCUMENT_UPLOAD_MAX_BYTES / 1024 ** 2);

/**
 * "Enviar documento ou link" (KBC-149, "+ Criar" of the v2): a PDF, Office file, EPUB,
 * image or a link (YouTube included) into the collection in use. A file is hashed in the
 * browser, announced, then sent by tus (ADR 0033); the API keeps it and the Mac converts
 * it. What is already in the collection is said, with its link (BR-3). A modal on desktop,
 * a tall sheet on a phone (ui-dialog).
 */
@Component({
  selector: 'app-document-upload-dialog',
  imports: [RouterLink, UiBanner, UiButton, UiDialog, UiIcon, UiProgress],
  templateUrl: './document-upload-dialog.html',
  styleUrl: './document-upload-dialog.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DocumentUploadDialog {
  private readonly api = inject(DocumentUploadsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialog = viewChild.required(UiDialog);

  /** The collection in use (where the document goes) and its name. */
  readonly topic = input<string | null>(null);
  readonly topicTitle = input('');
  readonly documentOpened = output<OpenedDocument>();

  protected readonly accept = ACCEPT;
  protected readonly alreadyTitle = $localize`:@@docUpload.already:Este documento já está no acervo`;
  protected readonly onItsWayTitle = $localize`:@@docUpload.onItsWay:Este documento já está a caminho do acervo`;
  protected readonly mode = signal<Mode>('file');
  protected readonly file = signal<File | null>(null);
  protected readonly url = signal('');
  protected readonly level = signal('');
  protected readonly phase = signal<Phase>({ kind: 'idle' });
  /** The levels are read only once the dialog opens (the sidebar always holds it). */
  private readonly opened = signal(false);
  protected readonly fileProblem = signal('');
  /** The levels the person may choose here (the media library's rule, ADR 0036 §5). */
  protected readonly levels = httpResource(
    () => {
      const topic = this.topic();
      return topic && this.opened() ? mediaLevelsUrl(topic) : undefined;
    },
    { parse: parseLevelChoices },
  );
  protected readonly levelChoices = computed(() =>
    this.levels.hasValue() ? this.levels.value().levels : [],
  );
  protected readonly busy = computed(() => {
    const kind = this.phase().kind;
    return kind === 'hashing' || kind === 'sending';
  });
  protected readonly urlProblem = computed(() => {
    const url = this.url().trim();
    if (this.mode() !== 'link' || url === '') return '';
    return isWebLink(url)
      ? ''
      : $localize`:@@docUpload.badLink:Cole um endereço que comece com https:// ou http://.`;
  });
  protected readonly canSend = computed(() => {
    if (this.busy() || this.finished() || !this.topic()) return false;
    if (this.levelChoices().length > 0 && !this.level()) return false;
    return this.mode() === 'file'
      ? this.file() !== null && !this.fileProblem()
      : this.url().trim() !== '' && !this.urlProblem();
  });
  protected readonly duplicate = computed(() => {
    const phase = this.phase();
    return phase.kind === 'duplicate' ? phase : null;
  });
  protected readonly errorText = computed(() => {
    const phase = this.phase();
    return phase.kind === 'error' ? phase.message : '';
  });
  protected readonly finished = computed(() => {
    const kind = this.phase().kind;
    return kind === 'done' || kind === 'duplicate';
  });
  protected readonly progress = computed(() => {
    const phase = this.phase();
    return phase.kind === 'hashing' || phase.kind === 'sending'
      ? phase.percent / 100
      : 0;
  });

  open(): void {
    this.reset();
    this.opened.set(true);
    this.dialog().open();
  }

  protected reset(): void {
    this.mode.set('file');
    this.file.set(null);
    this.url.set('');
    this.level.set('');
    this.fileProblem.set('');
    this.phase.set({ kind: 'idle' });
  }

  protected choose(mode: Mode): void {
    if (this.busy()) return;
    this.mode.set(mode);
    this.phase.set({ kind: 'idle' });
  }

  protected fileChosen(event: Event): void {
    const target = event.target as HTMLInputElement;
    const chosen = target.files?.[0] ?? null;
    this.phase.set({ kind: 'idle' });
    this.file.set(chosen);
    this.fileProblem.set(chosen ? problemOf(chosen) : '');
  }

  protected openDocument(document: UploadedDocumentRef): void {
    const topic = this.topic();
    if (!topic) return;
    this.dialog().close();
    this.documentOpened.emit({ topic, ...document });
  }

  protected close(): void {
    this.dialog().close();
  }

  /** One send at a time: a second press while one runs does nothing (PD-02). */
  protected send(): void {
    const topic = this.topic();
    if (!topic || !this.canSend()) return;
    const level = this.level() ? { level: this.level() } : {};
    const file = this.file();
    const flow =
      this.mode() === 'file' && file
        ? this.sendFile(topic, file, level)
        : this.sendLink(topic, this.url().trim(), level);
    this.phase.set(
      this.mode() === 'file'
        ? { kind: 'hashing', percent: 0 }
        : { kind: 'sending', percent: 0 },
    );
    flow.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      error: (err: unknown) =>
        this.phase.set({
          kind: 'error',
          message: errorMessage(toUiErrorCode(err)),
        }),
    });
  }

  private sendLink(
    topic: string,
    url: string,
    level: { level?: string },
  ): Observable<unknown> {
    return this.api
      .create(topic, { kind: 'url', url, ...level })
      .pipe(map((answer) => this.answered(answer)));
  }

  private sendFile(
    topic: string,
    file: File,
    level: { level?: string },
  ): Observable<unknown> {
    return hashFile(file).pipe(
      concatMap((event) => {
        if (event.kind === 'progress') {
          this.phase.set({ kind: 'hashing', percent: event.percent });
          return EMPTY;
        }
        const request: CreateDocumentUploadRequest = {
          ...{ kind: 'file', name: file.name, bytes: file.size },
          ...{ sha256: event.sha256, ...level },
        };
        return this.api.create(topic, request);
      }),
      concatMap((answer) => this.sendBytes(answer, file)),
    );
  }

  /** The bytes of a new upload, with the progress on screen; none for a duplicate. */
  private sendBytes(
    answer: CreateDocumentUploadResponse,
    file: File,
  ): Observable<unknown> {
    const uploadUrl = this.answered(answer);
    if (!uploadUrl) return EMPTY;
    this.phase.set({ kind: 'sending', percent: 0 });
    return this.api.send(uploadUrl, file).pipe(
      map((event) => {
        if (event.kind === 'done') this.phase.set({ kind: 'done' });
        else
          this.phase.set({
            kind: 'sending',
            percent: Math.floor(
              (event.loaded / Math.max(event.total, 1)) * 100,
            ),
          });
      }),
    );
  }

  /** A duplicate is said here; a new upload is done (a link) or has its bytes to send. */
  private answered(answer: CreateDocumentUploadResponse): string | null {
    if (answer.outcome === 'duplicate') {
      this.phase.set({
        kind: 'duplicate',
        document: answer.document,
        onItsWay: answer.document === null && answer.upload !== null,
      });
      return null;
    }
    if (answer.upload.uploadUrl) return answer.upload.uploadUrl;
    this.phase.set({ kind: 'done' });
    return null;
  }
}

function isWebLink(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function problemOf(file: File): string {
  if (!hasDocumentExtension(file.name))
    return $localize`:@@docUpload.badType:Este tipo de arquivo não é um documento. Áudio e vídeo vão pela Biblioteca.`;
  if (file.size > DOCUMENT_UPLOAD_MAX_BYTES)
    return $localize`:@@docUpload.tooBig:O arquivo passa de ${MAX_MB}:max: MB.`;
  if (file.size === 0)
    return $localize`:@@docUpload.empty:O arquivo está vazio.`;
  return '';
}
