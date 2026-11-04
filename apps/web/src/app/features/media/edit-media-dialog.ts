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
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import type { MediaItem, Topic, UpdateMediaRequest } from '@kb-chat/contracts';
import {
  errorMessage,
  refusedFieldOf,
  toUiErrorCode,
} from '@core/api/api-error.js';
import { AuthorsApi } from '@core/media/authors-api.js';
import { MediaApi } from '@core/media/media-api.js';
import { MediaEngine } from '@core/media/media-engine.js';
import { openable, treeTitle } from '@core/topics/topic-tree.js';
import {
  catchError,
  concatMap,
  map,
  of,
  throwError,
  type Observable,
} from 'rxjs';
import { AuthorCombobox } from './author-combobox.js';
import {
  AuthorRefused,
  authorFailureOf,
  isInvalidAuthorName,
} from './author-suggestions.js';
import { editDetailsLabel } from './edit-labels.js';
import { notBlank } from './upload-rules.js';

/** An item as it was and as the server left it. */
export interface MediaEdited {
  readonly before: MediaItem;
  readonly after: MediaItem;
}

/** What the person left in the fields. */
interface Draft {
  readonly title: string;
  readonly topic: string;
  /** The author's name; blank is "Outros autores". */
  readonly author: string;
}

/**
 * "Editar informações" (KBC-050, screens.md T14): the title, the collection and the author,
 * filled in. A name is registered in the collection first, as on sending; a move always
 * says who the author is there. Only what changed is sent, and a failure keeps what was
 * typed (FR-4). Whoever opens it closes it when `closed` arrives.
 */
@Component({
  selector: 'app-edit-media-dialog',
  imports: [ReactiveFormsModule, AuthorCombobox],
  templateUrl: './edit-media-dialog.html',
  styleUrls: ['./upload-panel.css', './edit-media-dialog.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EditMediaDialog implements OnInit {
  private readonly api = inject(MediaApi);
  private readonly authorsApi = inject(AuthorsApi);
  private readonly engine = inject(MediaEngine);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly titleInput =
    viewChild.required<ElementRef<HTMLInputElement>>('titleInput');

  readonly item = input.required<MediaItem>();
  /** The collections the person sees (AC-4: no other is offered). */
  readonly topics = input.required<readonly Topic[]>();
  readonly saved = output<MediaEdited>();
  readonly closed = output();

  protected readonly heading = editDetailsLabel();
  protected readonly choices = computed(() => openable(this.topics()));
  protected readonly treeTitle = treeTitle;
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
  /** The "Acervo" field as a signal: the author suggestions and the note follow it. */
  protected readonly chosenTopic = signal('');
  protected readonly moving = computed(
    () => this.chosenTopic() !== this.item().topic,
  );
  protected readonly submitted = signal(false);
  protected readonly saving = signal(false);
  protected readonly failure = signal('');

  constructor() {
    afterNextRender(() => {
      this.dialog().nativeElement.showModal();
      this.titleInput().nativeElement.focus();
    });
  }

  ngOnInit(): void {
    const { title, topic, author } = this.item();
    this.form.setValue({ title, topic });
    this.chosenTopic.set(topic);
    this.authorName.set(author?.name ?? '');
  }

  protected topicChosen(): void {
    this.chosenTopic.set(this.form.controls.topic.value);
  }

  protected save(): void {
    this.submitted.set(true);
    // A name the API would refuse is said under the "Autor" field and never sent.
    const badAuthor = isInvalidAuthorName(this.authorName());
    if (this.form.invalid || badAuthor || this.saving()) return;
    this.saving.set(true);
    this.failure.set('');
    const draft = this.draft();
    this.authorFor(draft)
      .pipe(
        concatMap((author) =>
          this.api.update(this.item().id, this.changesOf(draft, author)),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (item) => this.finish(item),
        error: (err: unknown) => this.stop(err),
      });
  }

  protected close(): void {
    this.dialog().nativeElement.close();
  }

  /** Escape waits for an answer on its way: the page must hear how it ended. */
  protected holdWhileSaving(event: Event): void {
    if (this.saving()) event.preventDefault();
  }

  private draft(): Draft {
    const { title, topic } = this.form.getRawValue();
    return { title: title.trim(), topic, author: this.authorName().trim() };
  }

  /** The author's id, when it has to be said: a new name, or any move (its list may differ). */
  private authorFor(draft: Draft): Observable<string | null | undefined> {
    const item = this.item();
    const sameName = draft.author === (item.author?.name ?? '');
    if (sameName && draft.topic === item.topic) return of(undefined);
    if (!draft.author) return of(null);
    return this.authorsApi.create(draft.topic, draft.author).pipe(
      map(({ slug }) => slug),
      catchError((err: unknown) => throwError(() => authorFailureOf(err))),
    );
  }

  private changesOf(
    draft: Draft,
    author: string | null | undefined,
  ): UpdateMediaRequest {
    const { title, topic } = this.item();
    return {
      ...(draft.title === title ? {} : { title: draft.title }),
      ...(draft.topic === topic ? {} : { topic: draft.topic }),
      ...(author === undefined ? {} : { author }),
    };
  }

  private finish(item: MediaItem): void {
    this.saving.set(false);
    this.engine.retitle(item.id, item.title);
    const before = this.item();
    // Closed first: the browser gives the focus back, and the page may then move it.
    this.close();
    this.saved.emit({ before, after: item });
  }

  private stop(err: unknown): void {
    this.saving.set(false);
    this.failure.set(failureTextOf(err));
  }
}

function failureTextOf(err: unknown): string {
  if (err instanceof AuthorRefused || refusedFieldOf(err) === 'author')
    return $localize`:@@media.upload.authorRefused:O nome do autor não foi aceito: use uma linha, até 60 caracteres, sem aspas nem « ».`;
  const offline =
    err instanceof HttpErrorResponse && (err.status === 0 || err.status >= 502);
  if (offline)
    return $localize`:@@media.edit.offline:Não consegui salvar: verifique a conexão e tente de novo.`;
  const code = toUiErrorCode(err);
  return code === 'VALIDATION_FAILED'
    ? $localize`:@@media.edit.refused:Não consegui salvar: revise os campos e tente de novo.`
    : errorMessage(code);
}
