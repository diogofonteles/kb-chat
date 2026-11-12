import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  type OnInit,
  afterNextRender,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
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
  filter,
  map,
  of,
  throwError,
  type Observable,
} from 'rxjs';
import { AuthorCombobox } from './author-combobox.js';
import { levelChoicesOf } from './level-choices.js';
import { LevelField } from './level-field.js';
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
  /** The level chosen; null where the collection has none. */
  readonly level: string | null;
}

/**
 * "Editar informações" (KBC-050, screens.md T14): the title, the collection and the author,
 * filled in. A name is registered in the collection first, as on sending; a move always
 * says who the author is there. Only what changed is sent, and a failure keeps what was
 * typed (FR-4). Whoever opens it closes it when `closed` arrives.
 */
@Component({
  selector: 'app-edit-media-dialog',
  imports: [ReactiveFormsModule, AuthorCombobox, LevelField],
  templateUrl: './edit-media-dialog.html',
  styleUrls: ['./upload-panel.css', './edit-media-dialog.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown.escape)': 'escape($event)' },
})
export class EditMediaDialog implements OnInit {
  private readonly api = inject(MediaApi);
  private readonly authorsApi = inject(AuthorsApi);
  private readonly engine = inject(MediaEngine);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly levelField = viewChild(LevelField);
  private readonly injector = inject(Injector);
  private readonly titleInput =
    viewChild.required<ElementRef<HTMLInputElement>>('titleInput');
  private readonly raiseCancel =
    viewChild<ElementRef<HTMLButtonElement>>('raiseCancel');

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
  /** The "Nível" of where the audio ends up (KBC-105 BR-3, BR-4). */
  protected readonly levels = levelChoicesOf(
    () => this.chosenTopic(),
    (slug) => this.rootOf(slug),
  );
  /** It goes to another top-level collection: its scale, if any, is another one. */
  private readonly movesScale = computed(
    () => this.rootOf(this.chosenTopic()) !== this.rootOf(this.item().topic),
  );
  /** The audio's level while it stays under its scale; empty, to be chosen, when it leaves. */
  private readonly chosenRoot = computed(() => this.rootOf(this.chosenTopic()));
  protected readonly level = linkedSignal<string, string | null>({
    // A computed source: a move within the same scale keeps what was chosen.
    source: this.chosenRoot,
    computation: () =>
      this.movesScale() ? null : (this.item().level?.id ?? null),
  });
  protected readonly levelLabel = computed(() => {
    if (!this.movesScale()) return $localize`:@@media.level.label:Nível`;
    const root = this.rootOf(this.chosenTopic());
    const title = this.topics().find((one) => one.slug === root)?.title ?? root;
    return $localize`:@@media.level.labelIn:Nível em ${title}:collection:`;
  });
  /** "Salvar" pressed while the levels were on their way: it goes when they come. */
  protected readonly waitingForLevels = signal(false);
  private readonly levelMissing = computed(
    () => this.levels.levels().length > 0 && this.level() === null,
  );
  /**
   * KBC-106 BR-1: the tracks with a level of their own that the new level lifts, said before
   * anything goes (the scale's order is the levels offered, lowest first).
   */
  protected readonly tracksRaised = computed(() => {
    const level = this.level();
    if (this.movesScale() || level === null) return 0;
    const order = this.levels.levels().map((one) => one.id);
    const target = order.indexOf(level);
    return (this.item().ownTrackLevels ?? []).filter((own) => {
      const at = order.indexOf(own);
      return at >= 0 && at < target;
    }).length;
  });
  /** The level whose lift was confirmed; another level asks again. */
  private readonly raiseConfirmedFor = signal<string | null>(null);
  protected readonly confirmingRaise = signal(false);
  protected readonly raiseText = computed(() => {
    const count = this.tracksRaised();
    const code =
      this.levels.levels().find((one) => one.id === this.level())?.code ?? '';
    return count === 1
      ? $localize`:@@media.level.raiseOne:1 faixa com nível próprio sobe para ${code}:level:.`
      : $localize`:@@media.level.raiseMany:${count}:count: faixas com nível próprio sobem para ${code}:level:.`;
  });
  protected readonly submitted = signal(false);
  protected readonly levelInvalid = computed(
    () => this.submitted() && this.levelMissing(),
  );
  protected readonly saving = signal(false);
  protected readonly failure = signal('');

  constructor() {
    // A "Salvar" held for the levels goes once they are known (or could not be had).
    toObservable(this.levels.loading)
      .pipe(
        filter((loading) => !loading && this.waitingForLevels()),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.save());
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
    // The waiting button keeps its focus (aria-disabled): a press on it does nothing.
    if (this.waitingForLevels() && this.levels.loading()) return;
    // Every way out of here leaves no wait behind (review round 2: a stuck button).
    this.waitingForLevels.set(false);
    this.submitted.set(true);
    // A name the API would refuse is said under the "Autor" field and never sent.
    const badAuthor = isInvalidAuthorName(this.authorName());
    if (this.form.invalid || badAuthor || this.saving()) return;
    this.waitingForLevels.set(this.levels.loading());
    if (this.waitingForLevels() || this.levelsUnknown()) return;
    // With a scale, nothing goes without a level (BR-1).
    if (this.levelMissing()) return;
    if (this.asksToRaise()) return;
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

  /**
   * KBC-106 BR-1: tracks of their own the new level lifts are said first, the focus on the
   * safe answer (MA-27); true while that waits for an answer.
   */
  private asksToRaise(): boolean {
    const asks =
      this.tracksRaised() > 0 && this.raiseConfirmedFor() !== this.level();
    this.confirmingRaise.set(asks);
    if (asks)
      afterNextRender(() => this.raiseCancel()?.nativeElement.focus(), {
        injector: this.injector,
      });
    return asks;
  }

  /** "Salvar e subir as faixas": the tracks go up with the recording (KBC-106 BR-1). */
  protected confirmRaise(): void {
    this.raiseConfirmedFor.set(this.level());
    this.save();
  }

  /** "Escolher outro nível": back to the field, nothing saved (review m5). */
  protected cancelRaise(): void {
    this.confirmingRaise.set(false);
    afterNextRender(() => this.levelField()?.focusChoice(), {
      injector: this.injector,
    });
  }

  protected close(): void {
    this.dialog().nativeElement.close();
  }

  /** The browser's own Escape does not reach the dialog from a text field in WebKit on Linux. */
  protected escape(event: Event): void {
    event.preventDefault();
    if (!this.saving()) this.close();
  }

  /** Escape waits for an answer on its way: the page must hear how it ended. */
  protected holdWhileSaving(event: Event): void {
    if (this.saving()) event.preventDefault();
  }

  private draft(): Draft {
    const { title, topic } = this.form.getRawValue();
    return {
      title: title.trim(),
      topic,
      author: this.authorName().trim(),
      level: this.level(),
    };
  }

  /**
   * The levels could not be had where a scale may be: nothing goes, and the focus is on the
   * one way out, "Carregar níveis de novo" (review round 2).
   */
  private levelsUnknown(): boolean {
    if (!this.levels.failedWhereLevelsMayBe(this.chosenRoot())) return false;
    // The field may be drawn only now (a send held for the levels that then failed).
    const field = this.levelField();
    if (field) field.focusRetry();
    else
      afterNextRender(() => this.levelField()?.focusRetry(), {
        injector: this.injector,
      });
    return true;
  }

  /** The top-level collection whose scale a collection uses (ADR 0036 §1). */
  private rootOf(slug: string): string {
    return this.topics().find((one) => one.slug === slug)?.parent ?? slug;
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
    const { title, topic, level } = this.item();
    // A level is said when it changed, and always on the way to another scale (BR-4).
    const asked =
      this.movesScale() || draft.level !== level?.id ? draft.level : null;
    return {
      ...(draft.title === title ? {} : { title: draft.title }),
      ...(draft.topic === topic ? {} : { topic: draft.topic }),
      ...(author === undefined ? {} : { author }),
      ...(asked === null ? {} : { level: asked }),
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
