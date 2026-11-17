import { DOCUMENT, NgTemplateOutlet } from '@angular/common';
import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  libraryHomeSchema,
  mediaItemSchema,
  mediaListSchema,
  mediaTranscriptSchema,
  type TranscriptSegment,
} from '@kb-chat/contracts';
import { minuteLink } from '@kb-chat/player-core';
import { libraryHomeUrlOf } from '@core/media/library-api.js';
import { MediaEngine } from '@core/media/media-engine.js';
import { PlayerAnnouncer } from '@core/media/player-announcer.js';
import {
  mediaListUrl,
  mediaPagePath,
  mediaTranscriptUrl,
  mediaUrl,
} from '@core/media/media-api.js';
import { RightPanel } from '@features/shell/right-panel.js';
import { BookmarksStore } from '@core/media/bookmarks-store.js';
import { ChatStore } from '@features/chat/chat-store.js';
import {
  UiAvatar,
  UiCover,
  UiIcon,
  UiIconButton,
  UiTablist,
  coverGradient,
} from '@ui/index.js';
import { PlayNow } from '../library/play-now.js';
import { MenuButton, type MenuOption } from '../menu-button.js';
import { ClosePlayer } from './close-player.js';

/** The line heard at `ms` and the one before it: what the transcript card shows. */
export function linesAt(
  segments: readonly TranscriptSegment[],
  ms: number,
): { readonly before: string; readonly now: string } {
  let at = -1;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (!segment || segment.startMs > ms) break;
    if (!segment.restricted) at = index;
  }
  if (at < 0) return { before: '', now: '' };
  const previous = segments
    .slice(0, at)
    .reverse()
    .find((one) => !one.restricted);
  return {
    before: previous?.text.trim() ?? '',
    now: segments[at]?.text.trim() ?? '',
  };
}

/** What the panel shows: "Tocando agora" (Sobre), the Fila or Ouvidas recentemente. */
export type NowPlayingView = 'now' | 'fila' | 'ouvidas';

/**
 * "Tocando agora" (KBC-129 FR-2, v2 · Mídia — Player): what plays, in the shell's right
 * panel beside any screen. The cover, the title and author with Compartilhar (the link of
 * this minute, as the player's) and the mark, the transcript card with the line before and
 * the line heard now, and "Sobre a autora". Only data that exists (BR-4): no "Seguir"
 * (KBC-135, no API). Opened by the player bar's transcript button; its Fila button opens it
 * on the v2 tabs Sobre · Fila · Ouvidas, where the Fila is "Continuar ouvindo" (the app
 * has no listening queue) and Ouvidas the library's recently played.
 */
@Component({
  selector: 'app-now-playing-panel',
  imports: [
    MenuButton,
    NgTemplateOutlet,
    RouterLink,
    UiAvatar,
    UiCover,
    UiIcon,
    UiIconButton,
    UiTablist,
  ],
  template: `
    <section class="now" aria-labelledby="now-playing-title">
      @if (tabbed()) {
        <!-- v2 · Fila: Sobre · Fila · Ouvidas with the green underline, and ×. -->
        <div class="tabs-row">
          <h2
            id="now-playing-title"
            class="visually-hidden"
            i18n="@@nowPlaying.title"
          >
            Tocando agora
          </h2>
          <div
            class="tabs"
            role="tablist"
            uiTablist
            aria-labelledby="now-playing-title"
          >
            @for (tab of tabs; track tab.id) {
              <button
                type="button"
                role="tab"
                class="tab"
                [id]="'now-playing-tab-' + tab.id"
                aria-controls="now-playing-view"
                [attr.aria-selected]="view() === tab.id"
                [tabIndex]="view() === tab.id ? 0 : -1"
                (click)="view.set(tab.id)"
              >
                {{ tab.label }}
              </button>
            }
          </div>
          <button
            uiIconButton
            type="button"
            class="close"
            aria-label="Fechar o painel"
            i18n-aria-label="@@nowPlaying.closePanel"
            (click)="panel.close()"
          >
            <ui-icon name="close" [size]="20" />
          </button>
        </div>
      } @else {
        <!-- v2 · Tocando agora: the collection's name, ⋯ and ⤢ (the player page). -->
        <div class="bar">
          <h2
            id="now-playing-title"
            class="visually-hidden"
            i18n="@@nowPlaying.title"
          >
            Tocando agora
          </h2>
          <p class="label" aria-hidden="true">{{ collectionTitle() }}</p>
          <app-menu-button
            class="more"
            label="Mais opções de Tocando agora"
            i18n-label="@@nowPlaying.more"
            [options]="moreOptions()"
            (chosen)="chooseMore($event)"
          >
            <ui-icon name="more" [size]="20" />
          </app-menu-button>
          @if (source()) {
            <a
              uiIconButton
              class="open"
              [routerLink]="pagePath()"
              aria-label="Abrir o player"
              i18n-aria-label="@@nowPlaying.open"
            >
              <ui-icon name="expand" [size]="18" />
            </a>
          }
        </div>
      }
      <div
        id="now-playing-view"
        class="view"
        [attr.role]="tabbed() ? 'tabpanel' : null"
        [attr.aria-labelledby]="tabbed() ? 'now-playing-tab-' + view() : null"
      >
        @switch (view()) {
          @case ('fila') {
            <h3 class="list-head" i18n="@@nowPlaying.title">Tocando agora</h3>
            @if (source(); as playing) {
              <a class="item current" [routerLink]="pagePath()">
                <ui-cover [title]="playing.title" [size]="48" />
                <span class="item-text">
                  <span class="item-title">{{ playing.title }}</span>
                  <span class="item-meta">{{ authorName() }}</span>
                </span>
              </a>
            } @else {
              <p class="idle" i18n="@@nowPlaying.idle">Nada tocando agora.</p>
            }
            <!-- No listening queue in the app: "A seguir" is what the person has to go on with. -->
            <h3 class="list-head" i18n="@@nowPlaying.upNext">
              Continuar ouvindo
            </h3>
            <ng-container
              [ngTemplateOutlet]="items"
              [ngTemplateOutletContext]="{ list: upNext(), empty: noUpNext }"
            />
          }
          @case ('ouvidas') {
            <h3 class="list-head" i18n="@@nowPlaying.recent">
              Ouvidas recentemente
            </h3>
            <ng-container
              [ngTemplateOutlet]="items"
              [ngTemplateOutletContext]="{ list: recent(), empty: noRecent }"
            />
          }
          @default {
            <ng-container [ngTemplateOutlet]="about" />
          }
        }
      </div>
    </section>

    <ng-template #items let-list="list" let-empty="empty">
      @if (home.isLoading()) {
        <p class="idle" i18n="@@nowPlaying.loading">Carregando…</p>
      } @else if (home.error()) {
        <p class="idle" role="alert" i18n="@@nowPlaying.listFailed">
          Não consegui carregar esta lista.
        </p>
      } @else {
        <ul class="items">
          @for (item of list; track item.id) {
            <li>
              <button
                type="button"
                class="item"
                [attr.aria-label]="playItemLabel(item.title)"
                (click)="playNow.play(item)"
              >
                <ui-cover [title]="item.title" [size]="48" />
                <span class="item-text">
                  <span class="item-title">{{ item.title }}</span>
                  <span class="item-meta">{{
                    item.author?.name ?? othersLabel
                  }}</span>
                </span>
              </button>
            </li>
          } @empty {
            <li class="idle">{{ empty }}</li>
          }
        </ul>
      }
    </ng-template>

    <ng-template #about>
      @if (source(); as playing) {
        <ui-cover class="art" [title]="playing.title" [size]="308" />
        <div class="head">
          <div class="names">
            <a class="title" [routerLink]="pagePath()">{{ playing.title }}</a>
            <p class="author">{{ authorName() }}</p>
          </div>
          <button
            uiIconButton
            type="button"
            class="share"
            aria-label="Compartilhar"
            i18n-aria-label="@@nowPlaying.share"
            (click)="share()"
          >
            <ui-icon name="share" [size]="22" />
          </button>
          <button
            uiIconButton
            type="button"
            class="mark"
            [class.on]="marked()"
            aria-label="Marcar este trecho"
            i18n-aria-label="@@player.mark"
            [disabled]="!canMark()"
            (click)="mark()"
          >
            <ui-icon
              [name]="marked() ? 'bookmarkFill' : 'bookmark'"
              [size]="22"
            />
          </button>
        </div>
        @if (lines(); as shown) {
          <div class="card" [style.--card-tint]="tint()">
            <div class="card-head">
              <p class="card-title" i18n="@@nowPlaying.transcript">
                Transcrição
              </p>
              <a
                uiIconButton
                class="card-open"
                [routerLink]="pagePath()"
                aria-label="Abrir a transcrição no player"
                i18n-aria-label="@@nowPlaying.openTranscript"
              >
                <ui-icon name="expand" [size]="16" />
              </a>
            </div>
            @if (shown.now) {
              @if (shown.before) {
                <p class="before">{{ shown.before }}</p>
              }
              <p class="line" aria-live="off">{{ shown.now }}</p>
            } @else {
              <p class="before" i18n="@@nowPlaying.noLine">
                A fala aparece aqui quando o áudio chega nela.
              </p>
            }
          </div>
        }
        @if (author(); as person) {
          <section class="about" aria-labelledby="now-playing-author">
            <h3 id="now-playing-author" i18n="@@nowPlaying.aboutAuthor">
              Sobre a autora
            </h3>
            <div class="person">
              <ui-avatar [name]="person.name" [size]="48" />
              <div>
                <p class="person-name">{{ person.name }}</p>
                @if (authorCount(); as count) {
                  <p class="person-meta">{{ count }}</p>
                }
              </div>
            </div>
          </section>
        }
      } @else {
        <p class="idle" i18n="@@nowPlaying.idle">Nada tocando agora.</p>
      }
    </ng-template>
  `,
  styleUrl: './now-playing-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NowPlayingPanel {
  /** Where it opens: "now" without tabs (the transcript button), else on the tabs. */
  readonly start = input<NowPlayingView>('now');
  protected readonly tabbed = computed(() => this.start() !== 'now');
  protected readonly view = linkedSignal<NowPlayingView>(() => this.start());
  protected readonly tabs: readonly {
    readonly id: NowPlayingView;
    readonly label: string;
  }[] = [
    { id: 'now', label: $localize`:@@nowPlaying.tabAbout:Sobre` },
    { id: 'fila', label: $localize`:@@nowPlaying.tabQueue:Fila` },
    { id: 'ouvidas', label: $localize`:@@nowPlaying.tabRecent:Ouvidas` },
  ];
  protected readonly othersLabel = $localize`:@@authorship.others:Outros autores`;
  protected readonly noUpNext = $localize`:@@nowPlaying.noUpNext:Nada para continuar ouvindo.`;
  protected readonly noRecent = $localize`:@@nowPlaying.noRecent:Nada ouvido ainda.`;
  protected readonly playNow = inject(PlayNow);
  private readonly announcer = inject(PlayerAnnouncer);
  private readonly document = inject(DOCUMENT);
  private readonly engine = inject(MediaEngine);
  protected readonly panel = inject(RightPanel);
  private readonly closer = inject(ClosePlayer);
  private readonly bookmarks = inject(BookmarksStore);
  /** The layout's store, for the collection's name (absent in a bare test host). */
  private readonly chat = inject(ChatStore, { optional: true });
  protected readonly source = this.engine.source;
  protected readonly canMark = computed(
    () => this.bookmarks.mediaId() === this.source()?.id,
  );
  protected readonly marked = computed(
    () => this.canMark() && this.bookmarks.bookmarks().length > 0,
  );
  /** The transcript card in the cover's colour (v2 · Tocando agora). */
  protected readonly tint = computed(() => {
    const playing = this.source();
    return playing ? coverGradient(playing.title)[0] : null;
  });
  /** The header names the collection of what plays, as v2 draws it. */
  private readonly collectionName = computed(() => {
    const slug = this.media()?.topic;
    const found = slug
      ? this.chat?.topicList().find((topic) => topic.slug === slug)
      : undefined;
    return found?.title ?? null;
  });
  protected readonly collectionTitle = computed(
    () => this.collectionName() ?? $localize`:@@nowPlaying.title:Tocando agora`,
  );
  protected readonly moreOptions = computed<readonly MenuOption[]>(() => [
    {
      id: 'close-panel',
      icon: 'close',
      label: $localize`:@@nowPlaying.close:Fechar Tocando agora`,
    },
    ...(this.source()
      ? [
          {
            id: 'close-player',
            icon: 'xcircle' as const,
            label: $localize`:@@mini.close:Fechar o player`,
            divider: true,
          },
        ]
      : []),
  ]);

  protected chooseMore(id: string): void {
    if (id === 'close-panel') this.panel.close();
    if (id === 'close-player') this.closer.run(true);
  }

  protected mark(): void {
    this.bookmarks.mark();
    this.bookmarks.editNote(null);
  }
  protected readonly pagePath = computed(() => {
    const playing = this.source();
    return playing ? mediaPagePath(playing.id) : '/';
  });
  private readonly item = httpResource(
    () => {
      const playing = this.source();
      return playing ? mediaUrl(playing.id) : undefined;
    },
    { parse: (body) => mediaItemSchema.parse(body) },
  );
  private readonly media = computed(() =>
    this.item.hasValue() ? this.item.value() : null,
  );
  private readonly transcript = httpResource(
    () => {
      const media = this.media();
      const version =
        media?.status === 'ready' ? media.transcription.version : null;
      return media && version !== null
        ? { url: mediaTranscriptUrl(media.id), params: { v: version } }
        : undefined;
    },
    { parse: (body) => mediaTranscriptSchema.parse(body) },
  );
  /** Other media of the collection, to count the author's. */
  private readonly collection = httpResource(
    () => {
      const media = this.media();
      return media?.author ? mediaListUrl(media.topic) : undefined;
    },
    { parse: (body) => mediaListSchema.parse(body).items },
  );
  protected readonly author = computed(() => this.media()?.author ?? null);
  protected readonly authorName = computed(
    () => this.author()?.name ?? $localize`:@@authorship.others:Outros autores`,
  );
  protected readonly authorCount = computed(() => {
    const author = this.author();
    if (!author || !this.collection.hasValue()) return '';
    const count = this.collection
      .value()
      .filter((one) => one.author?.slug === author.slug).length;
    // v2 · Tocando agora: "5 áudios em Alquimia Prática" (the collection by name).
    const where = this.collectionName();
    if (!where)
      return count === 1
        ? $localize`:@@nowPlaying.oneAudio:1 áudio neste acervo`
        : $localize`:@@nowPlaying.audios:${count}:count: áudios neste acervo`;
    return count === 1
      ? $localize`:@@nowPlaying.oneAudioIn:1 áudio em ${where}:collection:`
      : $localize`:@@nowPlaying.audiosIn:${count}:count: áudios em ${where}:collection:`;
  });
  /** The card shows once there is a transcript; the line follows the playback. */
  protected readonly lines = computed(() => {
    if (!this.transcript.hasValue()) return null;
    return linesAt(
      this.transcript.value().segments,
      this.engine.playback().currentMs,
    );
  });

  /** The library's strips, only once the tabs show (Fila, Ouvidas). */
  protected readonly home = httpResource(
    () => (this.tabbed() ? libraryHomeUrlOf(null) : undefined),
    { parse: (body) => libraryHomeSchema.parse(body) },
  );
  private readonly others = <T extends { readonly id: string }>(
    list: readonly T[],
  ): readonly T[] => list.filter((one) => one.id !== this.source()?.id);
  protected readonly upNext = computed(() =>
    this.home.hasValue()
      ? this.others(this.home.value().continueListening)
      : [],
  );
  protected readonly recent = computed(() =>
    this.home.hasValue() ? this.home.value().recentlyPlayed : [],
  );

  protected playItemLabel(title: string): string {
    return $localize`:@@nowPlaying.playItem:Tocar ${title}:title:`;
  }

  /** Compartilhar: the player page's link at the second heard now (KBC-041 FR-5). */
  protected share(): void {
    const playing = this.source();
    const clipboard = this.document.defaultView?.navigator.clipboard;
    const failed = $localize`:@@player.minuteLinkFailed:Não consegui copiar o link.`;
    if (!playing || !clipboard) {
      this.announcer.say(failed);
      return;
    }
    const page = this.document.location.origin + mediaPagePath(playing.id);
    const link = minuteLink(page, this.engine.playback().currentMs);
    void clipboard.writeText(link).then(
      () =>
        this.announcer.say(
          $localize`:@@player.minuteLinkCopied:Link deste minuto copiado.`,
        ),
      () => this.announcer.say(failed),
    );
  }
}
