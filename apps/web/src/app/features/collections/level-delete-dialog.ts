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
import { finalize, type Observable, type Subscription } from 'rxjs';

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
  private readonly status =
    viewChild<ElementRef<HTMLParagraphElement>>('status');
  /** The preview or the re-read on its way: cancelled when the dialog opens again (R2-2). */
  private pending: Subscription | null = null;

  /** The collection (a top-level one), its title and its scale as shown. */
  readonly topic = input.required<string>();
  readonly title = input.required<string>();
  readonly scale = input.required<TopicLevels>();
  /** Told with the scale after the change. */
  readonly done = output<TopicLevels>();
  /** Told when the scale changed under the dialog: the page reloads it. */
  readonly stale = output();
  /** Told, with its code, when the level was deleted by someone else meanwhile (R2-3). */
  readonly gone = output<string>();

  protected readonly removing = signal<Removing>({ kind: 'all' });
  protected readonly loaded = signal<Loaded>({ state: 'loading' });
  protected readonly contentTo = signal('');
  protected readonly peopleTo = signal('');
  protected readonly typedName = signal('');
  protected readonly busy = signal(false);
  protected readonly failure = signal('');
  /** Said in a live region when the dialog counted again on a newer scale (BR-3). */
  protected readonly recounted = signal('');
  /** The scale the dialog read itself after a 409, until the page's catches up. */
  private readonly latest = signal<TopicLevels | null>(null);
  /** The scale the dialog works on: its own after a 409, else the page's. */
  private readonly current = computed(() => {
    const latest = this.latest();
    const page = this.scale();
    return latest && latest.version !== page.version ? latest : page;
  });

  /** Every level goes: the one level left, or "Tirar todos os níveis". */
  protected readonly all = computed(() => {
    const removing = this.removing();
    return removing.kind === 'all' || this.current().levels.length === 1;
  });
  protected readonly level = computed(() => {
    const removing = this.removing();
    return removing.kind === 'one' ? removing.level : null;
  });
  /** The other levels, as targets (BR-1). */
  protected readonly targets = computed(() =>
    this.current().levels.filter((one) => one.id !== this.level()?.id),
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
    const counts = [
      [removal.documents, 'documents'],
      [removal.media, 'media'],
      [removal.people, 'people'],
    ] as const;
    // Only what the level holds: "1 documento e 1 pessoa", never "0 áudios".
    const parts = counts
      .filter(([n]) => n > 0)
      .map(([n, what]) => this.count(n, what));
    const code = removal.level.code;
    const total = removal.documents + removal.media + removal.people;
    if (parts.length === 0)
      return $localize`:@@levels.deleteEmpty:Nada está em ${code}:code:.`;
    return total === 1
      ? $localize`:@@levels.deleteHoldingsOne:${and(parts)}:parts: está em ${code}:code:.`
      : $localize`:@@levels.deleteHoldings:${and(parts)}:parts: estão em ${code}:code:.`;
  });
  /** KBC-109: profiles that name the level (or, every level going, any) ask for another one. */
  protected readonly profilesNote = computed(() => {
    const preview = this.preview();
    if (!preview || preview.profiles === 0) return '';
    const n = preview.profiles;
    const code = preview.removal?.level.code;
    if (code)
      return n === 1
        ? $localize`:@@levels.deleteProfilesOne:1 perfil de convite usa ${code}:code:. Ele não muda: ao aplicá-lo, a pessoa fica no nível mais baixo até alguém escolher outro no perfil.`
        : $localize`:@@levels.deleteProfiles:${n}:count: perfis de convite usam ${code}:code:. Eles não mudam: ao aplicá-los, a pessoa fica no nível mais baixo até alguém escolher outro no perfil.`;
    return n === 1
      ? $localize`:@@levels.clearProfilesOne:1 perfil de convite usa um nível deste acervo. Ele não muda: ao aplicá-lo, o nível dele não vale mais.`
      : $localize`:@@levels.clearProfiles:${n}:count: perfis de convite usam níveis deste acervo. Eles não mudam: ao aplicá-los, os níveis deles não valem mais.`;
  });
  /** Only on a preview of the scale as it is now (BR-3), never while one is coming. */
  protected readonly canConfirm = computed(() => {
    if (this.busy() || this.preview() === null) return false;
    return !this.all() || this.nameMatches();
  });

  /** Opens for one level (or every level when it is the only one). */
  openFor(level: AccessLevel): void {
    if (this.scale().levels.length === 1) return this.openForAll();
    this.reset({ kind: 'one', level });
    this.loadPreview(this.scale().version);
  }

  /** Opens "Tirar todos os níveis": its preview counts the profiles it leaves (R1-11). */
  openForAll(): void {
    this.reset({ kind: 'all' });
    this.loadPreview(this.scale().version);
    this.focusAfterRender(() => this.nameInput());
  }

  /** Esc while a change is on its way: the dialog waits for it (R3-1). */
  protected holdWhileBusy(event: Event): void {
    if (this.busy()) event.preventDefault();
  }

  /** "Cancelar": never while a change is on its way (R3-1). */
  protected close(): void {
    if (!this.busy()) this.shut();
  }

  private shut(): void {
    this.cancelPending();
    this.dialog().nativeElement.close();
  }

  private cancelPending(): void {
    this.pending?.unsubscribe();
    this.pending = null;
  }

  /** Where the focus waits while the dialog counts: the name, or the status line (QA-r2-2). */
  private holdFocus(): void {
    this.focusAfterRender(() =>
      this.all() ? this.nameInput() : this.status(),
    );
  }

  protected confirm(): void {
    const preview = this.preview();
    if (!this.canConfirm() || !preview) return;
    // The version the master saw the counts on, never a newer one (R1-2).
    const { version } = preview;
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
    this.cancelPending();
    this.removing.set(removing);
    this.typedName.set('');
    this.failure.set('');
    this.recounted.set('');
    this.latest.set(null);
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

  /** The server's count on `version`: the level's, or every level's. */
  private loadPreview(version: string): void {
    const removing = this.removing();
    const body =
      removing.kind === 'one' && !this.all()
        ? { remove: removing.level.id, version }
        : { all: true as const, version };
    this.loaded.set({ state: 'loading' });
    this.cancelPending();
    this.pending = this.api
      .preview(this.topic(), body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (preview) => this.previewed(preview),
        error: (err: unknown) => this.failed(err),
      });
  }

  private previewed(preview: LevelPreview): void {
    this.contentTo.set(preview.removal?.moveContentTo ?? '');
    this.peopleTo.set(preview.removal?.movePeopleTo ?? '');
    this.loaded.set({ state: 'ready', preview });
    // The targets and what moves are on screen: the danger button takes the focus (MA-27);
    // for every level, the name to type keeps it (QA-r2-2).
    this.focusAfterRender(() =>
      this.all() ? this.nameInput() : this.confirmButton(),
    );
  }

  /**
   * BR-3, R1-2: the scale changed under the dialog. It reads the scale again and counts again
   * on it (new defaults, new counts), the button off until then; a level gone closes it.
   */
  private recount(): void {
    this.stale.emit();
    this.loaded.set({ state: 'loading' });
    this.holdFocus();
    this.cancelPending();
    this.pending = this.api
      .levels(this.topic())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (scale) => {
          this.latest.set(scale);
          const removing = this.removing();
          const gone =
            removing.kind === 'one' &&
            !scale.levels.some((one) => one.id === removing.level.id);
          if (gone && removing.kind === 'one') {
            this.close();
            return this.gone.emit(removing.level.code);
          }
          this.holdFocus();
          this.recounted.set(
            $localize`:@@levels.recounted:A escala mudou. Contei de novo com a escala de agora: confira antes de confirmar.`,
          );
          this.loadPreview(scale.version);
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
          this.shut();
          this.done.emit(scale);
        },
        error: (err: unknown) => this.failed(err),
      });
  }

  /** The message stays in the dialog (MA-26); a changed scale is counted again (BR-3). */
  private failed(err: unknown): void {
    const code = toUiErrorCode(err);
    if (code === 'LEVELS_CHANGED') return this.recount();
    const message = errorMessage(code);
    this.failure.set(message);
    if (this.loaded().state === 'loading')
      this.loaded.set({ state: 'failed', message });
    // The button was disabled while it sent: the focus goes back where the master was (QA-r3-1).
    this.focusAfterRender(() =>
      this.all() ? this.nameInput() : this.confirmButton(),
    );
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
