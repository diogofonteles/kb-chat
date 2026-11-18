import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
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
import { UiCover, UiIcon, UiIconButton } from '@ui/index.js';

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
  imports: [RouterLink, UiCover, UiIcon, UiIconButton],
  template: `
    <section
      class="now"
      [attr.aria-labelledby]="embedded() ? null : 'now-playing-title'"
    >
      @if (!embedded()) {
        <div class="bar">
          <h2 id="now-playing-title" class="label" i18n="@@nowPlaying.title">
            Tocando agora
          </h2>
          <button
            uiIconButton
            type="button"
            aria-label="Fechar Tocando agora"
            i18n-aria-label="@@nowPlaying.close"
            (click)="panel.close()"
          >
            <ui-icon name="close" [size]="18" />
          </button>
        </div>
      }
      @if (source(); as playing) {
        <ui-cover class="art" [title]="playing.title" [size]="308" />
        <div class="head">
          <div class="names">
            <a class="title" [routerLink]="pagePath()">{{ playing.title }}</a>
            <p class="author">{{ authorName() }}</p>
          </div>
          <a
            class="open"
            [routerLink]="pagePath()"
            aria-label="Abrir o player"
            i18n-aria-label="@@nowPlaying.open"
          >
            <ui-icon name="expand" [size]="18" />
          </a>
        </div>
        @if (lines(); as shown) {
          <div class="card">
            <p class="card-title" i18n="@@nowPlaying.transcript">Transcrição</p>
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
              <ui-cover [title]="person.name" [size]="48" />
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
  /** In the player panel's Sobre tab: the tabs name it and hold the ✕. */
  readonly embedded = input(false);
  private readonly engine = inject(MediaEngine);
  protected readonly panel = inject(RightPanel);
  protected readonly source = this.engine.source;
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
    return count === 1
      ? $localize`:@@nowPlaying.oneAudio:1 áudio neste acervo`
      : $localize`:@@nowPlaying.audios:${count}:count: áudios neste acervo`;
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
