import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
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
import type { MediaAuthorship, MediaItem } from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { AUTHORSHIP_LABELS } from '@core/i18n/facet-labels.js';
import { MediaApi } from '@core/media/media-api.js';
import { Subscription, concatMap, map, of, type Observable } from 'rxjs';
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
export class UploadPanel {
  private readonly api = inject(MediaApi);
  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly fileInput =
    viewChild.required<ElementRef<HTMLInputElement>>('fileInput');

  readonly topic = input.required<string>();
  readonly topicTitle = input.required<string>();
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
      validators: [Validators.required, Validators.maxLength(200)],
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
  /** The item created on the server: a retry sends the file to it again. */
  private created: MediaItem | null = null;
  private sending: Subscription | null = null;

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
    inject(DestroyRef).onDestroy(() => this.sending?.unsubscribe());
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
    if (!file || this.fileProblem() || this.form.invalid) return;
    this.stage.set('sending');
    this.failure.set('');
    this.sending = this.createOnce()
      .pipe(concatMap((item) => this.api.upload(item.id, file)))
      .subscribe({
        next: (event) =>
          event.kind === 'progress'
            ? this.progress.set({ loaded: event.loaded, total: event.total })
            : this.finish(event.item),
        error: (err: unknown) => this.stop(err),
      });
  }

  /** Stops sending; the half-sent item is removed so it does not linger as "Enviando…". */
  protected cancelUpload(): void {
    this.sending?.unsubscribe();
    this.sending = null;
    const created = this.created;
    this.created = null;
    this.stage.set('choosing');
    this.progress.set({ loaded: 0, total: 0 });
    if (created)
      this.api.remove(created.id).subscribe({ error: () => undefined });
  }

  protected close(): void {
    if (this.stage() === 'sending') this.cancelUpload();
    this.dialog().nativeElement.close();
  }

  protected dialogClosed(): void {
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
    if (!title.value) title.setValue(titleFromFileName(file.name));
  }

  /** The item is created once; a retry after a broken connection reuses it. */
  private createOnce(): Observable<MediaItem> {
    if (this.created) return of(this.created);
    const file = this.file();
    const { title, authorship } = this.form.getRawValue();
    if (!file || !authorship) throw new Error('send() checked the form');
    return this.api
      .create(this.topic(), {
        title,
        authorship,
        fileName: file.name,
        bytes: file.size,
      })
      .pipe(map((item) => (this.created = item)));
  }

  private finish(item: MediaItem): void {
    this.sending = null;
    this.created = null;
    this.stage.set('choosing');
    this.uploaded.emit(item);
    this.dialog().nativeElement.close();
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
          ? $localize`:@@media.upload.refused:O servidor recusou este arquivo. Confira se é um áudio de até 500 MB.`
          : errorMessage(code),
    );
  }
}
