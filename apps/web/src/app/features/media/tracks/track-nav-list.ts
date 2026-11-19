import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import type { ApprovedTrack } from '@kb-chat/contracts';
import { formatClock, formatDuration } from '@kb-chat/player-core';
import { TracksStore } from '@core/media/tracks-store.js';
import { MediaLevelBadge } from '../media-level-badge.js';

/** "Faixas" beside the transcript (KBC-066 FR-9), for `media-tracks`. */
@Component({
  selector: 'app-track-nav-list',
  imports: [MediaLevelBadge],
  template: `
    @if (rows().length) {
      <section aria-labelledby="track-nav-title">
        <h3 id="track-nav-title" class="title">{{ heading() }}</h3>
        <ol class="rows">
          @for (row of rows(); track row.track.id) {
            <li>
              <button
                type="button"
                class="row"
                [attr.aria-current]="row.current ? 'true' : null"
                (click)="go(row.track)"
              >
                <span class="number">{{ row.track.ordinal }}</span>
                <span class="name">{{ row.track.title }}</span>
                <span class="time">{{ row.at }} · {{ row.length }}</span>
                @if (row.track.level !== undefined) {
                  <app-media-level-badge
                    class="level"
                    [level]="row.track.level"
                    [shown]="true"
                  />
                }
                @if (row.current) {
                  <span class="visually-hidden" i18n="@@tracks.nav.playing"
                    >tocando agora</span
                  >
                }
              </button>
            </li>
          }
        </ol>
      </section>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .title {
      margin: 0 0 var(--space-2);
      font-family: var(--font-ui);
      font-size: var(--text-item);
      font-weight: 700;
    }
    .rows {
      display: grid;
      gap: var(--space-1);
      max-height: 20rem;
      margin: 0;
      padding: 0;
      overflow-y: auto;
      list-style: none;
    }
    .row {
      display: grid;
      grid-template-columns: 2rem minmax(0, 1fr) auto;
      gap: var(--space-2);
      align-items: baseline;
      width: 100%;
      min-height: 44px;
      padding: var(--space-2);
      border: 0;
      border-radius: var(--radius-menu);
      background: none;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .row:hover {
      background: var(--overlay-2);
    }
    .level {
      grid-column: 2 / -1;
    }
    /* The track playing in the accent, besides "tocando agora" read aloud (UP-20). */
    .row[aria-current] {
      color: var(--color-accent-text);
      font-weight: 700;
    }
    .number,
    .time {
      color: var(--color-text-muted);
      font-size: var(--text-sm);
      font-variant-numeric: tabular-nums;
    }
    /* "Faixas desta gravação" in "Sobre" (pRight): one line each, number 13, title 14,
       the time 12, the one playing in the accent. */
    :host-context(app-player-about) .title {
      margin-bottom: var(--space-1);
    }
    :host-context(app-player-about) .rows {
      gap: 0;
    }
    :host-context(app-player-about) .row {
      grid-template-columns: 0.875rem minmax(0, 1fr) auto;
      gap: 0.625rem;
      align-items: center;
      min-height: 2rem;
      padding: 0 var(--space-1);
      margin: 0 calc(-1 * var(--space-1));
      width: calc(100% + 2 * var(--space-1));
    }
    :host-context(app-player-about) .name {
      overflow: hidden;
      font-size: var(--text-sm);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    :host-context(app-player-about) .row[aria-current] {
      font-weight: 400;
    }
    :host-context(app-player-about) .row[aria-current] .number {
      color: var(--color-accent-text);
    }
    :host-context(app-player-about) .number {
      font-size: var(--text-meta);
    }
    :host-context(app-player-about) .time {
      font-size: var(--text-xs);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrackNavList {
  /** The list's title: "Faixas" as the body's view, "Faixas desta gravação" in "Sobre". */
  readonly heading = input($localize`:@@tracks.nav.title:Faixas`);
  private readonly store = inject(TracksStore);

  protected readonly rows = computed(() => {
    const currentId = this.store.current()?.id;
    return this.store.tracks().map((track) => ({
      track,
      current: track.id === currentId,
      at: formatClock(track.startMs),
      length: formatDuration(track.endMs - track.startMs),
    }));
  });

  protected go(track: ApprovedTrack): void {
    this.store.go(track);
  }
}
