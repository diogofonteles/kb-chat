import { HttpErrorResponse, httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import {
  MAX_TRACK_SUBJECTS,
  TRACK_SUMMARY_MAX,
  TRACK_TITLE_MAX,
  collectionSpeakerListSchema,
  collectionSubjectsSchema,
  speakerKeyOf,
  subjectKey,
  trackSubjectsSchema,
  type MediaItem,
  type SubjectRef,
  type TrackEditView,
  type TrackPatchRequest,
  type TrackSpeakerScope,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import {
  SpeakersApi,
  collectionSpeakersUrl,
} from '@core/media/speakers-api.js';
import { TrackRevisionsApi } from '@core/media/track-revisions-api.js';
import {
  TrackSubjectsApi,
  collectionSubjectsUrl,
  trackSubjectsUrl,
} from '@core/media/track-subjects-api.js';
import { concatMap, forkJoin, map, of, type Observable } from 'rxjs';
import { notBlank } from '../upload-rules.js';
import { SubjectPicker, type SubjectChoice } from '../tracks/subject-picker.js';
import {
  TrackSuggestPanel,
  type SuggestionUse,
} from './track-suggest-panel.js';

/** A subject on the track as the form holds it, until "Salvar". */
interface Chip {
  readonly key: string;
  readonly name: string;
  readonly ref: SubjectRef;
}

const subjectFieldLabel = () =>
  $localize`:@@trackEdit.addSubject:Adicionar assunto`;

/**
 * "Editar faixa" (KBC-073 FR-1, screen spec): title, description, who speaks and subjects on the
 * same id. Only what changed is sent; a save on an old version shows the other person's and
 * keeps what was typed (BR-10).
 */
@Component({
  selector: 'app-track-edit-dialog',
  imports: [ReactiveFormsModule, SubjectPicker, TrackSuggestPanel],
  templateUrl: './track-edit-dialog.html',
  styleUrls: ['./track-edit.css', './track-edit-dialog.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrackEditDialog {
  private readonly api = inject(TrackRevisionsApi);
  private readonly speakersApi = inject(SpeakersApi);
  private readonly subjectsApi = inject(TrackSubjectsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly titleInput =
    viewChild.required<ElementRef<HTMLInputElement>>('titleInput');

  readonly track = input.required<TrackEditView>();
  readonly canClassify = input(false);
  readonly canSuggest = input(false);
  readonly saved = output<MediaItem>();
  readonly closed = output();

  protected readonly titleMax = TRACK_TITLE_MAX;
  protected readonly summaryMax = TRACK_SUMMARY_MAX;
  protected readonly maxSubjects = MAX_TRACK_SUBJECTS;
  protected readonly pickerLabel = subjectFieldLabel();
  protected readonly form = new FormGroup({
    title: new FormControl('', {
      nonNullable: true,
      validators: [notBlank, Validators.maxLength(TRACK_TITLE_MAX)],
    }),
    summary: new FormControl('', { nonNullable: true }),
    asker: new FormControl('', { nonNullable: true }),
    answerer: new FormControl('', { nonNullable: true }),
    scope: new FormControl<TrackSpeakerScope>('track', { nonNullable: true }),
  });
  private readonly typed = toSignal(this.form.valueChanges, {
    initialValue: null,
  });
  /** What the form was read from: a conflict moves it to the other person's. */
  private readonly base = linkedSignal(() => this.track());
  protected readonly conflict = signal<TrackEditView | null>(null);
  protected readonly submitted = signal(false);
  protected readonly saving = signal(false);
  protected readonly failure = signal('');

  private readonly speakers = httpResource(
    () => collectionSpeakersUrl(this.track().topic),
    { parse: (body) => collectionSpeakerListSchema.parse(body).items },
  );
  protected readonly speakerNames = computed(() =>
    this.speakers.hasValue()
      ? this.speakers.value().map((one) => one.name)
      : [],
  );
  private readonly subjectsRead = httpResource(
    () =>
      this.canClassify() ? trackSubjectsUrl(this.track().mediaId) : undefined,
    { parse: (body) => trackSubjectsSchema.parse(body) },
  );
  private readonly collectionRead = httpResource(
    () =>
      this.canClassify()
        ? collectionSubjectsUrl(this.track().topic)
        : undefined,
    { parse: (body) => collectionSubjectsSchema.parse(body) },
  );
  protected readonly collection = computed(() =>
    this.collectionRead.hasValue() ? this.collectionRead.value() : null,
  );
  private readonly storedChips = computed<readonly Chip[]>(() => {
    if (!this.subjectsRead.hasValue()) return [];
    return this.subjectsRead.value().subjects.map((subject) => ({
      key: subjectKey(subject.name),
      name: subject.name,
      ref:
        subject.kind === 'free' && subject.id
          ? { kind: 'free', id: subject.id }
          : { kind: 'concept', name: subject.name },
    }));
  });
  protected readonly chips = linkedSignal<readonly Chip[]>(() =>
    this.storedChips(),
  );
  protected readonly chipKeys = computed(() =>
    this.chips().map((chip) => chip.key),
  );
  private readonly chipsChanged = computed(() => {
    const now = this.chipKeys();
    const stored = this.storedChips().map((chip) => chip.key);
    return (
      now.length !== stored.length || now.some((key, i) => key !== stored[i])
    );
  });
  /** A voice's name reaches the recording only from a role that has a voice. */
  protected readonly canSpreadName = computed(() => {
    this.typed();
    const { asker, answerer } = this.base();
    const roles = [
      { speaker: asker, typed: this.form.controls.asker.value },
      { speaker: answerer, typed: this.form.controls.answerer.value },
    ].filter((one) => one.typed.trim() !== (one.speaker.name ?? ''));
    return (
      roles.length > 0 && roles.every(({ speaker }) => speaker.voice !== null)
    );
  });

  constructor() {
    afterNextRender(() => {
      this.fill(this.track());
      this.dialog().nativeElement.showModal();
      this.titleInput().nativeElement.focus();
    });
  }

  private fill(track: TrackEditView): void {
    this.form.reset({
      title: track.title,
      summary: track.summary ?? '',
      asker: track.asker.name ?? '',
      answerer: track.answerer.name ?? '',
      scope: 'track',
    });
  }

  protected cancel(): void {
    this.dialog().nativeElement.close();
  }

  protected removeLabel(name: string): string {
    return $localize`:@@subjects.remove:Remover assunto ${name}:name:`;
  }

  protected removeChip(key: string): void {
    this.chips.update((chips) => chips.filter((chip) => chip.key !== key));
  }

  protected addChip(choice: SubjectChoice): void {
    if (choice.kind === 'create') {
      this.createChip(choice.name);
      return;
    }
    const name =
      choice.kind === 'concept' ? choice.name : this.freeName(choice.id);
    this.pushChip({ key: subjectKey(name), name, ref: choice });
  }

  private freeName(id: string): string {
    return this.collection()?.free.find((one) => one.id === id)?.name ?? id;
  }

  private pushChip(chip: Chip): void {
    if (this.chipKeys().includes(chip.key)) return;
    this.chips.update((chips) => [...chips, chip]);
  }

  private createChip(name: string): void {
    this.subjectsApi
      .createFree(this.track().topic, name)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (free) =>
          this.pushChip({
            key: subjectKey(free.name),
            name: free.name,
            ref: { kind: 'free', id: free.id },
          }),
        error: (err: unknown) => this.fail(err),
      });
  }

  protected useSuggestion(use: SuggestionUse): void {
    if (use.field !== 'subject') {
      this.form.controls[use.field].setValue(use.value);
      return;
    }
    const { subject } = use;
    if (subject.kind === 'free' && subject.id)
      this.addChip({ kind: 'free', id: subject.id });
    else if (subject.kind === 'concept')
      this.addChip({ kind: 'concept', name: subject.name });
    else this.createChip(subject.name);
  }

  protected useTheirs(theirs: TrackEditView): void {
    this.fill(theirs);
    this.adopt(theirs);
  }

  protected saveOver(theirs: TrackEditView): void {
    this.adopt(theirs);
    this.save();
  }

  private adopt(theirs: TrackEditView): void {
    this.base.set(theirs);
    this.conflict.set(null);
  }

  protected save(): void {
    this.submitted.set(true);
    if (this.form.invalid || this.saving()) return;
    this.saving.set(true);
    this.failure.set('');
    this.speakerChanges()
      .pipe(
        concatMap((speakers) => this.writeDetails(speakers)),
        concatMap((item) => this.writeSubjects().pipe(map(() => item))),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (item) => this.done(item),
        error: (err: unknown) => this.refused(err),
      });
  }

  private done(item: MediaItem | null): void {
    this.saving.set(false);
    if (item) this.saved.emit(item);
    else this.cancel();
  }

  private fail(err: unknown): void {
    this.failure.set(errorMessage(toUiErrorCode(err)));
  }

  private refused(err: unknown): void {
    this.saving.set(false);
    if (err instanceof HttpErrorResponse && err.status === 412) {
      this.api
        .view(this.track().mediaId)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (theirs) => this.conflict.set(theirs),
          error: (read: unknown) => this.fail(read),
        });
      return;
    }
    this.fail(err);
  }

  /** The ids of the names that changed; a name not on the list joins it first. */
  private speakerChanges(): Observable<Partial<TrackPatchRequest>> {
    const { asker, answerer } = this.base();
    return forkJoin({
      askerSpeakerId: this.speakerId(asker.name, this.form.value.asker),
      answererSpeakerId: this.speakerId(
        answerer.name,
        this.form.value.answerer,
      ),
    }).pipe(
      map((ids) =>
        Object.fromEntries(
          Object.entries(ids).filter(([, id]) => id !== undefined),
        ),
      ),
    );
  }

  private speakerId(
    before: string | null,
    typed: string | undefined,
  ): Observable<string | null | undefined> {
    const name = (typed ?? '').trim();
    if (name === (before ?? '')) return of(undefined);
    if (!name) return of(null);
    const key = speakerKeyOf(name);
    const known = this.speakers.hasValue()
      ? this.speakers.value().find((one) => speakerKeyOf(one.name) === key)
      : undefined;
    if (known) return of(known.id);
    return this.speakersApi
      .createSpeaker(this.track().topic, { name })
      .pipe(map((speaker) => speaker.id));
  }

  /** The description goes with the subjects when they change: both are one version. */
  private writeDetails(
    speakers: Partial<TrackPatchRequest>,
  ): Observable<MediaItem | null> {
    const base = this.base();
    const { title, summary } = this.form.getRawValue();
    const written = summary.trim() || null;
    const body: TrackPatchRequest = {
      ...(title.trim() === base.title ? {} : { title: title.trim() }),
      ...(written === base.summary || this.chipsChanged()
        ? {}
        : { summary: written }),
      ...speakers,
    };
    const named = Object.keys(speakers).length > 0;
    if (Object.keys(body).length === 0) return of(null);
    const scope = this.canSpreadName() ? this.form.value.scope : 'track';
    return this.api.patch(base, named ? { ...body, scope } : body);
  }

  private writeSubjects(): Observable<unknown> {
    if (!this.chipsChanged() || !this.subjectsRead.hasValue()) return of(null);
    return this.subjectsApi.save(this.subjectsRead.value(), {
      subjects: this.chips().map((chip) => chip.ref),
      summary: this.form.getRawValue().summary,
    });
  }
}
