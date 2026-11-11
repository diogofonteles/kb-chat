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
import type {
  AccessLevel,
  LevelPreview,
  TopicLevels,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { LevelsApi } from '@core/levels/levels-api.js';
import { finalize, type Observable } from 'rxjs';

/** One level, or every level of the scale. */
type Removing =
  | { readonly kind: 'one'; readonly level: AccessLevel }
  | { readonly kind: 'all' };

/** What the dialog shows: waiting for the preview, the preview, or why there is none. */
type Loaded =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly preview: LevelPreview }
  | { readonly state: 'failed'; readonly message: string };

/** The same text, whatever its case and surrounding spaces. */
const sameName = (typed: string, title: string): boolean =>
  typed.trim().toLocaleLowerCase('pt-BR') ===
  title.trim().toLocaleLowerCase('pt-BR');

const and = (parts: readonly string[]): string =>
  parts.length < 2
    ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} ${$localize`:@@levels.and:e`} ${parts.at(-1) ?? ''}`;

/**
 * "Apagar" and "Tirar todos os níveis" on T24 (KBC-108 FR-1, FR-3, BR-1, BR-2, BR-4): the
 * dialog names the level and what it holds, from the server's preview, with the two targets
 * pre-chosen (content up, people down) before the danger button, which takes the focus
 * (MA-27). The only level, or every level, asks for the collection's name instead.
 */
@Component({
  selector: 'app-level-delete-dialog',
  templateUrl: './level-delete-dialog.html',
  styleUrl: './level-delete-dialog.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LevelDeleteDialog {
  private readonly api = inject(LevelsApi);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly confirmButton =
    viewChild<ElementRef<HTMLButtonElement>>('confirmButton');
  private readonly nameInput =
    viewChild<ElementRef<HTMLInputElement>>('nameInput');

  /** The collection (a top-level one), its title and its scale as shown. */
  readonly topic = input.required<string>();
  readonly title = input.required<string>();
  readonly scale = input.required<TopicLevels>();
  /** Told with the scale after the change. */
  readonly done = output<TopicLevels>();
  /** Told when the scale changed under the dialog: the page reloads it. */
  readonly stale = output();

  protected readonly removing = signal<Removing>({ kind: 'all' });
  protected readonly loaded = signal<Loaded>({ state: 'loading' });
  protected readonly contentTo = signal('');
  protected readonly peopleTo = signal('');
  protected readonly typedName = signal('');
  protected readonly busy = signal(false);
  protected readonly failure = signal('');

  /** Every level goes: the one level left, or "Tirar todos os níveis". */
  protected readonly all = computed(() => {
    const removing = this.removing();
    return removing.kind === 'all' || this.scale().levels.length === 1;
  });
  protected readonly level = computed(() => {
    const removing = this.removing();
    return removing.kind === 'one' ? removing.level : null;
  });
  /** The other levels, as targets (BR-1). */
  protected readonly targets = computed(() =>
    this.scale().levels.filter((one) => one.id !== this.level()?.id),
  );
  protected readonly nameMatches = computed(() =>
    sameName(this.typedName(), this.title()),
  );
  protected readonly preview = computed(() => {
    const loaded = this.loaded();
    return loaded.state === 'ready' ? loaded.preview : null;
  });
  /** "12 documentos, 3 áudios e 4 pessoas estão em CI." */
  protected readonly holdings = computed(() => {
    const removal = this.preview()?.removal;
    if (!removal) return '';
    const parts = [
      this.count(removal.documents, 'documents'),
      this.count(removal.media, 'media'),
      this.count(removal.people, 'people'),
    ];
    const code = removal.level.code;
    const total = removal.documents + removal.media + removal.people;
    return total === 0
      ? $localize`:@@levels.deleteEmpty:Nada está em ${code}:code:.`
      : $localize`:@@levels.deleteHoldings:${and(parts)}:parts: estão em ${code}:code:.`;
  });
  protected readonly canConfirm = computed(() =>
    this.all()
      ? this.nameMatches() && !this.busy()
      : this.preview() !== null && !this.busy(),
  );

  /** Opens for one level (or every level when it is the only one). */
  openFor(level: AccessLevel): void {
    if (this.scale().levels.length === 1) return this.openForAll();
    this.reset({ kind: 'one', level });
    this.loadPreview(level.id);
  }

  /** Opens "Tirar todos os níveis". */
  openForAll(): void {
    this.reset({ kind: 'all' });
    this.focusAfterRender(() => this.nameInput());
  }

  protected close(): void {
    this.dialog().nativeElement.close();
  }

  protected confirm(): void {
    if (!this.canConfirm()) return;
    const { version } = this.scale();
    const level = this.level();
    const request =
      this.all() || !level
        ? this.api.clear(this.topic(), version)
        : this.api.remove(this.topic(), level.id, {
            moveContentTo: this.contentTo(),
            movePeopleTo: this.peopleTo(),
            version,
          });
    this.write(request);
  }

  private reset(removing: Removing): void {
    this.removing.set(removing);
    this.typedName.set('');
    this.failure.set('');
    this.loaded.set({ state: 'loading' });
    this.dialog().nativeElement.showModal();
  }

  private focusAfterRender(
    target: () => ElementRef<HTMLElement> | undefined,
  ): void {
    afterNextRender(() => target()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  private loadPreview(id: string): void {
    this.api
      .preview(this.topic(), { remove: id, version: this.scale().version })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (preview) => {
          this.contentTo.set(preview.removal?.moveContentTo ?? '');
          this.peopleTo.set(preview.removal?.movePeopleTo ?? '');
          this.loaded.set({ state: 'ready', preview });
          // The targets and what moves are on screen: the danger button takes the focus (MA-27).
          this.focusAfterRender(() => this.confirmButton());
        },
        error: (err: unknown) => this.failed(err),
      });
  }

  private write(request: Observable<TopicLevels>): void {
    this.busy.set(true);
    this.failure.set('');
    request
      .pipe(
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (scale) => {
          this.close();
          this.done.emit(scale);
        },
        error: (err: unknown) => this.failed(err),
      });
  }

  /** The message stays in the dialog with the choices made (MA-26). */
  private failed(err: unknown): void {
    const code = toUiErrorCode(err);
    const message = errorMessage(code);
    this.failure.set(message);
    if (this.loaded().state === 'loading')
      this.loaded.set({ state: 'failed', message });
    if (code === 'LEVELS_CHANGED') this.stale.emit();
  }

  private count(n: number, what: 'documents' | 'media' | 'people'): string {
    const labels = {
      documents: () =>
        n === 1
          ? $localize`:@@levels.oneDocument:1 documento`
          : $localize`:@@levels.documents:${n}:count: documentos`,
      media: () =>
        n === 1
          ? $localize`:@@levels.oneAudio:1 áudio`
          : $localize`:@@levels.audios:${n}:count: áudios`,
      people: () =>
        n === 1
          ? $localize`:@@levels.onePerson:1 pessoa`
          : $localize`:@@levels.people:${n}:count: pessoas`,
    };
    return labels[what]();
  }
}
