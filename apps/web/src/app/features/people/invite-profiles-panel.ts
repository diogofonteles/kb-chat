import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type {
  AppAi,
  InvitePreset,
  InviteProfile,
  Topic,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import type { Observable } from 'rxjs';
import { InvitePresetEditor } from './invite-preset-editor.js';
import { InviteProfilesStore } from './invite-profiles-store.js';
import { plainPreset } from './preset-defaults.js';

/** The profile being written: a new one has no id yet. */
interface Draft {
  readonly id: string | null;
  readonly name: string;
  readonly isDefault: boolean;
  readonly preset: InvitePreset;
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
  private readonly injector = inject(Injector);
  protected readonly store = inject(InviteProfilesStore);
  readonly topics = input.required<readonly Topic[]>();
  readonly defaultAppAi = input<AppAi | null>(null);

  private readonly nameInput =
    viewChild<ElementRef<HTMLInputElement>>('nameInput');
  private readonly newButton =
    viewChild<ElementRef<HTMLButtonElement>>('newButton');

  /** The section starts folded under the invitation (screens.md T9). */
  protected readonly expanded = signal(false);
  protected readonly draft = signal<Draft | null>(null);
  protected readonly confirmingDelete = signal<string | null>(null);
  protected readonly nameError = signal('');
  protected readonly busy = signal(false);
  protected readonly notice = signal<Notice>(null);

  protected startNew(): void {
    this.open({ id: null, name: '', isDefault: false, preset: plainPreset() });
  }

  protected edit(profile: InviteProfile): void {
    this.open({ ...profile });
  }

  protected rename(name: string): void {
    this.nameError.set('');
    this.draft.update((draft) => draft && { ...draft, name });
  }

  protected markDefault(isDefault: boolean): void {
    this.draft.update((draft) => draft && { ...draft, isDefault });
  }

  protected changePreset(preset: InvitePreset): void {
    this.draft.update((draft) => draft && { ...draft, preset });
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
    const body = { name, isDefault: draft.isDefault, preset: draft.preset };
    const call = draft.id
      ? this.store.update(draft.id, body)
      : this.store.create(body);
    this.run(call, (saved) => {
      this.draft.set(null);
      this.focusAfterRender(() => this.newButton());
      return $localize`:@@profiles.saved:Perfil "${saved.name}:name:" salvo.`;
    });
  }

  protected makeDefault(profile: InviteProfile): void {
    this.run(
      this.store.update(profile.id, { isDefault: true }),
      () =>
        $localize`:@@profiles.defaultSet:"${profile.name}:name:" agora é o perfil padrão.`,
    );
  }

  protected askDelete(profile: InviteProfile): void {
    this.confirmingDelete.set(profile.id);
  }

  protected cancelDelete(): void {
    this.confirmingDelete.set(null);
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
    this.confirmingDelete.set(null);
    this.draft.set(draft);
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
