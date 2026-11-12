import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
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
        <h3 id="track-nav-title" class="title" i18n="@@tracks.nav.title">
          Faixas
        </h3>
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
      font-family: var(--font-reading);
      font-size: var(--text-lg);
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
      border: 1px solid transparent;
      border-radius: var(--radius-md);
      background: none;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .row:hover {
      background: var(--color-surface-muted);
    }
    .level {
      grid-column: 2 / -1;
    }
    .row[aria-current] {
      border-color: var(--color-accent);
      font-weight: 600;
    }
    .number,
    .time {
      color: var(--color-text-muted);
      font-size: var(--text-sm);
      font-variant-numeric: tabular-nums;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrackNavList {
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
