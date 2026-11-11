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
  AppAi,
  InvitePreset,
  InviteProfile,
  InviteProfileView,
  Topic,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import type { Observable } from 'rxjs';
import { InvitePresetEditor } from './invite-preset-editor.js';
import { InviteProfilesStore } from './invite-profiles-store.js';
import { plainPreset } from './preset-defaults.js';
import { hasStaleLevel, type Scales } from './level-rows.js';

/** The profile being written: a new one has no id yet. */
interface Draft {
  readonly id: string | null;
  readonly name: string;
  readonly isDefault: boolean;
  readonly preset: InvitePreset;
  /**
   * The preset was changed here: only then does it go out, so renaming a profile or marking
   * it the default never writes levels (KBC-109 R1-2).
   */
  readonly presetChanged: boolean;
}

type Notice = { readonly kind: 'ok' | 'error'; readonly text: string } | null;

/**
 * "Perfis de convite" (KBC-028 FR-2, screens.md T9): create, edit, rename, delete and mark
 * one as the default; the same preset editor as the invitation. Masters only.
 */
@Component({
  selector: 'app-invite-profiles-panel',
  imports: [InvitePresetEditor],
  templateUrl: './invite-profiles-panel.html',
  styleUrls: ['./person-editor.css', './invite-profiles-panel.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InviteProfilesPanel {
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  protected readonly store = inject(InviteProfilesStore);
  readonly topics = input.required<readonly Topic[]>();
  readonly defaultAppAi = input<AppAi | null>(null);
  /** The collections with access levels (KBC-109 FR-5); null while loading or failed. */
  readonly scales = input<Scales | null>([]);
  /** The collections' levels failed to load: saving waits (R1-1). */
  readonly scalesFailed = input(false);
  /** "Carregar de novo": the page loads the levels again. */
  readonly reloadScales = output();

  private readonly nameInput =
    viewChild<ElementRef<HTMLInputElement>>('nameInput');
  private readonly newButton =
    viewChild<ElementRef<HTMLButtonElement>>('newButton');

  /** The section starts folded under the invitation (screens.md T9). */
  protected readonly expanded = signal(false);
  protected readonly draft = signal<Draft | null>(null);
  /** Each opened draft gets a new editor: nothing of the last profile stays (KBC-033). */
  protected readonly opened = signal(0);
  /** The saved name of the profile being edited, for the form's title. */
  protected readonly editingName = computed(() => {
    const id = this.draft()?.id;
    return id ? (this.store.find(id)?.name ?? '') : '';
  });
  protected readonly confirmingDelete = signal<string | null>(null);
  protected readonly nameError = signal('');
  /** A number typed in the preset is not kept yet: saving waits (design D4). */
  protected readonly presetInvalid = signal(false);
  protected readonly busy = signal(false);
  protected readonly notice = signal<Notice>(null);

  protected startNew(): void {
    this.open({
      id: null,
      name: '',
      isDefault: false,
      preset: plainPreset(),
      presetChanged: true,
    });
  }

  /**
   * The profile opens as it is kept (R1-2): a collection it names no level for shows "Manter
   * o nível da pessoa", and one whose level no longer exists asks for a choice (R1-3).
   */
  protected edit(profile: InviteProfileView): void {
    const { id, name, isDefault, preset } = profile;
    this.open({ id, name, isDefault, preset, presetChanged: false });
  }

  /** A profile level that no longer exists waits for a choice before the preset is saved. */
  protected readonly levelsPending = computed(() => {
    const draft = this.draft();
    return (
      !!draft?.presetChanged &&
      hasStaleLevel(draft.preset.levels, this.scales())
    );
  });

  protected rename(name: string): void {
    this.nameError.set('');
    this.draft.update((draft) => draft && { ...draft, name });
  }

  protected markDefault(isDefault: boolean): void {
    this.draft.update((draft) => draft && { ...draft, isDefault });
  }

  protected changePreset(preset: InvitePreset): void {
    this.draft.update(
      (draft) => draft && { ...draft, preset, presetChanged: true },
    );
  }

  protected cancel(): void {
    this.draft.set(null);
    this.focusAfterRender(() => this.newButton());
  }

  protected save(event: Event): void {
    event.preventDefault();
    const draft = this.draft();
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      this.nameError.set(
        $localize`:@@profiles.nameRequired:Dê um nome ao perfil.`,
      );
      this.focusAfterRender(() => this.nameInput());
      return;
    }
    if (this.scalesFailed() || this.levelsPending()) return;
    const { isDefault, preset, presetChanged } = draft;
    const call = draft.id
      ? this.store.update(draft.id, {
          name,
          isDefault,
          ...(presetChanged && { preset }),
        })
      : this.store.create({ name, isDefault, preset });
    this.run(call, (saved) => {
      this.draft.set(null);
      this.focusAfterRender(() => this.newButton());
      return $localize`:@@profiles.saved:Perfil "${saved.name}:name:" salvo.`;
    });
  }

  /** "Tornar padrão" goes away on that line: focus moves to its "Editar" (WCAG 2.4.3). */
  protected makeDefault(profile: InviteProfile): void {
    this.run(this.store.update(profile.id, { isDefault: true }), () => {
      this.focusAfterRender(() => this.byData(`[data-edit="${profile.id}"]`));
      return $localize`:@@profiles.defaultSet:"${profile.name}:name:" agora é o perfil padrão.`;
    });
  }

  /** The confirmation replaces the button that had focus: focus follows it (WCAG 2.4.3). */
  protected askDelete(profile: InviteProfile): void {
    this.confirmingDelete.set(profile.id);
    this.focusAfterRender(() => this.byData('[data-focus="delete-confirm"]'));
  }

  protected cancelDelete(): void {
    const id = this.confirmingDelete();
    this.confirmingDelete.set(null);
    this.focusAfterRender(() => this.byData(`[data-delete="${id}"]`));
  }

  private byData(selector: string): ElementRef<HTMLElement> | undefined {
    const found = this.host.nativeElement.querySelector<HTMLElement>(selector);
    return found ? new ElementRef(found) : undefined;
  }

  protected remove(profile: InviteProfile): void {
    this.confirmingDelete.set(null);
    this.run(this.store.remove(profile.id), () => {
      this.focusAfterRender(() => this.newButton());
      return $localize`:@@profiles.removed:Perfil "${profile.name}:name:" apagado.`;
    });
  }

  private open(draft: Draft): void {
    this.notice.set(null);
    this.nameError.set('');
    this.presetInvalid.set(false);
    this.confirmingDelete.set(null);
    this.draft.set(draft);
    this.opened.update((count) => count + 1);
    this.focusAfterRender(() => this.nameInput());
  }

  private focusAfterRender(
    target: () => ElementRef<HTMLElement> | undefined,
  ): void {
    afterNextRender(() => target()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  /** One change at a time; its outcome is announced under the list. */
  private run<T>(call: Observable<T>, done: (value: T) => string): void {
    this.busy.set(true);
    this.notice.set(null);
    call.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (value) => {
        this.busy.set(false);
        this.notice.set({ kind: 'ok', text: done(value) });
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.notice.set({
          kind: 'error',
          text: errorMessage(toUiErrorCode(err)),
        });
      },
    });
  }
}
