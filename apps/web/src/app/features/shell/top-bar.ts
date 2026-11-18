import { Location } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { AccessRequestsStore } from '@core/auth/access-requests-store.js';
import { SessionStore } from '@core/auth/session-store.js';
import { SettingsStore } from '@features/settings/settings-store.js';
import { UiAvatar } from '@ui/avatar.js';
import { UiIconButton } from '@ui/button.js';
import { UiIcon } from '@ui/icon.js';
import { UiLogo } from '@ui/logo.js';
import { UiMenu, UiMenuItem } from '@ui/menu.js';
import { SignOut } from './sign-out.js';

/**
 * The v2 top bar (KBC-125, desktop): the logo, ‹ ›, Início, the global search with ⌘K and
 * the "Pesquisa com IA" shortcut in the middle; on the right "Pessoas e permissões" with the
 * pending requests (masters, BR-5) and the avatar menu (Configurações, Pessoas e
 * permissões, Ver como, Como usar, Sair). The bell is KBC-133 and does not show yet.
 */
@Component({
  selector: 'app-top-bar',
  imports: [UiAvatar, UiIcon, UiIconButton, UiLogo, UiMenu, UiMenuItem],
  templateUrl: './top-bar.html',
  styleUrl: './top-bar.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TopBar {
  protected readonly session = inject(SessionStore);
  protected readonly requests = inject(AccessRequestsStore);
  private readonly settings = inject(SettingsStore);
  private readonly location = inject(Location);
  private readonly signOutAction = inject(SignOut);
  /** Enter in the global search: the free search of the collection in use (FR-2). */
  readonly searched = output<string>();
  /** The search on screen (v2 · Conversa, chat-results: the field holds what was searched). */
  readonly query = input('');
  /** ✦: the research view, ready to type into. */
  readonly researchRequested = output();
  /** Início: the conversation's home. */
  readonly homeRequested = output();
  private readonly search =
    viewChild.required<ElementRef<HTMLInputElement>>('search');

  protected readonly me = this.session.me;
  protected readonly accountLabel = computed(() => {
    const me = this.me();
    const who = me ? me.name || me.email : '';
    return $localize`:@@topbar.account:Conta de ${who}:name:`;
  });
  protected readonly peopleLabel = computed(() => {
    const pending = this.requests.count();
    if (!pending) return $localize`:@@sidebar.people:Pessoas e permissões`;
    return pending === 1
      ? $localize`:@@topbar.peoplePendingOne:Pessoas e permissões · 1 solicitação pendente`
      : $localize`:@@topbar.peoplePendingMany:Pessoas e permissões · ${pending}:count: solicitações pendentes`;
  });

  /** ⌘K / Ctrl K (FR-2). */
  focusSearch(): void {
    const field = this.search().nativeElement;
    field.focus();
    field.select();
  }

  protected back(): void {
    this.location.back();
  }

  protected forward(): void {
    this.location.forward();
  }

  protected submit(event: Event): void {
    event.preventDefault();
    const field = this.search().nativeElement;
    const query = field.value.trim();
    if (query) this.searched.emit(query);
  }

  protected openSettings(): void {
    this.settings.openSettings();
  }

  /** "Pessoas e permissões" and "Ver como" (who acts as whom is chosen there, KBC-060). */
  protected openPeople(): void {
    this.settings.openSettings('people');
  }

  protected signOut(): void {
    this.signOutAction.run();
  }
}
