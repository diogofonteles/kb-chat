import { Location } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter, map } from 'rxjs';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  linkedSignal,
  input,
  output,
  viewChild,
} from '@angular/core';
import { AccessRequestsStore } from '@core/auth/access-requests-store.js';
import { SessionStore } from '@core/auth/session-store.js';
import { ProcessingQueueStore } from '@features/media/queue/processing-queue-store.js';
import { SettingsStore } from '@features/settings/settings-store.js';
import { UiAvatar } from '@ui/avatar.js';
import { UiIconButton } from '@ui/button.js';
import { UiIcon } from '@ui/icon.js';
import { UiLogo } from '@ui/logo.js';
import { UiMenu, UiMenuItem } from '@ui/menu.js';
import { MediaEngine } from '@core/media/media-engine.js';
import { ClosePlayer } from '@features/media/player/close-player.js';
import { NowPlayingPanel } from '@features/media/player/now-playing-panel.js';
import { RightPanel } from './right-panel.js';
import { SignOut } from './sign-out.js';

/**
 * The v2 top bar (KBC-125, desktop): the logo, ‹ ›, Início, the global search with ⌘K and
 * the "Pesquisa com IA" shortcut in the middle; on the right "Pessoas e permissões" with the
 * pending requests (masters, BR-5) and the avatar menu (Configurações, Pessoas e
 * permissões, Ver como, Como usar, Sair). Início is filled on the conversation's home. The
 * bell (Notificações) lists what the app already knows needs the person, until KBC-133.
 */
@Component({
  selector: 'app-top-bar',
  imports: [
    RouterLink,
    UiAvatar,
    UiIcon,
    UiIconButton,
    UiLogo,
    UiMenu,
    UiMenuItem,
  ],
  templateUrl: './top-bar.html',
  styleUrl: './top-bar.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TopBar {
  protected readonly session = inject(SessionStore);
  protected readonly requests = inject(AccessRequestsStore);
  private readonly queue = inject(ProcessingQueueStore);
  private readonly settings = inject(SettingsStore);
  private readonly location = inject(Location);
  private readonly router = inject(Router);
  private readonly signOutAction = inject(SignOut);
  private readonly closer = inject(ClosePlayer);
  private readonly rightPanel = inject(RightPanel);
  /** What the player has loaded: the account menu offers "Fechar o player" then. */
  protected readonly playing = inject(MediaEngine).source;

  /** "Fechar o player" (KBC-041 AC-11): also when a source panel hides "Tocando agora". */
  protected closePlayer(): void {
    this.closer.run(this.rightPanel.content()?.component === NowPlayingPanel);
  }
  /** Enter in the global search: the free search of the collection in use (FR-2). */
  readonly searched = output<string>();
  /** The search on screen (v2 · Conversa, chat-results: the field holds what was searched). */
  readonly query = input('');
  /** What the field holds now: ✕ clears it once it holds something (v2 · Conversa). */
  protected readonly typed = linkedSignal(() => this.query());
  /** ✦: the research view, ready to type into. */
  readonly researchRequested = output();
  /** Início: the conversation's home. */
  readonly homeRequested = output();
  private readonly search =
    viewChild.required<ElementRef<HTMLInputElement>>('search');

  protected readonly me = this.session.me;
  private readonly path = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );
  /** v2 · Conversa vazia: Início is on (filled) on the conversation's home. */
  protected readonly atHome = computed(
    () => this.path().split(/[?#]/)[0] === '/',
  );
  protected readonly pendingRequests = computed(() =>
    this.session.isMaster() ? this.requests.count() : 0,
  );
  protected readonly attention = computed(() =>
    this.queue.allowed()
      ? this.queue.items().filter(({ phase }) => phase === 'attention').length
      : 0,
  );
  protected readonly noticeCount = computed(
    () => (this.pendingRequests() ? 1 : 0) + (this.attention() ? 1 : 0),
  );
  protected readonly bellLabel = computed(() => {
    const count = this.noticeCount();
    if (!count) return $localize`:@@topbar.notifications:Notificações`;
    return count === 1
      ? $localize`:@@topbar.notificationsOne:Notificações · 1 nova`
      : $localize`:@@topbar.notificationsMany:Notificações · ${count}:count: novas`;
  });
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

  protected requestsNotice(pending: number): string {
    return pending === 1
      ? $localize`:@@topbar.requestsOne:1 pedido de acesso esperando você`
      : $localize`:@@topbar.requestsMany:${pending}:count: pedidos de acesso esperando você`;
  }

  protected attentionNotice(count: number): string {
    return count === 1
      ? $localize`:@@topbar.attentionOne:1 áudio precisa de atenção na Fila`
      : $localize`:@@topbar.attentionMany:${count}:count: áudios precisam de atenção na Fila`;
  }

  /** ⌘K / Ctrl K (FR-2). */
  focusSearch(): void {
    const field = this.search().nativeElement;
    field.focus();
    field.select();
  }

  /** ✕: empties the field and keeps the focus there. */
  protected clear(): void {
    const field = this.search().nativeElement;
    field.value = '';
    this.typed.set('');
    field.focus();
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
