import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  myMediaBookmarkListSchema,
  type MyMediaBookmark,
} from '@kb-chat/contracts';
import { formatClock } from '@kb-chat/player-core';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { MY_BOOKMARKS_URL } from '@core/media/bookmarks-api.js';

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
  imports: [RouterLink],
  template: `
    <section class="page" aria-labelledby="my-bookmarks-title">
      <a class="back" routerLink="/midia" i18n="@@media.back">← Mídia</a>
      <h2 id="my-bookmarks-title" i18n="@@bookmarks.mine">Meus marcadores</h2>

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
          <p class="empty" i18n="@@bookmarks.mineEmpty">
            Você ainda não marcou nenhum trecho. No player, use 🔖 ou a tecla B
            para marcar enquanto ouve.
          </p>
        } @else {
          <ul class="list">
            @for (bookmark of items(); track bookmark.id) {
              <li class="item">
                <a
                  class="open"
                  [routerLink]="['/midia', bookmark.mediaId]"
                  [state]="stateOf(bookmark)"
                  [attr.aria-label]="openLabel(bookmark)"
                >
                  <span class="title">{{ bookmark.mediaTitle }}</span>
                  <span class="time">{{ clock(bookmark.positionMs) }}</span>
                </a>
                <p class="note" [class.none]="bookmark.note === null">
                  {{ bookmark.note ?? noNote }}
                </p>
              </li>
            }
          </ul>
        }
      } @else {
        <p class="loading" aria-busy="true" i18n="@@bookmarks.loading">
          Carregando marcadores…
        </p>
      }
    </section>
  `,
  styleUrl: './my-bookmarks-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MyBookmarksPage {
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
