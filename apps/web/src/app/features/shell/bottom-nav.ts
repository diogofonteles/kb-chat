import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter, map } from 'rxjs';
import { UiIcon } from '@ui/icon.js';
import type { IconName } from '@ui/icons.js';

/** A tab of the phone navigation. */
export type NavTab =
  'conversations' | 'search' | 'library' | 'queue' | 'collections';

export interface NavTabItem {
  readonly id: NavTab;
  readonly label: string;
  readonly icon: IconName;
  /** A page of its own; without one the tab acts (Acervos opens the Menu). */
  readonly path: string | null;
  /** A link that also acts (Buscar: the conversation, in the search view). */
  readonly acts?: boolean;
}

/**
 * The phone navigation of v2 (KBC-125 FR-4): Conversas · Buscar · Biblioteca · Fila when
 * there is audio, Conversas · Buscar · Acervos in a collection of texts only (BR-2). It sits
 * on an opaque band with the mini player above it, so the page never shows through.
 */
@Component({
  selector: 'app-bottom-nav',
  imports: [RouterLink, UiIcon],
  template: `
    <nav aria-label="Navegação" i18n-aria-label="@@nav.label">
      <ul>
        @for (tab of tabs(); track tab.id) {
          <li>
            @if (tab.path) {
              <a
                class="tab"
                [routerLink]="tab.path"
                [class.on]="current() === tab.id"
                [attr.aria-current]="current() === tab.id ? 'page' : null"
                (click)="chosen.emit(tab.id)"
              >
                <ui-icon [name]="tab.icon" [size]="24" />
                <span>{{ tab.label }}</span>
              </a>
            } @else {
              <button
                type="button"
                class="tab"
                [class.on]="current() === tab.id"
                [attr.aria-pressed]="current() === tab.id"
                (click)="chosen.emit(tab.id)"
              >
                <ui-icon [name]="tab.icon" [size]="24" />
                <span>{{ tab.label }}</span>
              </button>
            }
          </li>
        }
      </ul>
    </nav>
  `,
  styles: `
    nav ul {
      display: flex;
      justify-content: space-around;
      margin: 0;
      /* v2 · celular: the tabs end 42 above the screen's foot (the home indicator's room). */
      padding: 0 var(--space-2) max(2.625rem, env(safe-area-inset-bottom));
      list-style: none;
    }
    li {
      flex: 1;
    }
    .tab {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-1);
      width: 100%;
      /* 24 icon, 4, the 10 label; the 10 above belongs to the target (WCAG 2.5.8). */
      padding: 0.625rem 0 0;
      border: 0;
      background: transparent;
      color: var(--color-text-muted);
      font: inherit;
      font-size: 0.625rem;
      line-height: 0.75rem;
      text-decoration: none;
      cursor: pointer;
    }
    .tab.on {
      color: var(--color-text);
      font-weight: 700;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BottomNav {
  readonly tabs = input.required<readonly NavTabItem[]>();
  /** The acting tab on (Buscar while searching): it takes the place of the route's tab. */
  readonly active = input<NavTab | null>(null);
  readonly chosen = output<NavTab>();
  private readonly router = inject(Router);
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );
  /**
   * The one tab on, the current page for assistive tech: the acting tab when there is one,
   * else the page tab of the route (Buscar and Conversas share "/", never both on).
   */
  protected readonly current = computed((): NavTab | null => {
    const active = this.active();
    if (active) return active;
    const [path = '/'] = this.url().split(/[?#]/);
    return (
      this.tabs().find((tab) => !tab.acts && tab.path && onPath(path, tab.path))
        ?.id ?? null
    );
  });
}

/** Whether `path` is the tab's page: "/" exactly, any other one with what is under it. */
function onPath(path: string, tabPath: string): boolean {
  return tabPath === '/'
    ? path === '/'
    : path === tabPath || path.startsWith(`${tabPath}/`);
}

/** The tabs every collection has: Conversas, Buscar and Acervos. */
function baseTabs(): Record<
  'conversations' | 'search' | 'collections',
  NavTabItem
> {
  return {
    conversations: {
      id: 'conversations',
      label: $localize`:@@nav.conversations:Conversas`,
      icon: 'chat',
      path: '/',
    },
    search: {
      id: 'search',
      label: $localize`:@@nav.search:Buscar`,
      icon: 'search',
      path: '/',
      acts: true,
    },
    collections: {
      id: 'collections',
      label: $localize`:@@nav.collections:Acervos`,
      icon: 'book',
      path: null,
    },
  };
}

/** The tabs under the audio rule (BR-2). */
export function navTabs(
  audio: { readonly queue: boolean; readonly library: string | null } | null,
): NavTabItem[] {
  const { conversations, search, collections } = baseTabs();
  if (!audio || !audio.library) return [conversations, search, collections];
  const library: NavTabItem = {
    id: 'library',
    // Without the library the tab opens Mídia (T14) and says so.
    label:
      audio.library === '/midia'
        ? $localize`:@@nav.media:Mídia`
        : $localize`:@@nav.library:Biblioteca`,
    icon: 'library',
    path: audio.library,
  };
  const last: NavTabItem = audio.queue
    ? {
        id: 'queue',
        label: $localize`:@@nav.queue:Fila`,
        icon: 'upload',
        path: '/fila',
      }
    : collections;
  return [conversations, search, library, last];
}
