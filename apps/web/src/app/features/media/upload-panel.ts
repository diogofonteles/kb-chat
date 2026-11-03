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
  type AbstractControl,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import type { MediaAuthorship, MediaItem, Topic } from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { AUTHORSHIP_LABELS } from '@core/i18n/facet-labels.js';
import { MediaApi } from '@core/media/media-api.js';
import { openable, treeTitle } from '@core/topics/topic-tree.js';
import { Subscription, concatMap, of, tap, type Observable } from 'rxjs';
import {
  fileProblemOf,
  sentOf,
  titleFromFileName,
  uploadRule,
} from './upload-rules.js';

type Stage = 'choosing' | 'sending' | 'stopped';

/**
 * "Enviar áudio" (screens.md T14, KBC-034): choose a file (button or drop), check the
 * rule before sending, a title, the authorship (no preselection, ADR 0015), then the real
 * progress with "Cancelar envio". A broken connection keeps the fields (MA-26).
 */
@Component({
  selector: 'app-upload-panel',
  imports: [ReactiveFormsModule],
  templateUrl: './upload-panel.html',
  styleUrl: './upload-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:beforeunload)': 'warnBeforeLeaving($event)' },
})
export class UploadPanel implements OnInit {
  private readonly api = inject(MediaApi);
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
  protected readonly authorships: readonly {
    value: MediaAuthorship;
    label: string;
  }[] = [
    { value: 'mestre-laercio', label: AUTHORSHIP_LABELS['mestre-laercio'] },
    { value: 'outros-autores', label: AUTHORSHIP_LABELS['outros-autores'] },
  ];
  protected readonly form = new FormGroup({
    title: new FormControl('', {
      nonNullable: true,
      validators: [notBlank, Validators.maxLength(200)],
    }),
    topic: new FormControl('', {
      nonNullable: true,
      validators: Validators.required,
    }),
    authorship: new FormControl<MediaAuthorship | null>(
      null,
      Validators.required,
    ),
  });
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
    inject(DestroyRef).onDestroy(() => this.abandon());
  }

  ngOnInit(): void {
    this.form.controls.topic.setValue(this.topic());
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
    if (!file || !draft || this.fileProblem() || this.form.invalid) return;
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
  }

  private draftOf(file: File): Draft | null {
    const { title, topic, authorship } = this.form.getRawValue();
    return authorship ? { file, title: title.trim(), topic, authorship } : null;
  }

  /**
   * The item for this draft: the one created before when the person only retries; a new
   * one (the old removed) when they changed the file, the title, the collection or authorship.
   */
  private itemFor(draft: Draft): Observable<MediaItem> {
    if (this.created && sameDraft(this.created.draft, draft))
      return of(this.created.item);
    this.discardCreated();
    const { file, title, topic, authorship } = draft;
    return this.api
      .create(topic, {
        title,
        authorship,
        fileName: file.name,
        bytes: file.size,
      })
      .pipe(tap((item) => (this.created = { item, draft })));
  }

  private finish(item: MediaItem): void {
    this.sending = null;
    this.created = null;
    this.stage.set('choosing');
    this.uploaded.emit(item);
    this.dialog().nativeElement.close();
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
        : code === 'VALIDATION_FAILED'
          ? $localize`:@@media.upload.refused:Envie um áudio de até 500 MB (mp3, m4a, wav, flac, ogg ou opus).`
          : errorMessage(code),
    );
  }
}

/** A title is required, and spaces alone are not one (the API trims it too). */
const notBlank = (control: AbstractControl<string>) =>
  control.value.trim() ? null : { required: true };

/** What an item was created for. */
interface Draft {
  readonly file: File;
  readonly title: string;
  readonly topic: string;
  readonly authorship: MediaAuthorship;
}

const sameDraft = (a: Draft, b: Draft): boolean =>
  a.file === b.file &&
  a.title === b.title &&
  a.topic === b.topic &&
  a.authorship === b.authorship;
