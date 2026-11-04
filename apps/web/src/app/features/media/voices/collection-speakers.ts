import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
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
  SPEAKER_NAME_MAX,
  speakerNameSchema,
  type Author,
  type CollectionSpeaker,
} from '@kb-chat/contracts';
import { SpeakersApi } from '@core/media/speakers-api.js';

/**
 * "Falantes do acervo" (KBC-065 FR-1, BR-2): the collection's list, to rename a speaker or
 * say which author it is. Registering happens in the voice's field.
 */
@Component({
  selector: 'app-collection-speakers',
  templateUrl: './collection-speakers.html',
  styleUrl: './collection-speakers.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CollectionSpeakers {
  private readonly api = inject(SpeakersApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly summary = viewChild<ElementRef<HTMLElement>>('summary');
  readonly topic = input.required<string>();
  readonly speakers = input<readonly CollectionSpeaker[]>([]);
  readonly authors = input<readonly Author[]>([]);
  /** A speaker changed: the list and the names shown are read again. */
  readonly changed = output();

  protected readonly nameMax = SPEAKER_NAME_MAX;
  /** The speaker being edited. */
  protected readonly editing = signal<string | null>(null);
  protected readonly name = signal('');
  protected readonly author = signal('');
  protected readonly error = signal('');
  private readonly busy = signal(false);
  protected readonly count = computed(() => this.speakers().length);
  /** Each author at most once: the ones free, plus the one the edited speaker is. */
  protected readonly authorChoices = computed(() => {
    const editing = this.editing();
    const taken = new Set(
      this.speakers()
        .filter((one) => one.id !== editing)
        .map((one) => one.authorSlug),
    );
    return this.authors().filter((author) => !taken.has(author.slug));
  });

  protected edit(speaker: CollectionSpeaker): void {
    this.editing.set(speaker.id);
    this.name.set(speaker.name);
    this.author.set(speaker.authorSlug ?? '');
    this.error.set('');
  }

  protected cancel(): void {
    this.editing.set(null);
    this.keepFocus();
  }

  protected typeName(event: Event): void {
    this.name.set((event.target as HTMLInputElement).value);
    this.error.set('');
  }

  protected chooseAuthor(event: Event): void {
    this.author.set((event.target as HTMLSelectElement).value);
  }

  /** The form goes with what had the focus: the list's title takes it (NG-30). */
  private keepFocus(): void {
    afterNextRender(() => this.summary()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  protected save(event: Event, id: string): void {
    event.preventDefault();
    const parsed = speakerNameSchema.safeParse(this.name());
    if (!parsed.success) return this.error.set(invalidName(this.nameMax));
    if (this.busy()) return;
    this.busy.set(true);
    this.api
      .updateSpeaker(this.topic(), id, {
        name: parsed.data,
        authorSlug: this.author() || null,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.editing.set(null);
          this.keepFocus();
          this.changed.emit();
        },
        error: (err: unknown) => {
          this.busy.set(false);
          this.error.set(saveError(err));
        },
      });
  }
}

const invalidName = (max: number): string =>
  $localize`:@@voices.nameInvalidPlain:O nome deve ter de 1 a ${max}:max: caracteres, em uma linha, sem aspas nem « ».`;

const saveError = (err: unknown): string =>
  err instanceof HttpErrorResponse && err.status === 409
    ? $localize`:@@voices.speakerTaken:Já existe um falante com esse nome.`
    : $localize`:@@voices.speakerFailed:Não consegui salvar. Tente de novo.`;
