import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  mediaItemSchema,
  mediaListSchema,
  mediaTranscriptSchema,
  type TranscriptSegment,
} from '@kb-chat/contracts';
import { MediaEngine } from '@core/media/media-engine.js';
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
  coverGradient,
} from '@ui/index.js';
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

/**
 * "Tocando agora" (KBC-129 FR-2, v2 · Mídia — Player): what plays, in the shell's right
 * panel beside any screen. The cover, the title and author, the transcript card with the
 * line before and the line heard now, and "Sobre a autora". Only data that exists (BR-4):
 * no "Seguir" (KBC-135) and no share (KBC-136). Opened by the player bar's transcript
 * button (MiniPlayer) through `RightPanel.open`; its own close button takes it away.
 */
@Component({
  selector: 'app-now-playing-panel',
  imports: [MenuButton, RouterLink, UiAvatar, UiCover, UiIcon, UiIconButton],
  template: `
    <section class="now" aria-labelledby="now-playing-title">
      <!-- v2 · Tocando agora: the collection's name, ⋯ and ⤢ (the player page). -->
      <div class="bar">
        <h2 id="now-playing-title" class="visually-hidden" i18n="@@nowPlaying.title">
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
    </section>
  `,
  styleUrl: './now-playing-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NowPlayingPanel {
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
}
