import { ProcessingQueueStore } from './queue/processing-queue-store.js';
import { HttpErrorResponse } from '@angular/common/http';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  LOCALE_ID,
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
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { Router } from '@angular/router';
import {
  PLAN_ESTIMATE_TOLERANCE,
  duplicateDetailsSchema,
  duplicateHiddenDetailsSchema,
  quotaDetailsSchema,
  type MediaItem,
  type PreparationPlanRequest,
  type Topic,
} from '@kb-chat/contracts';
import {
  errorDetailsOf,
  errorMessage,
  refusedFieldOf,
  toUiErrorCode,
} from '@core/api/api-error.js';
import { SessionStore } from '@core/auth/session-store.js';
import { AuthorsApi } from '@core/media/authors-api.js';
import { MediaApi, type UploadEvent } from '@core/media/media-api.js';
import {
  PreparationApi,
  QUEUE_PAGE_PATH,
  preparationPagePath,
} from '@core/media/preparation-api.js';
import { openable, treeTitle } from '@core/topics/topic-tree.js';
import {
  EMPTY,
  Subscription,
  catchError,
  concatMap,
  filter,
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
import { levelChoicesOf } from './level-choices.js';
import { LevelField } from './level-field.js';
import { planShare, sameChoices } from './preparation/plan-choices.js';
import { PlanForm } from './preparation/plan-form.js';
import { usdUpText } from './preparation/preparation-labels.js';
import { PreparationOptions } from './preparation/preparation-options.js';
import { PreparationSteps } from './preparation/preparation-steps.js';
import {
  UploadEntries,
  type PlannedLength,
  type UploadEntry,
} from './upload-entries.js';
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
  imports: [
    ReactiveFormsModule,
    AuthorCombobox,
    LevelField,
    PreparationOptions,
    PreparationSteps,
    UploadFileRow,
  ],
  providers: [UploadEntries, PlanForm],
  templateUrl: './upload-panel.html',
  styleUrl: './upload-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:beforeunload)': 'warnBeforeLeaving($event)' },
})
export class UploadPanel implements OnInit {
  private readonly api = inject(MediaApi);
  private readonly authorsApi = inject(AuthorsApi);
  private readonly preparations = inject(PreparationApi);
  private readonly queue = inject(ProcessingQueueStore);
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);
  private readonly locale = inject(LOCALE_ID);
  protected readonly plan = inject(PlanForm);
  /** Who may only send sees no flow of four steps: the upload is all there is (AC-15). */
  protected readonly showSteps = computed(() => this.session.can('media-edit'));
  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly levelField = viewChild(LevelField);
  private readonly injector = inject(Injector);
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
  /** The "Nível" of the chosen collection (KBC-105): asked again when its scale changes. */
  protected readonly levels = levelChoicesOf(
    () => this.chosenTopic(),
    (slug) => rootIn(this.topics(), slug),
  );
  private readonly chosenRoot = computed(() =>
    rootIn(this.topics(), this.chosenTopic()),
  );
  /**
   * No level is chosen beforehand (SL-28); only another scale empties the choice (T14): a
   * sub-collection uses its parent's, so moving between them keeps it.
   */
  protected readonly level = linkedSignal<string, string | null>({
    // A computed source: an equal top-level collection does not run the computation.
    source: this.chosenRoot,
    computation: () => null,
  });
  protected readonly levelLabel = $localize`:@@media.level.label:Nível`;
  /**
   * "Enviar" pressed while the levels were on their way: it goes when they come (no click is
   * lost), and the button says what it waits for.
   */
  protected readonly waitingForLevels = signal(false);
  /** With a scale, nothing goes without a level (BR-1); unknown, the API decides. */
  private readonly levelMissing = computed(
    () => this.levels.levels().length > 0 && this.level() === null,
  );
  protected readonly levelInvalid = computed(
    () =>
      this.submitted() &&
      this.levels.levels().length > 0 &&
      this.level() === null,
  );
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
  /** Who goes on with a paid plan sees that it is paid, and how much (Q188). */
  protected readonly keptNotice = computed(() => {
    const usd = this.uploads.keptUsd();
    return usd === null
      ? $localize`:@@media.upload.planKept:O que continua de um envio anterior mantém as escolhas daquele envio.`
      : $localize`:@@media.upload.planKeptPaid:O que continua de um envio anterior mantém as escolhas daquele envio, com IA paga de até ${this.mostText(usd)}:value:.`;
  });

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
    // Leaving the page or the route mid-upload: stop. The same file continues later (FR-2).
    inject(DestroyRef).onDestroy(() => this.halt());
    // An "Enviar" held for the levels goes once they are known (or could not be had).
    toObservable(this.levels.loading)
      .pipe(
        filter((loading) => !loading && this.waitingForLevels()),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.send());
    // The estimates go by the files' length, read before anything is sent (KBC-072 BR-4).
    toObservable(this.uploads.plannedLength)
      .pipe(takeUntilDestroyed())
      .subscribe((length) => this.aimPlan(length));
    // Opened before the collections were known: the field takes the selected one when it comes.
    toObservable(this.topic)
      .pipe(
        filter(
          (topic) => topic !== '' && this.form.controls.topic.value === '',
        ),
        takeUntilDestroyed(),
      )
      .subscribe((topic) => {
        this.form.controls.topic.setValue(topic);
        this.topicChosen();
      });
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
    // The button is off while sending; the list stays as it was at the click (T14).
    if (this.stage() === 'sending')
      return this.fileProblem.set(
        $localize`:@@media.upload.dropWhileSending:Espere o envio terminar para adicionar arquivos.`,
      );
    this.takeFiles(event.dataTransfer?.files ?? null);
  }

  protected send(): void {
    // The waiting button keeps its focus (aria-disabled): a press on it does nothing.
    if (this.waitingForLevels() && this.levels.loading()) return;
    // Every way out of here leaves no wait behind (review round 2: a stuck button).
    this.waitingForLevels.set(false);
    this.submitted.set(true);
    const targets = this.uploads.sendable();
    // A name the API would refuse is said under the "Autor" field and never sent.
    const badAuthor = isInvalidAuthorName(this.authorName());
    this.fileProblem.set(this.nothingToSend(targets));
    if (
      targets.length === 0 ||
      targets.some(({ title }) => !validTitle(title)) ||
      this.form.invalid ||
      badAuthor ||
      this.holdForLevels() ||
      this.levelsUnknown() ||
      this.levelMissing()
    )
      return;
    this.enter('sending');
    this.interrupted = false;
    const batch: Batch = {
      author: this.authorOf().pipe(shareReplay(1)),
      plan: this.plan.plan(),
      allMs: this.uploads.plannedMs(),
    };
    this.sending = from(targets)
      .pipe(mergeMap((entry) => this.sendOne(entry, batch), FILES_AT_ONCE))
      .subscribe({ complete: () => this.settle() });
  }

  /** True while the levels are asked for: the send waits for them, then goes on its own. */
  private holdForLevels(): boolean {
    this.waitingForLevels.set(this.levels.loading());
    return this.waitingForLevels();
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
    if (stage === 'sending') return topic.disable();
    topic.enable();
    this.fileProblem.set(null);
  }

  private takeFiles(files: FileList | null): void {
    this.fileProblem.set(null);
    this.uploads.add(Array.from(files ?? []));
  }

  private aimPlan(length: PlannedLength): void {
    if (length === 'unknown') return this.plan.lengthUnknown();
    if (length === 'past-limit') return this.plan.lengthPastLimit();
    this.plan.aim({ durationMs: length });
  }

  private nothingToSend(targets: readonly UploadEntry[]): string | null {
    if (targets.length > 0) return null;
    return this.uploads.entries().length === 0
      ? $localize`:@@media.upload.noFile:Escolha um arquivo de áudio.`
      : $localize`:@@media.upload.nothingToSend:Nada a enviar: estes arquivos não podem ser enviados.`;
  }

  private draftOf(entry: UploadEntry, batch: Batch): Draft {
    const { file, title } = entry;
    const { topic } = this.form.getRawValue();
    return {
      file,
      title: title.trim(),
      topic,
      author: this.authorName().trim(),
      level: this.level(),
      plan: planOfEntry(entry, batch),
    };
  }

  /** One file, from its item to its last byte; a failure stays on its own line. */
  private sendOne(entry: UploadEntry, batch: Batch): Observable<never> {
    const { key, file } = entry;
    const start = entry.state.kind === 'resume' ? entry.state.offset : 0;
    this.uploads.set(key, {
      kind: 'sending',
      loaded: start,
      total: file.size,
    });
    return this.itemFor(entry, batch).pipe(
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
  private itemFor(entry: UploadEntry, batch: Batch): Observable<string> {
    const { key, file, title, sha256, durationMs, state } = entry;
    const draft = this.draftOf(entry, batch);
    if (state.kind === 'resume') {
      this.created.set(key, { id: state.mediaId, draft });
      return of(state.mediaId);
    }
    const held = this.created.get(key);
    if (held && sameDraft(held.draft, draft)) return of(held.id);
    return this.removeHeld(key).pipe(
      concatMap(() => batch.author),
      concatMap((authorSlug) =>
        this.api.create(draft.topic, {
          title: title.trim(),
          author: authorSlug,
          fileName: file.name,
          bytes: file.size,
          sha256,
          durationMs,
          ...(draft.level === null ? {} : { level: draft.level }),
          ...(draft.plan ? { plan: draft.plan } : {}),
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
    if (pending) return;
    this.plan.remember();
    const guided = this.plan.guided();
    this.dialog().nativeElement.close();
    this.continuePreparation(guided);
  }

  /**
   * One file goes on to step 2; several go to the queue, which says what each one is doing
   * and what comes next (KBC-090). Only "Transcrever" of one file ends here, as ever (AC-15).
   */
  private continuePreparation(guided: boolean): void {
    const [only, ...others] = this.sent.entries();
    if (!only) return;
    if (others.length > 0) {
      void this.router.navigateByUrl(QUEUE_PAGE_PATH);
      return;
    }
    const [key, item] = only;
    if (this.uploads.entries().find((e) => e.key === key)?.resumes)
      return this.continueResumed(item.id);
    if (guided) this.openPreparation(item.id);
  }

  /** What was resumed goes by the plan on the server: the form may say something else. */
  private continueResumed(id: string): void {
    if (!this.session.can('media-edit')) return;
    this.preparations.read(id).subscribe({
      next: ({ plan, finished }) => {
        if (plan && !finished) this.openPreparation(id);
      },
      // The list shows the way back all the same.
      error: () => undefined,
    });
  }

  private openPreparation(id: string): void {
    void this.router.navigateByUrl(preparationPagePath(id));
  }

  /** The list learns of each new item once; the last one ends up focused (UP-01). */
  private reportSent(): void {
    this.queue.refresh();
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
    if (!held) return of(null);
    return this.api.remove(held.id).pipe(
      catchError((err: unknown) => {
        if (err instanceof HttpErrorResponse && err.status === 403)
          return throwError(() => new ItemKept(this.keptProblem(held)));
        return of(null);
      }),
      tap(() => this.created.delete(key)),
    );
  }

  /** "de até": the most the plan's run may spend, its limit (KBC-112 BR-6). */
  private mostText(usd: number): string {
    return usdUpText(usd * PLAN_ESTIMATE_TOLERANCE, this.locale);
  }

  /** An item that left "uploading" is not its sender's to remove: its plan stands. */
  private keptProblem({ draft: { plan } }: Created): string {
    const usd = plan?.tracks === 'ai' ? plan.acceptedUsd : null;
    return usd === null || usd === undefined
      ? $localize`:@@media.upload.alreadyArrived:Este áudio já tinha chegado, então segue com as escolhas daquele envio. Só um master pode apagá-lo.`
      : $localize`:@@media.upload.alreadyArrivedPaid:Este áudio já tinha chegado, então segue com as escolhas daquele envio, com IA paga de até ${this.mostText(usd)}:value:. Só um master pode apagá-lo.`;
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
    // BR-6: at a level the person does not see, nothing names it.
    if (duplicateHiddenDetailsSchema.safeParse(errorDetailsOf(err)).success)
      return this.uploads.set(key, { kind: 'duplicate-hidden' });
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

/** The top-level collection whose scale a collection uses (ADR 0036 §1). */
const rootIn = (topics: readonly Topic[], slug: string): string =>
  topics.find((one) => one.slug === slug)?.parent ?? slug;

/** None for a file that goes on: its item keeps the plan it was created with. */
function planOfEntry(
  entry: UploadEntry,
  { plan, allMs }: Batch,
): PreparationPlanRequest | null {
  if (entry.resumes) return null;
  if (allMs === null || entry.durationMs === null) return plan;
  return planShare(plan, { lengthMs: entry.durationMs, allMs });
}

/** The title as the row's field and the API read it. */
const validTitle = (title: string): boolean =>
  title.trim().length > 0 && title.length <= 200;

/** The item stays as it was sent; `message` says so to the person. */
class ItemKept extends Error {}

function problemOf(err: unknown): string {
  if (err instanceof ItemKept) return err.message;
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

/** What the click on "Enviar" fixed: nothing a later file reads may change it. */
interface Batch {
  /** One registration for all the files. */
  readonly author: Observable<string | null>;
  readonly plan: PreparationPlanRequest;
  /** The length the value seen is for; null when it is not known. */
  readonly allMs: number | null;
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
  /** Its level, in a collection with levels (KBC-105); null without a scale. */
  readonly level: string | null;
  /** What the person asked for this audio (KBC-072); none for an item that goes on. */
  readonly plan: PreparationPlanRequest | null;
}

const samePlan = (a: Draft['plan'], b: Draft['plan']): boolean =>
  a === null || b === null ? a === b : sameChoices(a, b);

const sameDraft = (a: Draft, b: Draft): boolean =>
  a.file === b.file &&
  a.title === b.title &&
  a.topic === b.topic &&
  a.author === b.author &&
  a.level === b.level &&
  samePlan(a.plan, b.plan);
