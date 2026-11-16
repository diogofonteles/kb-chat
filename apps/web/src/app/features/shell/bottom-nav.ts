import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
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
  imports: [RouterLink, RouterLinkActive, UiIcon],
  template: `
    <nav aria-label="Navegação" i18n-aria-label="@@nav.label">
      <ul>
        @for (tab of tabs(); track tab.id) {
          <li>
            @if (tab.path) {
              <a
                class="tab"
                [routerLink]="tab.path"
                [routerLinkActive]="tab.acts ? [] : ['on']"
                [ariaCurrentWhenActive]="tab.acts ? false : 'page'"
                [class.on]="active() === tab.id"
                [routerLinkActiveOptions]="{ exact: tab.path === '/' }"
                (click)="chosen.emit(tab.id)"
              >
                <ui-icon [name]="tab.icon" [size]="24" />
                <span>{{ tab.label }}</span>
              </a>
            } @else {
              <button
                type="button"
                class="tab"
                [class.on]="active() === tab.id"
                [attr.aria-pressed]="active() === tab.id"
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
      padding: 0.375rem var(--space-2)
        calc(0.375rem + env(safe-area-inset-bottom));
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
      min-height: 3.25rem;
      padding: var(--space-1) 0;
      border: 0;
      background: transparent;
      color: var(--color-text-muted);
      font: inherit;
      font-size: 0.6875rem;
      text-decoration: none;
      cursor: pointer;
    }
    .tab.on,
    .tab[aria-current] {
      color: var(--color-text);
      font-weight: 700;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BottomNav {
  readonly tabs = input.required<readonly NavTabItem[]>();
  /** The acting tab on (Buscar while searching). */
  readonly active = input<NavTab | null>(null);
  readonly chosen = output<NavTab>();
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
