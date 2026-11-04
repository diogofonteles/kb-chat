import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  type OnInit,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import {
  duplicateDetailsSchema,
  quotaDetailsSchema,
  type MediaItem,
  type Topic,
} from '@kb-chat/contracts';
import {
  errorDetailsOf,
  errorMessage,
  refusedFieldOf,
  toUiErrorCode,
} from '@core/api/api-error.js';
import { AuthorsApi } from '@core/media/authors-api.js';
import { MediaApi, type UploadEvent } from '@core/media/media-api.js';
import { openable, treeTitle } from '@core/topics/topic-tree.js';
import {
  EMPTY,
  Subscription,
  catchError,
  concatMap,
  from,
  map,
  mergeMap,
  of,
  shareReplay,
  tap,
  throwError,
  type Observable,
} from 'rxjs';
import {
  AuthorRefused,
  authorFailureOf,
  isInvalidAuthorName,
} from './author-suggestions.js';
import { AuthorCombobox } from './author-combobox.js';
import { UploadEntries, type UploadEntry } from './upload-entries.js';
import { UploadFileRow } from './upload-file-row.js';
import { uploadRule } from './upload-rules.js';

type Stage = 'choosing' | 'sending' | 'stopped';

/** How many files travel at once; the rest wait for a place (KBC-035 AC-8). */
const FILES_AT_ONCE = 3;

/**
 * "Enviar áudio" (screens.md T14, KBC-034, KBC-035): choose files (button or drop), each
 * with its title and its check, the author and collection of them all (KBC-049: one of the
 * collection's or a new one, blank for "Outros autores"), then the progress of each with
 * "Cancelar envio". A network that goes away is waited for, and the upload goes on alone
 * when it returns; any other broken connection keeps everything (MA-26), and sending again
 * goes on from the last byte the server has. Leaving does not lose an upload: choosing the same file
 * within 24 h continues it. Only "Cancelar" removes what was half sent.
 */
@Component({
  selector: 'app-upload-panel',
  imports: [ReactiveFormsModule, AuthorCombobox, UploadFileRow],
  providers: [UploadEntries],
  templateUrl: './upload-panel.html',
  styleUrl: './upload-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:beforeunload)': 'warnBeforeLeaving($event)' },
})
export class UploadPanel implements OnInit {
  private readonly api = inject(MediaApi);
  private readonly authorsApi = inject(AuthorsApi);
  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly fileInput =
    viewChild.required<ElementRef<HTMLInputElement>>('fileInput');

  /** The collection selected in the sidebar: the default of the "Acervo" field. */
  readonly topic = input.required<string>();
  /** The collections the person sees: the upload may go to another one (T14). */
  readonly topics = input.required<readonly Topic[]>();
  /** Where a file can go: every collection the person opens, as a tree. */
  protected readonly choices = computed(() => openable(this.topics()));
  protected readonly treeTitle = treeTitle;
  readonly uploaded = output<MediaItem>();
  readonly closed = output();

  protected readonly rule = uploadRule();
  /** The author's name as typed or chosen; blank is "Outros autores". */
  protected readonly authorName = signal('');
  protected readonly uploads = inject(UploadEntries);
  protected readonly form = new FormGroup({
    topic: new FormControl('', {
      nonNullable: true,
      validators: Validators.required,
    }),
  });
  /** The "Acervo" field as a signal: the author suggestions follow it. */
  protected readonly chosenTopic = signal('');
  /** Said beside the files: none chosen, or none that can go. */
  protected readonly fileProblem = signal<string | null>(null);
  protected readonly stage = signal<Stage>('choosing');
  protected readonly submitted = signal(false);
  protected readonly dragging = signal(false);
  /** The items created on the server and what for, per file: a retry reuses them. */
  private readonly created = new Map<number, Created>();
  /** Files whose item the list was already told about. */
  private readonly reported = new Set<number>();
  /** Each finished file's item, until the list hears of it. */
  private readonly sent = new Map<number, MediaItem>();
  private sending: Subscription | null = null;
  /** A file came back refused while sending: the panel stays so the person sees it. */
  private interrupted = false;

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
    // Leaving the page or the route mid-upload: stop. The same file continues later (FR-2).
    inject(DestroyRef).onDestroy(() => this.halt());
  }

  ngOnInit(): void {
    this.form.controls.topic.setValue(this.topic());
    this.chosenTopic.set(this.topic());
    this.uploads.aim(this.topic());
  }

  protected topicChosen(): void {
    this.chosenTopic.set(this.form.controls.topic.value);
    this.uploads.aim(this.form.controls.topic.value);
  }

  protected chooseFile(): void {
    this.fileInput().nativeElement.click();
  }

  protected fileChosen(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    this.takeFiles(target.files);
    // The same file can be chosen again after being taken off the list.
    target.value = '';
  }

  protected dragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(true);
  }

  protected dropped(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    this.takeFiles(event.dataTransfer?.files ?? null);
  }

  protected send(): void {
    this.submitted.set(true);
    const targets = this.uploads.sendable();
    // A name the API would refuse is said under the "Autor" field and never sent.
    const badAuthor = isInvalidAuthorName(this.authorName());
    this.fileProblem.set(this.nothingToSend(targets));
    if (
      targets.length === 0 ||
      targets.some(({ title }) => !validTitle(title)) ||
      this.form.invalid ||
      badAuthor
    )
      return;
    this.enter('sending');
    this.interrupted = false;
    const author = this.authorOf().pipe(shareReplay(1));
    this.sending = from(targets)
      .pipe(mergeMap((entry) => this.sendOne(entry, author), FILES_AT_ONCE))
      .subscribe({ complete: () => this.settle() });
  }

  /** "Cancelar envio": stops sending and removes what was half sent. */
  protected cancelUpload(): void {
    this.abandon();
    this.reportSent();
    this.enter('choosing');
  }

  /** "Cancelar": the person gives up what was half sent; other exits keep it (FR-2). */
  protected close(): void {
    this.abandon();
    this.dialog().nativeElement.close();
  }

  /** Every way out (Cancelar, Escape, the end) stops before telling the list. */
  protected dialogClosed(): void {
    this.halt();
    this.reportSent();
    this.closed.emit();
  }

  protected warnBeforeLeaving(event: BeforeUnloadEvent): void {
    if (this.stage() === 'sending') event.preventDefault();
  }

  /** The collection is one for all the files: it cannot change once they are going (T14). */
  private enter(stage: Stage): void {
    this.stage.set(stage);
    const { topic } = this.form.controls;
    if (stage === 'sending') topic.disable();
    else topic.enable();
  }

  private takeFiles(files: FileList | null): void {
    this.fileProblem.set(null);
    this.uploads.add(Array.from(files ?? []));
  }

  private nothingToSend(targets: readonly UploadEntry[]): string | null {
    if (targets.length > 0) return null;
    return this.uploads.entries().length === 0
      ? $localize`:@@media.upload.noFile:Escolha um arquivo de áudio.`
      : $localize`:@@media.upload.nothingToSend:Nada a enviar: estes arquivos não podem ser enviados.`;
  }

  private draftOf({ file, title }: UploadEntry): Draft {
    const { topic } = this.form.getRawValue();
    return {
      file,
      title: title.trim(),
      topic,
      author: this.authorName().trim(),
    };
  }

  /** One file, from its item to its last byte; a failure stays on its own line. */
  private sendOne(
    entry: UploadEntry,
    author: Observable<string | null>,
  ): Observable<never> {
    const { key, file } = entry;
    const start = entry.state.kind === 'resume' ? entry.state.offset : 0;
    this.uploads.set(key, {
      kind: 'sending',
      loaded: start,
      total: file.size,
    });
    return this.itemFor(entry, author).pipe(
      concatMap((id) => this.api.upload(id, file)),
      concatMap((event) => {
        this.follow(key, event);
        return EMPTY;
      }),
      catchError((err: unknown) => {
        this.stop(key, err);
        return EMPTY;
      }),
    );
  }

  private follow(key: number, event: UploadEvent): void {
    if (event.kind === 'done') return this.finishOne(key, event.item);
    if (event.kind === 'offline') return this.uploads.markOffline(key);
    const { loaded, total } = event;
    this.uploads.set(key, { kind: 'sending', loaded, total });
  }

  /**
   * The item for this file: the one being resumed, the one created before when the person
   * only retries, or a new one (the old removed) when they changed its details.
   */
  private itemFor(
    entry: UploadEntry,
    author: Observable<string | null>,
  ): Observable<string> {
    const { key, file, title, sha256, durationMs, state } = entry;
    const draft = this.draftOf(entry);
    if (state.kind === 'resume') {
      this.created.set(key, { id: state.mediaId, draft });
      return of(state.mediaId);
    }
    const held = this.created.get(key);
    if (held && sameDraft(held.draft, draft)) return of(held.id);
    return this.removeHeld(key).pipe(
      concatMap(() => author),
      concatMap((authorSlug) =>
        this.api.create(draft.topic, {
          title: title.trim(),
          author: authorSlug,
          fileName: file.name,
          bytes: file.size,
          sha256,
          durationMs,
        }),
      ),
      tap(({ id }) => this.created.set(key, { id, draft })),
      map(({ id }) => id),
    );
  }

  /**
   * The author's id: the name is registered in the collection first (a name it already
   * has answers with that author, FR-1); none for a blank field.
   */
  private authorOf(): Observable<string | null> {
    const author = this.authorName().trim();
    if (!author) return of(null);
    const { topic } = this.form.getRawValue();
    return this.authorsApi.create(topic, author).pipe(
      map(({ slug }) => slug),
      catchError((err: unknown) => throwError(() => authorFailureOf(err))),
    );
  }

  private finishOne(key: number, item: MediaItem): void {
    this.created.delete(key);
    this.sent.set(key, item);
    this.uploads.set(key, { kind: 'done' });
  }

  /** Every file ended: the panel closes, unless one needs the person. */
  private settle(): void {
    this.sending = null;
    const pending = this.interrupted || this.uploads.sendable().length > 0;
    this.reportSent();
    this.enter(pending ? 'stopped' : 'choosing');
    if (!pending) this.dialog().nativeElement.close();
  }

  /** The list learns of each new item once; the last one ends up focused (UP-01). */
  private reportSent(): void {
    for (const [key, item] of this.sent) {
      if (this.reported.has(key)) continue;
      this.reported.add(key);
      this.uploaded.emit(item);
    }
  }

  private halt(): void {
    this.sending?.unsubscribe();
    this.sending = null;
  }

  private abandon(): void {
    this.halt();
    for (const key of [...this.created.keys()]) this.discardCreated(key);
    this.uploads.backToReady();
  }

  /** The old item goes first: while it lives, the API calls the same file repeated. */
  private removeHeld(key: number): Observable<unknown> {
    const held = this.created.get(key);
    this.created.delete(key);
    if (!held) return of(null);
    return this.api.remove(held.id).pipe(catchError(() => of(null)));
  }

  /** Not tied to this panel's life: the removal must reach the server after it closes. */
  private discardCreated(key: number): void {
    const created = this.created.get(key);
    this.created.delete(key);
    if (created)
      this.api.remove(created.id).subscribe({ error: () => undefined });
  }

  /** What stopped this file, on its line. */
  private stop(key: number, err: unknown): void {
    this.interrupted = true;
    const code = toUiErrorCode(err);
    if (code === 'MEDIA_DUPLICATE') return this.refuseRepeated(key, err);
    if (code === 'MEDIA_QUOTA_EXCEEDED') return this.refuseOverQuota(key, err);
    if (err instanceof HttpErrorResponse && err.status === 410) {
      this.created.delete(key);
      return this.uploads.set(key, { kind: 'expired' });
    }
    this.uploads.set(key, { kind: 'stopped', problem: problemOf(err) });
  }

  private refuseRepeated(key: number, err: unknown): void {
    const details = duplicateDetailsSchema.safeParse(errorDetailsOf(err));
    this.uploads.set(
      key,
      details.success
        ? { kind: 'duplicate', media: details.data.media }
        : { kind: 'stopped', problem: problemOf(err) },
    );
  }

  private refuseOverQuota(key: number, err: unknown): void {
    const details = quotaDetailsSchema.safeParse(errorDetailsOf(err));
    this.uploads.set(
      key,
      details.success
        ? { kind: 'over-quota', quotaBytes: details.data.quotaBytes }
        : { kind: 'stopped', problem: problemOf(err) },
    );
  }
}

/** The title as the row's field and the API read it. */
const validTitle = (title: string): boolean =>
  title.trim().length > 0 && title.length <= 200;

function problemOf(err: unknown): string {
  const offline =
    err instanceof HttpErrorResponse && (err.status === 0 || err.status >= 502);
  if (offline)
    return $localize`:@@media.upload.stopped:O envio parou: verifique a conexão e tente de novo.`;
  if (err instanceof AuthorRefused || refusedFieldOf(err) === 'author')
    return $localize`:@@media.upload.authorRefused:O nome do autor não foi aceito: use uma linha, até 60 caracteres, sem aspas nem « ».`;
  if (refusedFieldOf(err) === 'sha256')
    return $localize`:@@media.upload.corrupted:O arquivo chegou diferente do original. Tente de novo: o envio recomeça.`;
  const code = toUiErrorCode(err);
  return code === 'VALIDATION_FAILED'
    ? $localize`:@@media.upload.refused:Envie um áudio de até 4 GB (mp3, m4a, wav, flac, ogg ou opus).`
    : errorMessage(code);
}

/** An item on the server and what it was created for. */
interface Created {
  readonly id: string;
  readonly draft: Draft;
}

/** What an item was created for. */
interface Draft {
  readonly file: File;
  readonly title: string;
  readonly topic: string;
  /** The author's name; blank is none. */
  readonly author: string;
}

const sameDraft = (a: Draft, b: Draft): boolean =>
  a.file === b.file &&
  a.title === b.title &&
  a.topic === b.topic &&
  a.author === b.author;
