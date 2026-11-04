import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  linkedSignal,
  output,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { LibraryItem, LibraryTrack } from '@kb-chat/contracts';
import { formatDuration } from '@kb-chat/player-core';
import { AuthorshipBadge } from '@features/authorship/authorship-badge.js';
import { resumeTextOf, stateTextOf } from './library-labels.js';

/**
 * A recording's tracks in the library (KBC-068 FR-5): "12 faixas" opens them under it. The full
 * recording is the row above: each track here is an item of its own.
 */
@Component({
  selector: 'app-track-group',
  imports: [RouterLink, AuthorshipBadge],
  templateUrl: './track-group.html',
  styleUrl: './track-group.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrackGroup {
  readonly item = input.required<LibraryItem>();
  /** A search is on: the track it found must show. */
  readonly openByDefault = input(false);
  readonly playingId = input<string | null>(null);
  readonly played = output<LibraryTrack>();

  protected readonly open = linkedSignal(() => this.openByDefault());
  protected readonly label = computed(() => {
    const count = this.item().tracks.length;
    return count === 1
      ? $localize`:@@library.tracksOne:1 faixa`
      : $localize`:@@library.tracks:${count}:count: faixas`;
  });
  protected readonly listName = computed(
    () => $localize`:@@library.tracksOf:Faixas de ${this.item().title}:title:`,
  );
  protected readonly listId = computed(() => `tracks-${this.item().id}`);

  protected durationOf(track: LibraryTrack): string {
    return track.durationMs === null ? '' : formatDuration(track.durationMs);
  }

  protected resumeOf(track: LibraryTrack): string {
    return resumeTextOf(track);
  }

  protected stateOf(track: LibraryTrack): string {
    return stateTextOf(track);
  }

  protected playLabel(track: LibraryTrack): string {
    return this.playingId() === track.id
      ? $localize`:@@library.pauseTrack:Pausar ${track.title}:title:`
      : $localize`:@@library.playTrack:Ouvir ${track.title}:title:`;
  }

  protected showsAuthor(track: LibraryTrack): boolean {
    return track.author?.slug !== this.item().author?.slug;
  }
}
