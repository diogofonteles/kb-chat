import { HttpErrorResponse } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
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
import { Router } from '@angular/router';
import type {
  MediaItem,
  PreparationPlanRequest,
  Topic,
} from '@kb-chat/contracts';
import {
  errorMessage,
  refusedFieldOf,
  toUiErrorCode,
} from '@core/api/api-error.js';
import { SessionStore } from '@core/auth/session-store.js';
import { AuthorsApi } from '@core/media/authors-api.js';
import { MediaApi } from '@core/media/media-api.js';
import { preparationPagePath } from '@core/media/preparation-api.js';
import { openable, treeTitle } from '@core/topics/topic-tree.js';
import {
  Subscription,
  catchError,
  concatMap,
  map,
  of,
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
import { AUDIO_LENGTH_READER } from './audio-length.js';
import { PlanForm } from './preparation/plan-form.js';
import { PreparationOptions } from './preparation/preparation-options.js';
import { PreparationSteps } from './preparation/preparation-steps.js';
import {
  fileProblemOf,
  notBlank,
  sentOf,
  titleFromFileName,
  uploadRule,
} from './upload-rules.js';

type Stage = 'choosing' | 'sending' | 'stopped';

/**
 * "Enviar áudio" (screens.md T14, KBC-034): choose a file (button or drop), check the
 * rule before sending, a title, the author (KBC-049: one of the collection's or a new one,
 * blank for "Outros autores"), then the real progress with "Cancelar envio". A broken
 * connection keeps the fields (MA-26).
 */
@Component({
  selector: 'app-upload-panel',
  imports: [
    ReactiveFormsModule,
    AuthorCombobox,
    PreparationOptions,
    PreparationSteps,
  ],
  providers: [PlanForm],
  templateUrl: './upload-panel.html',
  styleUrl: './upload-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:beforeunload)': 'warnBeforeLeaving($event)' },
})
export class UploadPanel implements OnInit {
  private readonly api = inject(MediaApi);
  private readonly authorsApi = inject(AuthorsApi);
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);
  private readonly readLength = inject(AUDIO_LENGTH_READER);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly plan = inject(PlanForm);
  /** Who may only send sees no flow of four steps: the upload is all there is (AC-15). */
  protected readonly showSteps = computed(() => this.session.can('media-edit'));
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
  protected readonly form = new FormGroup({
    title: new FormControl('', {
      nonNullable: true,
      validators: [notBlank, Validators.maxLength(200)],
    }),
    topic: new FormControl('', {
      nonNullable: true,
      validators: Validators.required,
    }),
  });
  /** The "Acervo" field as a signal: the author suggestions follow it. */
  protected readonly chosenTopic = signal('');
  protected readonly file = signal<File | null>(null);
  protected readonly fileProblem = signal<string | null>(null);
  protected readonly stage = signal<Stage>('choosing');
  protected readonly progress = signal({ loaded: 0, total: 0 });
  protected readonly failure = signal('');
  protected readonly submitted = signal(false);
  protected readonly dragging = signal(false);
  protected readonly percent = computed(() => {
    const { loaded, total } = this.progress();
    return total > 0 ? Math.floor((loaded / total) * 100) : 0;
  });
  protected readonly sentText = computed(() =>
    sentOf(
      this.progress().loaded,
      this.progress().total || (this.file()?.size ?? 0),
    ),
  );
  /** The item created on the server and what it was created for: a retry reuses it. */
  private created: { readonly item: MediaItem; readonly draft: Draft } | null =
    null;
  private sending: Subscription | null = null;
  /** The title the panel suggested: replaced by the next file's until the person edits it. */
  private suggestedTitle = '';

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
    // Leaving the page or the route mid-upload: stop, and remove the half-created item.
    this.destroyRef.onDestroy(() => this.abandon());
  }

  ngOnInit(): void {
    this.form.controls.topic.setValue(this.topic());
    this.chosenTopic.set(this.topic());
    this.plan.aim({});
  }

  protected topicChosen(): void {
    this.chosenTopic.set(this.form.controls.topic.value);
  }

  protected chooseFile(): void {
    this.fileInput().nativeElement.click();
  }

  protected fileChosen(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLInputElement)
      this.takeFile(target.files?.item(0) ?? null);
  }

  protected dragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(true);
  }

  protected dropped(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    this.takeFile(event.dataTransfer?.files.item(0) ?? null);
  }

  protected send(): void {
    this.submitted.set(true);
    const file = this.file();
    if (!file)
      this.fileProblem.set(
        $localize`:@@media.upload.noFile:Escolha um arquivo de áudio.`,
      );
    const draft = file ? this.draftOf(file) : null;
    // A name the API would refuse is said under the "Autor" field and never sent.
    const badAuthor = isInvalidAuthorName(this.authorName());
    if (!file || !draft || this.fileProblem() || this.form.invalid || badAuthor)
      return;
    this.stage.set('sending');
    this.failure.set('');
    this.sending = this.itemFor(draft)
      .pipe(concatMap((item) => this.api.upload(item.id, file)))
      .subscribe({
        next: (event) =>
          event.kind === 'progress'
            ? this.progress.set({ loaded: event.loaded, total: event.total })
            : this.finish(event.item),
        error: (err: unknown) => this.stop(err),
      });
  }

  /** "Cancelar envio": stops sending and removes the half-created item. */
  protected cancelUpload(): void {
    this.abandon();
    this.stage.set('choosing');
    this.progress.set({ loaded: 0, total: 0 });
  }

  protected close(): void {
    this.dialog().nativeElement.close();
  }

  /** Every way out (Cancelar, Escape, after a failure) cleans up before telling the list. */
  protected dialogClosed(): void {
    this.abandon();
    this.closed.emit();
  }

  protected warnBeforeLeaving(event: BeforeUnloadEvent): void {
    if (this.stage() === 'sending') event.preventDefault();
  }

  private takeFile(file: File | null): void {
    if (!file) return;
    this.file.set(file);
    this.fileProblem.set(fileProblemOf(file));
    const title = this.form.controls.title;
    if (!title.value || title.value === this.suggestedTitle) {
      this.suggestedTitle = titleFromFileName(file.name);
      title.setValue(this.suggestedTitle);
    }
    this.measure(file);
  }

  /** The estimates go by the file's length, read here before anything is sent (BR-4). */
  private measure(file: File): void {
    this.readLength(file)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((durationMs) => {
        if (this.file() !== file) return;
        if (durationMs === null) this.plan.lengthUnknown();
        else this.plan.aim({ durationMs });
      });
  }

  private draftOf(file: File): Draft {
    const { title, topic } = this.form.getRawValue();
    return {
      file,
      title: title.trim(),
      topic,
      author: this.authorName().trim(),
      plan: this.plan.plan(),
    };
  }

  /**
   * The item for this draft: the one created before when the person only retries; a new
   * one (the old removed) when they changed the file, the title, the collection or author.
   */
  private itemFor(draft: Draft): Observable<MediaItem> {
    if (this.created && sameDraft(this.created.draft, draft))
      return of(this.created.item);
    this.discardCreated();
    const { file, title, topic, plan } = draft;
    return this.authorOf(draft).pipe(
      concatMap((author) =>
        this.api.create(topic, {
          title,
          author,
          fileName: file.name,
          bytes: file.size,
          plan,
        }),
      ),
      tap((item) => (this.created = { item, draft })),
    );
  }

  /**
   * The author's id: the name is registered in the collection first (a name it already
   * has answers with that author, FR-1); none for a blank field.
   */
  private authorOf({ topic, author }: Draft): Observable<string | null> {
    if (!author) return of(null);
    return this.authorsApi.create(topic, author).pipe(
      map(({ slug }) => slug),
      catchError((err: unknown) => throwError(() => authorFailureOf(err))),
    );
  }

  private finish(item: MediaItem): void {
    this.sending = null;
    this.created = null;
    this.stage.set('choosing');
    this.plan.remember();
    const guided = this.plan.guided();
    this.uploaded.emit(item);
    this.dialog().nativeElement.close();
    // Only "Transcrever" ends here, as it always did (AC-15).
    if (guided) void this.router.navigateByUrl(preparationPagePath(item.id));
  }

  private abandon(): void {
    this.sending?.unsubscribe();
    this.sending = null;
    this.discardCreated();
  }

  /** Not tied to this panel's life: the removal must reach the server after it closes. */
  private discardCreated(): void {
    const created = this.created;
    this.created = null;
    if (created)
      this.api.remove(created.item.id).subscribe({ error: () => undefined });
  }

  private stop(err: unknown): void {
    this.sending = null;
    this.stage.set('stopped');
    const offline =
      err instanceof HttpErrorResponse &&
      (err.status === 0 || err.status >= 502);
    const code = toUiErrorCode(err);
    this.failure.set(
      offline
        ? $localize`:@@media.upload.stopped:O envio parou: verifique a conexão e tente de novo.`
        : err instanceof AuthorRefused || refusedFieldOf(err) === 'author'
          ? $localize`:@@media.upload.authorRefused:O nome do autor não foi aceito: use uma linha, até 60 caracteres, sem aspas nem « ».`
          : code === 'VALIDATION_FAILED'
            ? $localize`:@@media.upload.refused:Envie um áudio de até 500 MB (mp3, m4a, wav, flac, ogg ou opus).`
            : errorMessage(code),
    );
  }
}

/** What an item was created for. */
interface Draft {
  readonly file: File;
  readonly title: string;
  readonly topic: string;
  /** The author's name; blank is none. */
  readonly author: string;
  /** What the person asked for this audio (KBC-072). */
  readonly plan: PreparationPlanRequest;
}

const sameDraft = (a: Draft, b: Draft): boolean =>
  a.file === b.file &&
  a.title === b.title &&
  a.topic === b.topic &&
  a.author === b.author &&
  JSON.stringify(a.plan) === JSON.stringify(b.plan);
