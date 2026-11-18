import { httpResource } from '@angular/common/http';
import { UiButton, UiCover, UiIcon, UiIconButton } from '@ui/index.js';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  myMediaBookmarkListSchema,
  type MyMediaBookmark,
} from '@kb-chat/contracts';
import { formatClock } from '@kb-chat/player-core';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { BookmarksApi, MY_BOOKMARKS_URL } from '@core/media/bookmarks-api.js';
import { SessionStore } from '@core/auth/session-store.js';
import { hasLibrary } from './library/library-access.js';
import { MenuButton, type MenuOption } from './menu-button.js';
import { MovedBookmarksNotice } from './track-edit/moved-bookmarks-notice.js';

/** What the player page reads to play from a bookmark (navigation state, not the URL). */
export interface PlayFromState {
  readonly playFromMs: number;
}

/**
 * "Meus marcadores" (screens.md T14/T15, KBC-042 FR-5): the person's bookmarks in every
 * media they still see, newest first; one click opens the media and plays from there.
 */
@Component({
  selector: 'app-my-bookmarks-page',
  imports: [
    RouterLink,
    MenuButton,
    MovedBookmarksNotice,
    UiButton,
    UiCover,
    UiIcon,
    UiIconButton,
  ],
  template: `
    <section class="page" aria-labelledby="my-bookmarks-title">
      <header class="ui-page-header head">
        <!-- The phone's head (queue.js qmHead): ‹ and the title. -->
        <a
          class="phone-back"
          [routerLink]="backToLibrary() ? '/biblioteca' : '/midia'"
          [attr.aria-label]="backLabel()"
        >
          <ui-icon name="chevLeft" [size]="26" />
        </a>
        <ui-cover
          class="art"
          icon="bookmarkFill"
          from="#5b3fd1"
          to="#9ad1ff"
          [size]="208"
        />
        <div class="head-text">
          <p class="ui-page-header__kicker" i18n="@@bookmarks.kicker">Lista</p>
          <h1
            id="my-bookmarks-title"
            class="ui-page-header__title"
            i18n="@@bookmarks.mine"
          >
            Meus marcadores
          </h1>
          @if (summary(); as text) {
            <p class="ui-page-header__meta">{{ text }}</p>
          }
        </div>
      </header>
      @if (items().length > 0) {
        <!-- The action bar (Liked Songs): play the first one, search, the order. -->
        <div class="ui-action-bar actions">
          <span class="phone-summary" aria-hidden="true">{{ summary() }}</span>
          <button
            uiIconButton="play"
            type="button"
            class="play"
            [size]="56"
            [attr.aria-label]="playLabel()"
            (click)="playFirst()"
          >
            <ui-icon name="play" [size]="24" />
          </button>
          <span class="spacer"></span>
          @if (searchOpen()) {
            <span class="search-pill">
              <ui-icon name="search" [size]="18" />
              <input
                #searchField
                type="search"
                autocomplete="off"
                aria-label="Buscar nos marcadores"
                i18n-aria-label="@@bookmarks.search"
                placeholder="Buscar nos marcadores"
                i18n-placeholder="@@bookmarks.search"
                [value]="query()"
                (input)="query.set($any($event.target).value)"
                (keydown.escape)="closeSearch()"
              />
            </span>
          }
          <button
            uiIconButton
            type="button"
            class="search-button"
            aria-label="Buscar nos marcadores"
            i18n-aria-label="@@bookmarks.search"
            [attr.aria-expanded]="searchOpen()"
            (click)="toggleSearch()"
          >
            <ui-icon name="search" [size]="20" />
          </button>
          <app-menu-button
            class="sort"
            kind="choice"
            [label]="sortLabel()"
            menuLabel="Ordenar por"
            i18n-menuLabel="@@bookmarks.sortMenu"
            align="end"
            [options]="sortOptions()"
            (chosen)="chooseSort($event)"
          >
            <span class="sort-face"
              >{{ sortShown() }}<ui-icon name="list" [size]="18"
            /></span>
          </app-menu-button>
        </div>
      }
      <div class="body">
        <app-moved-bookmarks-notice />

        @if (loadError()) {
          <div class="notice" role="alert">
            <p>{{ loadError() }}</p>
            <button
              type="button"
              class="secondary"
              (click)="list.reload()"
              i18n="@@media.reload"
            >
              Tentar de novo
            </button>
          </div>
        } @else if (list.hasValue()) {
          @if (items().length === 0) {
            <div class="empty">
              <ui-icon class="empty-icon" name="bookmark" [size]="28" />
              <p class="empty-title" i18n="@@bookmarks.mineEmptyTitle">
                Seus marcadores aparecem aqui
              </p>
              <p class="empty-text" i18n="@@bookmarks.mineEmptyV2">
                Você ainda não marcou nenhum trecho. No player, use o marcador
                ou a tecla B para marcar enquanto ouve.
              </p>
              @if (backToLibrary()) {
                <a
                  uiButton="white"
                  routerLink="/biblioteca"
                  i18n="@@queue.toLibrary"
                  >Ir para a Biblioteca</a
                >
              } @else {
                <a
                  uiButton="white"
                  routerLink="/midia"
                  i18n="@@media.backToList"
                  >Voltar à Mídia</a
                >
              }
            </div>
          } @else {
            <div class="columns" aria-hidden="true">
              <span class="num">#</span>
              <span i18n="@@bookmarks.col.media">Áudio</span>
              <span i18n="@@bookmarks.col.time">Tempo</span>
              <span i18n="@@bookmarks.col.note">Nota</span>
              <span></span>
            </div>
            @if (shown().length === 0) {
              <p class="none-found" role="status" i18n="@@bookmarks.noneFound">
                Nenhum marcador com essas palavras.
              </p>
            }
            <ol class="list">
              @for (bookmark of shown(); track bookmark.id; let n = $index) {
                <li class="item">
                  <span class="num" aria-hidden="true">{{ n + 1 }}</span>
                  <a
                    class="open"
                    [routerLink]="['/midia', bookmark.mediaId]"
                    [state]="stateOf(bookmark)"
                    [attr.aria-label]="openLabel(bookmark)"
                  >
                    <ui-cover
                      class="cover"
                      [title]="bookmark.mediaTitle"
                      [size]="40"
                    />
                    <span class="title">{{ bookmark.mediaTitle }}</span>
                  </a>
                  <span class="when" aria-hidden="true">
                    <span class="time">{{ clock(bookmark.positionMs) }}</span>
                  </span>
                  <p class="note" [class.none]="bookmark.note === null">
                    {{ bookmark.note ?? noNote }}
                  </p>
                  <app-menu-button
                    class="row-more"
                    [label]="moreLabel(bookmark)"
                    align="end"
                    [options]="rowOptions"
                    (chosen)="chooseRow(bookmark, $event)"
                  >
                    <ui-icon name="more" [size]="18" />
                  </app-menu-button>
                </li>
              }
            </ol>
          }
        } @else {
          <p class="loading" aria-busy="true" i18n="@@bookmarks.loading">
            Carregando marcadores…
          </p>
        }
      </div>
      <p class="visually-hidden" aria-live="polite">{{ said() }}</p>
    </section>
  `,
  styleUrl: './my-bookmarks-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MyBookmarksPage {
  /** "← Biblioteca" for who has the library (KBC-051), "← Mídia" otherwise. */
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);
  private readonly api = inject(BookmarksApi);
  private readonly injector = inject(Injector);
  private readonly searchField =
    viewChild<ElementRef<HTMLInputElement>>('searchField');
  protected readonly backToLibrary = computed(() => hasLibrary(this.session));
  protected readonly backLabel = computed(() =>
    this.backToLibrary()
      ? $localize`:@@library.back:← Biblioteca`
      : $localize`:@@media.back:← Mídia`,
  );
  protected readonly list = httpResource(() => MY_BOOKMARKS_URL, {
    parse: (body) => myMediaBookmarkListSchema.parse(body).items,
  });
  protected readonly items = computed(() =>
    this.list.hasValue() ? this.list.value() : [],
  );
  protected readonly loadError = computed(() => {
    const err = this.list.error();
    return err ? errorMessage(toUiErrorCode(err)) : '';
  });
  protected readonly noNote = $localize`:@@bookmarks.noNote:Sem nota`;
  /** "3 marcadores em 1 áudio", under the title. */
  protected readonly summary = computed(() => {
    if (!this.list.hasValue()) return '';
    const items = this.items();
    if (items.length === 0)
      return $localize`:@@bookmarks.summaryNone:Nenhum marcador ainda`;
    const media = new Set(items.map((one) => one.mediaId)).size;
    const marks =
      items.length === 1
        ? $localize`:@@bookmarks.summaryOne:1 marcador`
        : $localize`:@@bookmarks.summaryMany:${items.length}:count: marcadores`;
    return media === 1
      ? $localize`:@@bookmarks.summaryInOne:${marks}:marks: em 1 áudio`
      : $localize`:@@bookmarks.summaryInMany:${marks}:marks: em ${media}:media: áudios`;
  });

  /** The order: newest first (the API's), or by audio and position. */
  protected readonly sort = signal<BookmarkSort>('recent');
  protected readonly sortOptions = computed((): readonly MenuOption[] =>
    (Object.keys(SORT_LABELS) as BookmarkSort[]).map((id) => ({
      id,
      label: SORT_LABELS[id](),
      checked: this.sort() === id,
    })),
  );
  protected readonly sortShown = computed(() => SORT_LABELS[this.sort()]());
  protected readonly sortLabel = computed(
    () =>
      $localize`:@@bookmarks.sortLabel:Ordenar marcadores: ${this.sortShown()}:order:`,
  );
  /** The search field over the list: by the audio's title or the note. */
  protected readonly searchOpen = signal(false);
  protected readonly query = signal('');
  protected readonly shown = computed(() => {
    const words = fold(this.query().trim());
    const sorted =
      this.sort() === 'recent'
        ? this.items()
        : [...this.items()].sort(
            (a, b) =>
              a.mediaTitle.localeCompare(b.mediaTitle, 'pt-BR') ||
              a.mediaId.localeCompare(b.mediaId) ||
              a.positionMs - b.positionMs,
          );
    if (!words) return sorted;
    return sorted.filter((one) =>
      fold(`${one.mediaTitle} ${one.note ?? ''}`).includes(words),
    );
  });
  protected readonly playLabel = computed(() => {
    const first = this.shown()[0];
    return first
      ? $localize`:@@bookmarks.playFirst:Tocar ${first.mediaTitle}:title: de ${formatClock(first.positionMs)}:time:`
      : $localize`:@@bookmarks.play:Tocar`;
  });
  protected readonly rowOptions: readonly MenuOption[] = [
    {
      id: 'play',
      icon: 'play',
      label: $localize`:@@bookmarks.row.play:Tocar daqui`,
    },
    {
      id: 'remove',
      icon: 'trash',
      label: $localize`:@@bookmarks.row.remove:Apagar marcador`,
      danger: true,
      divider: true,
    },
  ];
  protected readonly said = signal('');

  protected clock(ms: number): string {
    return formatClock(ms);
  }

  protected stateOf(bookmark: MyMediaBookmark): PlayFromState {
    return { playFromMs: bookmark.positionMs };
  }

  protected openLabel(bookmark: MyMediaBookmark): string {
    return $localize`:@@bookmarks.openFrom:${bookmark.mediaTitle}:title: ${formatClock(bookmark.positionMs)}:time:, tocar daqui`;
  }

  protected moreLabel(bookmark: MyMediaBookmark): string {
    return $localize`:@@bookmarks.row.more:Mais opções do marcador em ${formatClock(bookmark.positionMs)}:time: de ${bookmark.mediaTitle}:title:`;
  }

  /** The green play: the first bookmark shown, from its time. */
  protected playFirst(): void {
    const first = this.shown()[0];
    if (first) this.play(first);
  }

  protected chooseSort(id: string): void {
    if (id === 'recent' || id === 'media') this.sort.set(id);
  }

  protected toggleSearch(): void {
    if (this.searchOpen()) {
      this.closeSearch();
      return;
    }
    this.searchOpen.set(true);
    afterNextRender(() => this.searchField()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  protected closeSearch(): void {
    this.searchOpen.set(false);
    this.query.set('');
  }

  protected chooseRow(bookmark: MyMediaBookmark, id: string): void {
    if (id === 'play') this.play(bookmark);
    if (id === 'remove')
      this.api.remove(bookmark.mediaId, bookmark.id).subscribe({
        next: () => {
          this.said.set(
            $localize`:@@bookmarks.removedOne:Marcador em ${formatClock(bookmark.positionMs)}:time: apagado.`,
          );
          this.list.reload();
        },
        error: (err: unknown) =>
          this.said.set(errorMessage(toUiErrorCode(err))),
      });
  }

  private play(bookmark: MyMediaBookmark): void {
    void this.router.navigate(['/midia', bookmark.mediaId], {
      state: this.stateOf(bookmark),
    });
  }
}

type BookmarkSort = 'recent' | 'media';

const SORT_LABELS: Record<BookmarkSort, () => string> = {
  recent: () => $localize`:@@bookmarks.sort.recent:Mais recentes`,
  media: () => $localize`:@@bookmarks.sort.media:Por áudio`,
};

/** Lower case without accents, so "sessao" finds "sessão". */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}
