import { httpResource } from '@angular/common/http';
import { UiButton, UiCover, UiIcon } from '@ui/index.js';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  myMediaBookmarkListSchema,
  type MyMediaBookmark,
} from '@kb-chat/contracts';
import { formatClock } from '@kb-chat/player-core';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { MY_BOOKMARKS_URL } from '@core/media/bookmarks-api.js';
import { SessionStore } from '@core/auth/session-store.js';
import { hasLibrary } from './library/library-access.js';
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
  imports: [RouterLink, MovedBookmarksNotice, UiButton, UiCover, UiIcon],
  template: `
    <section class="page" aria-labelledby="my-bookmarks-title">
      <div class="top">
        @if (backToLibrary()) {
          <a class="back" routerLink="/biblioteca" i18n="@@library.back"
            >← Biblioteca</a
          >
        } @else {
          <a class="back" routerLink="/midia" i18n="@@media.back">← Mídia</a>
        }
      </div>
      <header class="ui-page-header head">
        <ui-cover
          class="art"
          icon="bookmarkFill"
          from="#5b3fd1"
          to="#9ad1ff"
          [size]="208"
        />
        <div class="head-text">
          <p class="ui-page-header__kicker" i18n="@@bookmarks.kicker">Lista</p>
          <h2
            id="my-bookmarks-title"
            class="ui-page-header__title"
            i18n="@@bookmarks.mine"
          >
            Meus marcadores
          </h2>
          @if (summary(); as text) {
            <p class="ui-page-header__meta">{{ text }}</p>
          }
        </div>
      </header>
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
              <p class="empty-text" i18n="@@bookmarks.mineEmpty">
                Você ainda não marcou nenhum trecho. No player, use 🔖 ou a
                tecla B para marcar enquanto ouve.
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
            </div>
            <ol class="list">
              @for (bookmark of items(); track bookmark.id; let n = $index) {
                <li class="item">
                  <span class="num" aria-hidden="true">{{ n + 1 }}</span>
                  <a
                    class="open"
                    [routerLink]="['/midia', bookmark.mediaId]"
                    [state]="stateOf(bookmark)"
                    [attr.aria-label]="openLabel(bookmark)"
                  >
                    <ui-cover [title]="bookmark.mediaTitle" [size]="40" />
                    <span class="title">{{ bookmark.mediaTitle }}</span>
                    <span class="time">{{ clock(bookmark.positionMs) }}</span>
                  </a>
                  <p class="note" [class.none]="bookmark.note === null">
                    {{ bookmark.note ?? noNote }}
                  </p>
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
    </section>
  `,
  styleUrl: './my-bookmarks-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MyBookmarksPage {
  /** "← Biblioteca" for who has the library (KBC-051), "← Mídia" otherwise. */
  private readonly session = inject(SessionStore);
  protected readonly backToLibrary = computed(() => hasLibrary(this.session));
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

  protected clock(ms: number): string {
    return formatClock(ms);
  }

  protected stateOf(bookmark: MyMediaBookmark): PlayFromState {
    return { playFromMs: bookmark.positionMs };
  }

  protected openLabel(bookmark: MyMediaBookmark): string {
    return $localize`:@@bookmarks.openFrom:${bookmark.mediaTitle}:title: ${formatClock(bookmark.positionMs)}:time:, tocar daqui`;
  }
}
